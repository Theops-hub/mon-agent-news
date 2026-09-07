import Parser from "rss-parser";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs/promises";
import path from "node:path";
import sourcesConfig from "../config/sources.json" with { type: "json" };
import { scoreInBatches } from "./digest-core.js";
import { mapPerHostSerial } from "./host-queue.js";
import type { Source, Article } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; mon-agent-news/1.0; +https://github.com/) news-aggregator-bot";
const FETCH_TIMEOUT_MS = 12000;
const MAX_CONTENT_CHARS = 4000;
const FETCH_CONCURRENCY = 5;
// Rétention des fichiers d'articles, alignée sur celle de sent.json (60 j) :
// au-delà, ils ne servent plus ni au digest (fenêtre 2 j) ni à la déduplication.
const ARTICLES_RETENTION_DAYS = 60;

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
    try {
      const reader = new Readability(dom.window.document);
      const parsed = reader.parse();
      const text = (parsed?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length < 200) return null; // probablement une page vide / paywall / JS-only
      return text.slice(0, MAX_CONTENT_CHARS);
    } finally {
      // Libère les timers/ressources internes de jsdom, qui sinon maintiennent
      // l'event loop en vie longtemps après la fin de la collecte.
      dom.window.close();
    }
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
    // Sans date de publication fiable, impossible de garantir la fraîcheur :
    // on écarte (des items sans date faisaient remonter de vieux articles).
    // isoDate est le fallback pour les flux Atom qui n'exposent pas pubDate.
    const items = feed.items || [];
    const itemDate = (item: (typeof items)[number]): string => item.pubDate || item.isoDate || "";
    const dated = items.filter((item) => {
      const ts = new Date(itemDate(item)).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });
    const undatedCount = items.filter((i) => !itemDate(i)).length;
    if (undatedCount > 0) {
      console.warn(`${source.name}: ${undatedCount} item(s) sans date de publication écartés`);
    }
    return dated
      .map((item) => ({
        title: item.title || "(sans titre)",
        link: item.link || "",
        source: source.name,
        category: source.category,
        pubDate: itemDate(item),
        contentSnippet: (item.contentSnippet || item.content || "").slice(0, 500),
      }));
  } catch (err) {
    console.warn(`Erreur sur ${source.name}: ${(err as Error).message}`);
    return [];
  }
}

// Supprime les fichiers d'articles plus vieux que la rétention, pour que le
// repo ne grossisse pas indéfiniment (~1000 lignes JSON par jour sinon).
// Le `git add data/articles/` du workflow stage aussi les suppressions.
async function pruneOldArticles(dir: string): Promise<void> {
  const cutoff = Date.now() - ARTICLES_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (const file of files) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
    if (new Date(file.slice(0, 10)).getTime() < cutoff) {
      await fs.unlink(path.join(dir, file));
      console.log(`Purgé (> ${ARTICLES_RETENTION_DAYS} j) : data/articles/${file}`);
    }
  }
}

async function main() {
  console.log(`Collecte du ${new Date().toISOString()}`);

  // 1. Récupération RSS : en parallèle entre domaines, sérialisée à l'intérieur
  // d'un même domaine (plusieurs flux Reddit d'affilée se font sinon 429).
  const allArticles = (
    await mapPerHostSerial(sourcesConfig.sources as Source[], fetchRecentArticles)
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

  // 4. Scoring par batch (logique partagée avec le rattrapage, cf. digest-core.ts)
  const scored = await scoreInBatches(enriched);

  // 5. Filtrage par score minimum. Un article SANS score n'a pas été jugé non
  // pertinent : son batch a échoué. On le garde — l'absence de note n'est pas
  // une mauvaise note. Auparavant `a.score ?? 0` les écrasait à zéro, et une
  // panne LLM partielle jetait silencieusement des dizaines d'articles.
  const unscoredCount = scored.filter((a) => typeof a.score !== "number").length;
  const kept = scored.filter(
    (a) => typeof a.score !== "number" || a.score >= sourcesConfig.minScore
  );
  const allUnscored = unscoredCount === scored.length;

  if (allUnscored) {
    console.warn(`Scoring LLM totalement indisponible — sauvegarde des ${scored.length} articles bruts pour fallback digest`);
  } else {
    console.log(`${kept.length}/${scored.length} articles retenus (score ≥ ${sourcesConfig.minScore})`);
    if (unscoredCount > 0) {
      console.warn(`${unscoredCount} article(s) non noté(s) (batch de scoring en échec) — conservés sans score plutôt que jetés`);
    }
  }

  // 6. Sauvegarde
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve("data/articles");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, `${today}.json`),
    JSON.stringify({ date: today, articles: kept, unscored: allUnscored }, null, 2),
    "utf-8"
  );
  console.log(`Sauvegardé : data/articles/${today}.json`);

  // 7. Purge des fichiers trop anciens
  await pruneOldArticles(outDir);
}

main()
  .then(() => {
    // Sortie explicite : des handles réseau/jsdom résiduels suspendaient le
    // process plusieurs minutes après la sauvegarde (jusqu'au timeout du
    // workflow les 8-10 juin 2026, perdant les articles avant le commit).
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
