import { Mistral } from "@mistralai/mistralai";
import { Resend } from "resend";
import fs from "node:fs/promises";
import path from "node:path";

type Article = {
  title: string;
  link: string;
  source: string;
  category: string;
  pubDate: string;
  score?: number;
  reason?: string;
  summary?: string;
};

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "onboarding@resend.dev";

if (!MISTRAL_API_KEY) throw new Error("Missing MISTRAL_API_KEY");
if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");
if (!EMAIL_TO) throw new Error("Missing EMAIL_TO");

const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });
const MISTRAL_MODEL = "mistral-small-latest";
const resend = new Resend(RESEND_API_KEY);

// Fenêtre du digest : 4 jours (cadence 2x/semaine, mercredi + dimanche)
const DIGEST_WINDOW_DAYS = 4;
const DIGEST_TOP_N = 50;

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

async function generateDigest(articles: Article[]): Promise<string> {
  if (articles.length === 0) {
    return "# Digest\n\nAucun article notable sur la période.";
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

  const prompt = `Tu es un journaliste de veille spécialisé en tech/IA, qui rédige pour un lecteur qui veut être parmi les premiers à exploiter les sauts technologiques. Voici les articles importants de la période, triés par pertinence et résumés :

${articlesText}

Rédige un compte-rendu en français, au format Markdown, avec la structure suivante :

1. **Titre** : "# Digest — du [date début] au [date fin]"

2. **Introduction (3-4 phrases)** : grandes tendances de la période, en mettant l'accent sur ce qui change concrètement dans le paysage tech/IA.

3. **🚀 Avancées IA & opportunités à saisir (≈ 50% du digest)** — section principale. Couvre :
   - Nouveaux modèles, papers majeurs, breakthroughs
   - Outils/plateformes/SDK qu'on peut tester ou adopter dès maintenant (early access, betas, open source nouveau)
   - Signaux d'adoption en entreprise (déploiements concrets, retours d'XP)
   Pour chaque sujet, sois explicite : qu'est-ce que ça permet de faire que je ne pouvais pas faire avant ? Liens en Markdown.

4. **🛠️ Tech & industrie (≈ 25% du digest)** : mouvements de marché, levées, deals, lancements produits, réglementation tech qui impacte l'adoption.

5. **🌍 Contexte mondial (≈ 25% du digest)** : géopolitique, conflits, élections, crises majeures. **Ne pas sacrifier la couverture ici** — couvre tous les sujets géopolitiques majeurs (≥ 8/10) sans en omettre. Synthétise par théâtre/région.

6. **🎯 3 actions concrètes à prendre cette semaine** : à partir des articles, propose 3 actions précises et faisables (ex: "tester le modèle X via Hugging Face", "lire le paper Y sur arxiv", "suivre la levée Z chez le concurrent A"). Pas de "à surveiller" vague — du concret.

Règles : sois factuel, dense, sans répéter les résumés tels quels. Synthèse intelligente, pas une liste à puces. Tous les liens en Markdown. Date d'aujourd'hui : ${new Date().toISOString().slice(0, 10)}.`;

  const result = await mistral.chat.complete({
    model: MISTRAL_MODEL,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = result.choices?.[0]?.message?.content ?? "";
  return typeof raw === "string"
    ? raw
    : raw.map((c: { type: string }) => ("text" in c ? (c as { text: string }).text : "")).join("");
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
  const articles = await loadRecentArticles();
  console.log(`${articles.length} articles sur les ${DIGEST_WINDOW_DAYS} derniers jours`);

  const digest = await generateDigest(articles);

  // Sauvegarde Markdown
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve("data/digests");
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${today}.md`);
  await fs.writeFile(filePath, digest, "utf-8");
  console.log(`Digest sauvegardé : ${filePath}`);

  // Envoi email
  const html = markdownToHtml(digest);
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM!,
    to: EMAIL_TO!,
    subject: `📰 Digest — ${today}`,
    html,
    text: digest,
  });

  if (error) {
    console.error("Erreur envoi email:", error);
    process.exit(1);
  }
  console.log("Email envoyé:", data?.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
