import { Resend } from "resend";
import fs from "node:fs/promises";
import path from "node:path";
import { callLLM } from "./llm.js";

type Article = {
  title: string;
  link: string;
  source: string;
  category: string;
  pubDate: string;
  contentSnippet?: string;
  score?: number;
  reason?: string;
  summary?: string;
};

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "onboarding@resend.dev";

if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");
if (!EMAIL_TO) throw new Error("Missing EMAIL_TO");
if (!process.env.MISTRAL_API_KEY && !process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
  throw new Error("Au moins une clé API LLM doit être configurée (MISTRAL_API_KEY, GROQ_API_KEY ou GEMINI_API_KEY)");
}

const resend = new Resend(RESEND_API_KEY);

// Fenêtre du digest : 2 jours (cadence quotidienne, mais on garde une marge
// au cas où une collecte précédente a raté). La déduplication par URL
// déjà-envoyée garantit qu'aucun article ne sera envoyé deux fois.
const DIGEST_WINDOW_DAYS = 2;
const DIGEST_TOP_N = 30;

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

// Fallback : si tous les LLM échouent, on assemble manuellement un digest
// regroupé par catégorie/source pour que l'utilisateur reçoive QUELQUE CHOSE.
function buildFallbackDigest(articles: Article[], startDate: string, endDate: string): string {
  const header = `# Digest — du ${startDate} au ${endDate} (mode dégradé)\n\n> ⚠️ Le scoring/résumé IA était indisponible cette fois (tous les providers ont échoué). Voici les articles bruts collectés sur la période, regroupés par catégorie. À parcourir manuellement.\n`;

  if (articles.length === 0) return `${header}\n\nAucun article collecté sur la période.`;

  const byCategory = new Map<string, Article[]>();
  for (const a of articles) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }

  const categoryEmoji: Record<string, string> = {
    ia: "🚀 IA",
    tech: "🛠️ Tech",
    geopolitique: "🌍 Géopolitique",
  };

  const sections: string[] = [];
  for (const [cat, list] of byCategory) {
    const title = categoryEmoji[cat] ?? cat;
    const items = list
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((a) => {
        const scoreTag = typeof a.score === "number" ? ` _(score ${a.score})_` : "";
        const summary = a.summary || a.contentSnippet || "";
        const summaryLine = summary ? `\n  ${summary.slice(0, 400)}` : "";
        return `- **${a.title}** — ${a.source}${scoreTag}${summaryLine}\n  [Lien](${a.link})`;
      })
      .join("\n\n");
    sections.push(`## ${title}\n\n${items}`);
  }

  return `${header}\n\n${sections.join("\n\n")}`;
}

