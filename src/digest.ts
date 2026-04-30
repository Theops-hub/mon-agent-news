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

// Charge les articles des 7 derniers jours
async function loadWeekArticles(): Promise<Article[]> {
  const dir = path.resolve("data/articles");
  const files = await fs.readdir(dir).catch(() => []);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

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
    return "# Digest hebdomadaire\n\nAucun article notable cette semaine.";
  }

  // Tri par score décroissant, top 30 max pour rester dans les limites de tokens
  const top = articles.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 30);

  const articlesText = top
    .map(
      (a) =>
        `- [${a.category}] **${a.title}** (${a.source}, score ${a.score})\n  Résumé : ${a.summary}\n  Lien : ${a.link}`
    )
    .join("\n\n");

  const prompt = `Tu es un journaliste de veille. Voici les articles importants de la semaine, déjà triés et résumés :

${articlesText}

Rédige un compte-rendu hebdomadaire en français, au format Markdown, avec :
1. Un titre principal "# Digest hebdomadaire — semaine du [date début] au [date fin]"
2. Une introduction de 3-4 phrases sur les grandes tendances de la semaine
3. Des sections par thème (Tech & IA, Géopolitique, Outils dev, etc. — adapte aux articles présents)
4. Pour chaque section, synthétise 3-6 articles en paragraphes liés (pas une liste à puces) avec les liens en Markdown
5. Une courte conclusion "À surveiller la semaine prochaine"

Sois concis, factuel, et mets en avant les vraies nouveautés. Ne répète pas les résumés tels quels, fais une synthèse intelligente. Date d'aujourd'hui : ${new Date().toISOString().slice(0, 10)}.`;

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
  console.log("Génération du digest hebdomadaire...");
  const articles = await loadWeekArticles();
  console.log(`${articles.length} articles sur la semaine`);

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
    subject: `📰 Digest hebdo — ${today}`,
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
