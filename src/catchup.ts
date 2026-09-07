// Rattrapage ponctuel : régénère de VRAIS digests pour des jours partis en
// mode dégradé, à partir des articles déjà collectés et stockés dans
// data/articles/. Les articles sont là, ils n'ont juste jamais été notés ni
// résumés (la chaîne LLM était tombée).
//
//   npm run catchup -- 2026-09-04 2026-09-05
//
// Pour chaque jour, dans l'ordre :
//   1. note et résume les articles qui n'ont pas de score ;
//   2. réécrit data/articles/<jour>.json avec les scores (le bilan mensuel
//      s'appuie dessus, autant réparer la donnée au passage) ;
//   3. rédige le digest et l'envoie par mail ;
//   4. remplace data/digests/<jour>-degraded.md par <jour>.md.
//
// Les articles de ces jours-là avaient été marqués « envoyés » dans sent.json
// alors qu'ils ne l'avaient jamais vraiment été : on remet à zéro les entrées
// des jours rattrapés avant de commencer, puis on ne remarque que ce qui part
// réellement dans un digest. La déduplication reste active ENTRE les jours
// rattrapés, pour ne pas envoyer deux fois le même article.

import fs from "node:fs/promises";
import path from "node:path";
import { scoreInBatches, generateDigest, DIGEST_TOP_N } from "./digest-core.js";
import { sendEmail } from "./email.js"; // vérifie aussi RESEND_API_KEY/EMAIL_TO à l'import
import sourcesConfig from "../config/sources.json" with { type: "json" };
import type { Article } from "./types.js";

if (!process.env.MISTRAL_API_KEY && !process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
  throw new Error("Au moins une clé API LLM doit être configurée (MISTRAL_API_KEY, GROQ_API_KEY ou GEMINI_API_KEY)");
}

const ARTICLES_DIR = path.resolve("data/articles");
const DIGESTS_DIR = path.resolve("data/digests");
const SENT_TRACKER_PATH = path.resolve("data/sent.json");

type SentTracker = Record<string, string>;

function parseDates(argv: string[]): string[] {
  const dates = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (dates.length === 0) {
    throw new Error(
      "Aucune date valide fournie. Usage : npm run catchup -- 2026-09-04 2026-09-05"
    );
  }
  return [...new Set(dates)].sort();
}

async function loadSentTracker(): Promise<SentTracker> {
  try {
    return JSON.parse(await fs.readFile(SENT_TRACKER_PATH, "utf-8")) as SentTracker;
  } catch {
    return {};
  }
}