async function generateDigest(articles: Article[]): Promise<{ markdown: string; degraded: boolean }> {
  const today = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  if (articles.length === 0) {
    return { markdown: "# Digest\n\nAucun article notable sur la période.", degraded: false };
  }

  // Tri par score décroissant, top N max pour rester dans les limites de tokens
  const top = articles
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, DIGEST_TOP_N);

  const articlesText = top
    .map(
      (a) =>
        `- [${a.category}] **${a.title}** (${a.source}, score ${a.score})\n  Résumé : ${a.summary}\n  Lien : ${a.link}`
    )
    .join("\n\n");

  const prompt = `Tu es un journaliste de veille spécialisé en tech/IA. Tu rédiges pour un lecteur qui veut être parmi les premiers à exploiter les sauts technologiques.

Voici les articles importants de la période (triés par pertinence, déjà résumés) :

${articlesText}

============================================
RÈGLES STRICTES — TU DOIS LES RESPECTER :
============================================

1. **N'INVENTE RIEN.** Tu ne dois utiliser QUE les informations présentes dans les résumés ci-dessus. Pas de chiffres, dates, montants, statistiques, noms d'entreprise, URLs ou faits qui ne sont pas explicitement cités dans un article. En cas de doute, **omets**.

2. **URLS** : N'utilise QUE les URLs présentes dans le champ "Lien" des articles ci-dessus. Tu ne dois jamais générer une URL toi-même. Si tu cites un projet/outil dont l'URL n'est pas dans les sources, ne mets pas de lien — mentionne juste le nom.

3. **Pas de remplissage** : si tu manques de matière pour étoffer une section, fais-la plus courte. Mieux vaut bref et exact que long et inventé. Pas de phrases creuses type "les investisseurs pourraient être tentés", "leviers de contrôle", "comprendre les forces du marché".

4. **Pas de copier-coller** entre sections. Chaque paragraphe doit être unique. Si tu te retrouves à répéter une formule, supprime-la.

5. **Pas de sous-section décorative** ("Ce que ça permet de faire", "Comment l'exploiter dès maintenant", "Retour d'expérience à surveiller"). Écris des paragraphes denses, factuels.

6. **Articles 10/10 obligatoires** : tout article noté 10/10 dans la liste ci-dessus DOIT être mentionné dans le digest (en intro, dans une section thématique, ou dans les 3 actions). Aucune omission tolérée pour les articles 10/10.

============================================
STRUCTURE À PRODUIRE :
============================================

# Digest — du [date début] au [date fin]

**Introduction** (3-4 phrases) : grandes tendances de la période, factuelles, basées strictement sur les articles ci-dessus.

## 🚀 Avancées IA & opportunités à saisir (≈ 50%)
Pour chaque sujet IA pertinent (nouveaux modèles, papers, outils testables, signaux d'adoption en entreprise), un paragraphe dense de 4-7 phrases. Termine chaque paragraphe par les liens Markdown vers les sources (uniquement celles présentes dans les articles ci-dessus).

## 🛠️ Tech & industrie (≈ 25%)
Mouvements de marché, levées, deals, lancements produits, réglementation tech. Paragraphes courts, factuels.

## 🌍 Contexte mondial (≈ 25%)
Géopolitique, conflits, élections, crises majeures. **Couvre tous les sujets ≥ 8/10 sans en omettre.** Une sous-section par grand théâtre (Moyen-Orient, Europe/Ukraine, USA, Asie...). Ne mélange pas les théâtres.

## 🎯 3 actions concrètes à prendre cette semaine
Trois actions précises et faisables tirées strictement des articles ci-dessus. Format pour chacune : 2-3 phrases qui expliquent quoi faire, et le ou les liens Markdown vers les sources qui justifient l'action. Pas de "à surveiller" vague.

Date d'aujourd'hui : ${today}.`;

  try {
    const { text, provider } = await callLLM({ prompt, temperature: 0.2 });
    console.log(`Digest généré via ${provider}`);
    return { markdown: text, degraded: false };
  } catch (err) {
    console.error("Tous les LLM ont échoué pour le digest :", (err as Error).message);
    console.warn("Passage en mode dégradé : envoi des articles bruts.");
    return { markdown: buildFallbackDigest(top, startDate, today), degraded: true };
  }
}

function markdownToHtml(md: string): string {
  // Conversion minimaliste — Resend rend très bien le HTML simple
  return md
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(.+)$/, "<p>$1</p>");
}

async function main() {
  console.log("Génération du digest...");
  const allArticles = await loadRecentArticles();
  console.log(`${allArticles.length} articles sur les ${DIGEST_WINDOW_DAYS} derniers jours`);

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

  const { markdown: digest, degraded } = await generateDigest(articles);

  // Sauvegarde Markdown
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve("data/digests");
  await fs.mkdir(outDir, { recursive: true });
  const fileName = degraded ? `${today}-degraded.md` : `${today}.md`;
  const filePath = path.join(outDir, fileName);
  await fs.writeFile(filePath, digest, "utf-8");
  console.log(`Digest sauvegardé : ${filePath}`);

  // Envoi email — TOUJOURS, même en mode dégradé
  const html = markdownToHtml(digest);
  const subjectPrefix = degraded ? "⚠️ Digest dégradé" : "📰 Digest";
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM!,
    to: EMAIL_TO!,
    subject: `${subjectPrefix} — ${today}`,
    html,
    text: digest,
  });

  if (error) {
    console.error("Erreur envoi email:", error);
    process.exit(1);
  }
  console.log(`Email envoyé${degraded ? " (mode dégradé)" : ""}:`, data?.id);

  // Marquer les articles comme envoyés UNIQUEMENT après envoi email réussi,
  // pour pouvoir réessayer demain si l'email a échoué.
  for (const a of articles) {
    if (a.link) sentTracker[a.link] = today;
  }
  await saveSentTracker(sentTracker);
  console.log(`Tracker mis à jour : ${Object.keys(sentTracker).length} URLs en mémoire`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
