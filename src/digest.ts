import fs from "node:fs/promises";
import path from "node:path";
import { generateDigest, DIGEST_TOP_N } from "./digest-core.js";
import { sendEmail } from "./email.js"; // vérifie aussi RESEND_API_KEY/EMAIL_TO à l'import
import type { Article } from "./types.js";

if (!process.env.MISTRAL_API_KEY && !process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
  throw new Error("Au moins une clé API LLM doit être configurée (MISTRAL_API_KEY, GROQ_API_KEY ou GEMINI_API_KEY)");
}

// Fenêtre du digest : 2 jours (cadence quotidienne, mais on garde une marge
// au cas où une collecte précédente a raté). La déduplication par URL
// déjà-envoyée garantit qu'aucun article ne sera envoyé deux fois.
const DIGEST_WINDOW_DAYS = 2;

// Fichier de tracking des articles déjà envoyés (URL → date d'envoi).
// Purgé après 60 jours pour éviter qu'il grossisse indéfiniment.
const SENT_TRACKER_PATH = path.resolve("data/sent.json");
const SENT_RETENTION_DAYS = 60;

type SentTracker = Record<string, string>; // url → "YYYY-MM-DD"

async function loadSentTracker(): Promise<SentTracker> {
  try {
    const raw = await fs.readFile(SENT_TRACKER_PATH, "utf-8");
    return JSON.parse(raw) as SentTracker;
  } catch {
    return {};
  }
}

async function saveSentTracker(tracker: SentTracker): Promise<void> {
  const cutoff = Date.now() - SENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const pruned: SentTracker = {};
  for (const [url, date] of Object.entries(tracker)) {
    if (new Date(date).getTime() >= cutoff) pruned[url] = date;
  }
  await fs.mkdir(path.dirname(SENT_TRACKER_PATH), { recursive: true });
  await fs.writeFile(SENT_TRACKER_PATH, JSON.stringify(pruned, null, 2), "utf-8");
}

// Charge les articles des derniers jours selon la fenêtre du digest
async function loadRecentArticles(): Promise<Article[]> {
  const dir = path.resolve("data/articles");
  const files = await fs.readdir(dir).catch(() => []);
  const cutoff = Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const all: Article[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const dateStr = file.replace(".json", "");
    if (new Date(dateStr).getTime() < cutoff) continue;
    const content = await fs.readFile(path.join(dir, file), "utf-8");
    const data = JSON.parse(content) as { articles: Article[] };
    all.push(...data.articles);
  }
  return all;
}

async function main() {
  console.log("Génération du digest...");
  const allArticles = await loadRecentArticles();
  console.log(`${allArticles.length} articles sur les ${DIGEST_WINDOW_DAYS} derniers jours`);

  // Zéro article sur toute la fenêtre = la collecte est en panne (timeout,
  // quota, etc.). On échoue franchement pour que notify-failure ouvre une
  // issue, au lieu de terminer en "success" silencieux comme du 8 au 10 juin.
  if (allArticles.length === 0) {
    console.error(
      `Aucun article collecté sur les ${DIGEST_WINDOW_DAYS} derniers jours : la collecte quotidienne est probablement en panne. Vérifier le workflow Daily News Collection.`
    );
    process.exit(1);
  }

  // Déduplication : on retire les articles dont l'URL a déjà été envoyée.
  const sentTracker = await loadSentTracker();
  const articles = allArticles.filter((a) => a.link && !sentTracker[a.link]);
  const skipped = allArticles.length - articles.length;
  if (skipped > 0) console.log(`${skipped} article(s) déjà envoyé(s) précédemment, ignorés`);

  // Si tout a déjà été envoyé, pas d'email — on évite le spam quotidien vide.
  if (articles.length === 0) {
    console.log("Aucun article nouveau depuis le dernier digest. Pas d'email envoyé.");
    return;
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const { markdown: digest, degraded, included } = await generateDigest(articles, {
    startDate,
    endDate,
  });
  const leftOver = articles.length - included.length;
  if (leftOver > 0) {
    console.log(
      `${leftOver} article(s) hors du top ${DIGEST_TOP_N} : non envoyés, donc laissés hors du tracker pour rester éligibles demain`
    );
  }

  // Sauvegarde Markdown
  const outDir = path.resolve("data/digests");
  await fs.mkdir(outDir, { recursive: true });
  const fileName = degraded ? `${endDate}-degraded.md` : `${endDate}.md`;
  const filePath = path.join(outDir, fileName);
  await fs.writeFile(filePath, digest, "utf-8");
  console.log(`Digest sauvegardé : ${filePath}`);

  // Envoi email — TOUJOURS, même en mode dégradé. sendEmail retente 3 fois
  // puis lève : le catch de main() fait exit 1 → notify-failure ouvre une issue.
  const subjectPrefix = degraded ? "⚠️ Digest dégradé" : "📰 Digest";
  const emailId = await sendEmail({
    subject: `${subjectPrefix} — ${endDate}`,
    markdown: digest,
    footerNote: "Digest quotidien",
  });
  console.log(`Email envoyé${degraded ? " (mode dégradé)" : ""}:`, emailId);

  // Marquer comme envoyés UNIQUEMENT les articles réellement présents dans le
  // digest, et seulement après un envoi email réussi (pour pouvoir réessayer
  // demain si l'email a échoué). Marquer TOUS les candidats brûlait chaque jour
  // les articles au-delà du top 30 sans qu'ils aient jamais été lus — invisible
  // en régime normal (le filtre de score laisse ~25 articles), mais massif en
  // mode dégradé, où les 165 articles bruts du jour passaient à la trappe.
  for (const a of included) {
    if (a.link) sentTracker[a.link] = endDate;
  }
  await saveSentTracker(sentTracker);
  console.log(`Tracker mis à jour : ${Object.keys(sentTracker).length} URLs en mémoire`);
}

main()
  .then(() => {
    // Sortie explicite, même logique que collect.ts : ne pas laisser des
    // handles réseau résiduels suspendre le process jusqu'au timeout.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