async function main() {
  const dates = parseDates(process.argv.slice(2));
  console.log(`Rattrapage de ${dates.length} jour(s) : ${dates.join(", ")}`);

  const tracker = await loadSentTracker();

  // Les jours rattrapés n'ont jamais vraiment été envoyés : on libère leurs URLs
  // pour que la déduplication ne les écarte pas immédiatement.
  const released = Object.entries(tracker).filter(([, d]) => dates.includes(d));
  for (const [url] of released) delete tracker[url];
  console.log(`${released.length} URL(s) libérée(s) du tracker (marquées envoyées à tort)`);

  const summary: string[] = [];

  for (const date of dates) {
    console.log(`\n=== ${date} ===`);
    const articlesPath = path.join(ARTICLES_DIR, `${date}.json`);

    let stored: { articles: Article[] };
    try {
      stored = JSON.parse(await fs.readFile(articlesPath, "utf-8")) as { articles: Article[] };
    } catch {
      console.warn(`${date} : data/articles/${date}.json introuvable — jour ignoré.`);
      summary.push(`${date} : ignoré (pas de fichier d'articles)`);
      continue;
    }

    // 1. Scoring des articles qui n'en ont pas.
    const toScore = stored.articles.filter((a) => typeof a.score !== "number");
    console.log(`${stored.articles.length} article(s) en stock, ${toScore.length} à noter`);
    const freshlyScored = toScore.length > 0 ? await scoreInBatches(toScore) : [];

    const byLink = new Map(freshlyScored.map((a) => [a.link, a]));
    const allScored = stored.articles.map((a) => byLink.get(a.link) ?? a);
    const stillUnscored = allScored.filter((a) => typeof a.score !== "number").length;
    if (stillUnscored > 0) {
      console.warn(`${stillUnscored} article(s) toujours sans score (batch en échec)`);
    }

    // 2. Réparation du fichier d'articles du jour.
    await fs.writeFile(
      articlesPath,
      JSON.stringify(
        { date, articles: allScored, unscored: stillUnscored === allScored.length },
        null,
        2
      ),
      "utf-8"
    );
    console.log(`Scores réécrits dans data/articles/${date}.json`);

    // 3. Sélection : filtre de pertinence + articles pas déjà repris un jour précédent.
    const relevant = allScored.filter(
      (a) => typeof a.score !== "number" || a.score >= sourcesConfig.minScore
    );
    const candidates = relevant.filter((a) => a.link && !tracker[a.link]);
    console.log(
      `${relevant.length} article(s) au-dessus du seuil (score ≥ ${sourcesConfig.minScore}), ` +
        `${candidates.length} pas encore repris`
    );

    if (candidates.length === 0) {
      console.warn(`${date} : rien à envoyer.`);
      summary.push(`${date} : rien à envoyer`);
      continue;
    }

    // 4. Rédaction du digest, sur la journée elle-même (pas une fenêtre glissante).
    const { markdown, degraded, included } = await generateDigest(candidates, {
      startDate: date,
      endDate: date,
    });

    if (degraded) {
      // Inutile de renvoyer un deuxième digest dégradé : c'est exactement ce
      // qu'on est en train de rattraper. On s'arrête pour ne pas brûler les
      // articles des jours suivants avec une chaîne LLM toujours en panne.
      throw new Error(
        `${date} : la chaîne LLM est toujours en panne (digest dégradé). Rattrapage interrompu, aucun mail envoyé pour ce jour. Lancer le workflow « LLM Health Check » pour diagnostiquer.`
      );
    }

    // 5. Sauvegarde : le .md propre remplace le -degraded.md, sinon le bilan
    // mensuel compterait le même jour deux fois.
    await fs.mkdir(DIGESTS_DIR, { recursive: true });
    await fs.writeFile(path.join(DIGESTS_DIR, `${date}.md`), markdown, "utf-8");
    const degradedPath = path.join(DIGESTS_DIR, `${date}-degraded.md`);
    const hadDegraded = await fs
      .unlink(degradedPath)
      .then(() => true)
      .catch(() => false);
    console.log(
      `Digest écrit : data/digests/${date}.md${hadDegraded ? ` (remplace ${date}-degraded.md)` : ""}`
    );

    // 6. Envoi. sendEmail retente 3 fois puis lève → le run échoue et
    // notify-failure ouvre une issue.
    const emailId = await sendEmail({
      subject: `📰 Digest (rattrapage) — ${date}`,
      markdown,
      footerNote: `Digest du ${date}, régénéré après la panne de la chaîne LLM`,
    });
    console.log(`Email envoyé pour ${date} :`, emailId);

    // 7. Marquage APRÈS envoi réussi, et seulement pour ce qui est dans le digest.
    for (const a of included) {
      if (a.link) tracker[a.link] = date;
    }
    await fs.writeFile(SENT_TRACKER_PATH, JSON.stringify(tracker, null, 2), "utf-8");

    const leftOver = candidates.length - included.length;
    summary.push(
      `${date} : ${included.length} article(s) envoyé(s)` +
        (leftOver > 0 ? `, ${leftOver} hors du top ${DIGEST_TOP_N}` : "")
    );
  }

  console.log("\n=== Bilan du rattrapage ===");
  for (const line of summary) console.log(`  ${line}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
