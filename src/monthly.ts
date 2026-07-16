// Bilan mensuel : compare tous les digests quotidiens du mois écoulé et en
// tire une synthèse courte des outils IA les plus intéressants pour le profil
// de l'utilisateur (config/sources.json → "profile"). Tourne le 1er du mois
// via monthly-digest.yml et couvre le mois calendaire précédent.

import fs from "node:fs/promises";
import path from "node:path";
import { callLLM } from "./llm.js";
import { sendEmail } from "./email.js"; // vérifie aussi RESEND_API_KEY/EMAIL_TO à l'import
import sourcesConfig from "../config/sources.json" with { type: "json" };

if (!process.env.MISTRAL_API_KEY && !process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
  throw new Error("Au moins une clé API LLM doit être configurée (MISTRAL_API_KEY, GROQ_API_KEY ou GEMINI_API_KEY)");
}

const DIGESTS_DIR = path.resolve("data/digests");
const MONTHLY_DIR = path.resolve("data/digests/monthly");
// Garde-fou tokens : chaque digest quotidien est déjà élagué de sa section
// géopolitique, mais on plafonne quand même sa taille.
const MAX_CHARS_PER_DIGEST = 9000;

const MONTH_NAMES_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

// Mois calendaire précédent, au format "YYYY-MM" (le workflow tourne le 1er).
function previousMonth(): { key: string; label: string } {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const key = d.toISOString().slice(0, 7);
  return { key, label: `${MONTH_NAMES_FR[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
}

// Ne garde que les sections utiles au bilan outils : la géopolitique et le
// contexte mondial n'ont rien à faire dans la synthèse mensuelle, et les
// retirer réduit nettement la taille du prompt (~30 digests concaténés).
function stripWorldSections(md: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of md.split("\n")) {
    if (/^##\s/.test(line)) {
      skipping = /🌍|contexte mondial|géopolitique/i.test(line);
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim().slice(0, MAX_CHARS_PER_DIGEST);
}

async function loadMonthDigests(monthKey: string): Promise<{ date: string; content: string }[]> {
  const files = await fs.readdir(DIGESTS_DIR).catch(() => [] as string[]);
  const out: { date: string; content: string }[] = [];
  for (const file of files.sort()) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})(-degraded)?\.md$/);
    if (!m || !m[1].startsWith(monthKey)) continue;
    const content = await fs.readFile(path.join(DIGESTS_DIR, file), "utf-8");
    out.push({ date: m[1], content: stripWorldSections(content) });
  }
  return out;
}

async function generateMonthly(
  digests: { date: string; content: string }[],
  monthLabel: string
): Promise<string> {
  const corpus = digests
    .map((d) => `===== DIGEST DU ${d.date} =====\n${d.content}`)
    .join("\n\n");

  const prompt = `Tu es un analyste de veille IA. Voici le profil de ton lecteur :

${sourcesConfig.profile}

Voici les ${digests.length} digests quotidiens de ${monthLabel} (sections géopolitique déjà retirées) :

${corpus}

============================================
TA MISSION
============================================
Compare l'ensemble de ces digests et produis un BILAN MENSUEL COURT, entièrement tourné vers l'usage concret du lecteur. Ce n'est pas un résumé de l'actualité : c'est une sélection. Privilégie les outils/modèles qui reviennent plusieurs fois dans le mois, qui ont mûri, ou qui sont immédiatement testables par un développeur solo.

RÈGLES STRICTES :
1. N'INVENTE RIEN : uniquement des faits présents dans les digests ci-dessus. En cas de doute, omets.
2. URLS : uniquement celles présentes dans les digests. Texte de lien court ([Nom de l'outil](url)), jamais d'URL brute.
3. COURT : chaque outil retenu = 2-3 lignes max. Mieux vaut 4 outils bien choisis que 10 survolés.
4. Pas de remplissage ni de phrases creuses. Si une section n'a pas de matière ce mois-ci, dis-le en une ligne.

STRUCTURE À PRODUIRE :

# Bilan mensuel — ${monthLabel}

**L'essentiel** : 3-4 phrases sur ce qui a vraiment compté ce mois-ci pour un développeur IA solo.

## 🏆 Les outils du mois pour ton stack
Les 3 à 6 outils/modèles/services les plus intéressants du mois pour son usage (vibecoding, SaaS, apps web, Claude Code). Pour chacun : **Nom** — ce que c'est, pourquoi ça vaut le coup pour LUI, lien. Signale si un outil est revenu plusieurs fois dans le mois (signal de traction).

## 🖥️ LLM locaux : où on en est
Ce qui a bougé ce mois-ci côté modèles exécutables en local / open-weight (nouveaux modèles, quantization, matériel). Conclus par une phrase d'avis : est-ce qu'une solution locale devient assez crédible pour son usage, ou pas encore ?

## 📈 Tendances de fond
2-3 tendances qui se dégagent en comparant les digests du mois (pas des événements isolés). Une phrase ou deux par tendance.

## 🎯 Si tu ne testes qu'une chose ce mois-ci
UNE seule recommandation concrète et testable, en 2-3 phrases, avec le lien.`;

  const { text, provider } = await callLLM({ prompt, temperature: 0.2 });
  console.log(`Bilan mensuel généré via ${provider}`);
  return text;
}

async function main() {
  const { key: monthKey, label: monthLabel } = previousMonth();
  console.log(`Bilan mensuel de ${monthLabel} (${monthKey})...`);

  const digests = await loadMonthDigests(monthKey);
  console.log(`${digests.length} digest(s) quotidien(s) trouvé(s) pour ${monthKey}`);

  // Aucun digest sur tout le mois = pipeline en panne prolongée : on échoue
  // franchement pour que notify-failure ouvre une issue.
  if (digests.length === 0) {
    console.error(`Aucun digest quotidien trouvé pour ${monthKey} — vérifier les workflows quotidiens.`);
    process.exit(1);
  }

  // Pas de mode dégradé ici : le bilan mensuel n'a pas d'urgence, si tous les
  // LLM échouent on laisse le run planter → issue GitHub, et on relance à la main.
  const markdown = await generateMonthly(digests, monthLabel);

  await fs.mkdir(MONTHLY_DIR, { recursive: true });
  const filePath = path.join(MONTHLY_DIR, `${monthKey}.md`);
  await fs.writeFile(filePath, markdown, "utf-8");
  console.log(`Bilan sauvegardé : ${filePath}`);

  const emailId = await sendEmail({
    subject: `🗓️ Bilan mensuel IA — ${monthLabel}`,
    markdown,
    footerNote: `Bilan mensuel (${digests.length} digests quotidiens comparés)`,
  });
  console.log("Email envoyé:", emailId);
}

main()
  .then(() => {
    // Sortie explicite, même logique que collect.ts/digest.ts : ne pas laisser
    // des handles réseau résiduels suspendre le process jusqu'au timeout.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
