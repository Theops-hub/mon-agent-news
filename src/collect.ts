import Parser from "rss-parser";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs/promises";
import path from "node:path";
import sourcesConfig from "../config/sources.json" with { type: "json" };
import { callLLM } from "./llm.js";
import type { Source, Article } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; mon-agent-news/1.0; +https://github.com/) news-aggregator-bot";
const FETCH_TIMEOUT_MS = 12000;
const MAX_CONTENT_CHARS = 4000;
const FETCH_CONCURRENCY = 5;

// Au moins un provider LLM doit être configuré ; le module llm.ts gère le fallback.
if (!process.env.MISTRAL_API_KEY && !process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
  console.error("Au moins une clé API LLM doit être configurée (MISTRAL_API_KEY, GROQ_API_KEY ou GEMINI_API_KEY)");
  process.exit(1);
}

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": USER_AGENT },
});

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// VirtualConsole muet : étouffe les "Could not parse CSS stylesheet" inoffensifs de jsdom
const silentConsole = new VirtualConsole();

// Récupère le contenu principal d'un article via Readability (le moteur de Firefox Reader View)
async function fetchArticleContent(url: string): Promise<string | null> {
  if (!url) return null;
  try {
    const html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    const dom = new JSDOM(html, { url, virtualConsole: silentConsole });
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();
    const text = (parsed?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 200) return null; // probablement une page vide / paywall / JS-only
    return text.slice(0, MAX_CONTENT_CHARS);
  } catch (err) {
    console.warn(`Fetch contenu KO (${url}): ${(err as Error).message}`);
    return null;
  }
}

// Limite la concurrence des fetch pour éviter de flooder les serveurs
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Récupère les articles publiés dans les dernières 24h
async function fetchRecentArticles(source: Source): Promise<Article[]> {
  try {
    const feed = await parser.parseURL(source.url);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return (feed.items || [])
      .filter((item) => {
        if (!item.pubDate) return true; // certains flux n'ont pas de date — on garde
        return new Date(item.pubDate).getTime() >= cutoff;
      })
      .map((item) => ({
        title: item.title || "(sans titre)",
        link: item.link || "",
        source: source.name,
        category: source.category,
        pubDate: item.pubDate || new Date().toISOString(),
        contentSnippet: (item.contentSnippet || item.content || "").slice(0, 500),
      }));
  } catch (err) {
    console.warn(`Erreur sur ${source.name}: ${(err as Error).message}`);
    return [];
  }
}

// Demande à Gemini de noter et résumer chaque article (par batch pour économiser des appels)
async function scoreAndSummarize(articles: Article[]): Promise<Article[]> {
  if (articles.length === 0) return [];

  const interests = sourcesConfig.interests.map((i) => `- ${i}`).join("\n");
  const articlesText = articles
    .map((a, i) => {
      const body = a.fullContent || a.contentSnippet || "";
      const label = a.fullContent ? "Contenu" : "Extrait (contenu complet indisponible)";
      return `[${i}] Source: ${a.source} | Catégorie: ${a.category}\nTitre: ${a.title}\n${label} : ${body}`;
    })
    .join("\n\n---\n\n");

  const prompt = `Tu es un assistant de veille. Voici mes centres d'intérêt :
${interests}

Voici ${articles.length} articles avec leur contenu (souvent complet). Pour CHACUN, donne :
- "score" : pertinence pour mes intérêts de 1 à 10
- "reason" : 1 phrase expliquant la note
- "summary" : résumé en 3-5 phrases en français basé sur le contenu fourni (même si l'article est en anglais). Couvre les faits clés, pas seulement le titre.

Réponds UNIQUEMENT en JSON valide, sous cette forme exacte :
{"results": [{"index": 0, "score": 8, "reason": "...", "summary": "..."}, ...]}

Articles :
${articlesText}`;

  try {
    const { text, provider } = await callLLM({ prompt, jsonMode: true });
    console.log(`Scoring batch via ${provider}`);
    // Extrait le JSON même si entouré de ```json ... ```
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]) as {
      results: { index: number; score: number; reason: string; summary: string }[];
    };

    return articles.map((a, i) => {
      const r = parsed.results.find((x) => x.index === i);
      return r ? { ...a, score: r.score, reason: r.reason, summary: r.summary } : a;
    });
  } catch (err) {
    console.error("Scoring LLM échoué pour ce batch:", (err as Error).message);
    return articles;
  }
}

// Découpe un tableau en chunks de taille n
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log(`Collecte du ${new Date().toISOString()}`);

  // 1. Récupération RSS (en parallèle)
  const allArticles = (
    await Promise.all((sourcesConfig.sources as Source[]).map(fetchRecentArticles))
  ).flat();
  console.log(`${allArticles.length} articles récupérés`);

  if (allArticles.length === 0) {
    console.log("Aucun article aujourd'hui, sortie.");
    return;
  }

  // 2. Déduplication par titre+source
  const seen = new Set<string>();
  const unique = allArticles.filter((a) => {
    const key = `${a.source}|${a.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 3. Récupération du contenu complet (concurrence limitée pour ne pas flooder)
  console.log(`Fetch du contenu complet (${unique.length} articles)...`);
  const contents = await withConcurrency(unique, FETCH_CONCURRENCY, (a) =>
    fetchArticleContent(a.link)
  );
  const enriched: Article[] = unique.map((a, i) => ({
    ...a,
    fullContent: contents[i] ?? undefined,
  }));
  const fetchedCount = enriched.filter((a) => a.fullContent).length;
  console.log(`Contenu complet récupéré pour ${fetchedCount}/${enriched.length} articles`);

  // 4. Scoring par batch (taille réduite car le contenu complet est plus volumineux)
  const batches = chunk(enriched, 6);
  const scored: Article[] = [];
  for (let b = 0; b < batches.length; b++) {
    const result = await scoreAndSummarize(batches[b]);
    scored.push(...result);
    // petite pause entre les batches pour être gentil avec l'API (pas après le dernier)
    if (b < batches.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  // 5. Filtrage par score minimum — sauf si tous les LLM ont échoué : on garde tout
  // pour que le digest puisse au moins envoyer les articles bruts en mode dégradé.
  const anyScored = scored.some((a) => typeof a.score === "number");
  const kept = anyScored
    ? scored.filter((a) => (a.score ?? 0) >= sourcesConfig.minScore)
    : scored;
  if (anyScored) {
    console.log(`${kept.length}/${scored.length} articles retenus (score ≥ ${sourcesConfig.minScore})`);
  } else {
    console.warn(`Scoring LLM totalement indisponible — sauvegarde des ${scored.length} articles bruts pour fallback digest`);
  }

  // 6. Sauvegarde
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve("data/articles");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, `${today}.json`),
    JSON.stringify({ date: today, articles: kept, unscored: !anyScored }, null, 2),
    "utf-8"
  );
  console.log(`Sauvegardé : data/articles/${today}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
