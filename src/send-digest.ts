// Envoie par mail un digest DÉJÀ écrit dans data/digests/, sans appeler aucun
// LLM. Sert quand les digests ont été rédigés autrement — à la main, ou par un
// agent — et qu'il reste juste à les livrer.
//
//   npm run send-digest -- 2026-09-04 2026-09-05
//
// Ne touche pas à data/sent.json : ce fichier trace les articles déjà envoyés,
// et un renvoi de digest ne change pas ce qui a été collecté. À utiliser en
// connaissance de cause, l'outil n'a aucune protection contre le double envoi.

import fs from "node:fs/promises";
import path from "node:path";
import { sendEmail } from "./email.js"; // vérifie aussi RESEND_API_KEY/EMAIL_TO à l'import

const DIGESTS_DIR = path.resolve("data/digests");

function parseDates(argv: string[]): string[] {
  const dates = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (dates.length === 0) {
    throw new Error("Usage : npm run send-digest -- 2026-09-04 [2026-09-05 ...]");
  }
  return [...new Set(dates)].sort();
}

async function main() {
  const dates = parseDates(process.argv.slice(2));
  console.log(`Envoi de ${dates.length} digest(s) : ${dates.join(", ")}`);

  const missing: string[] = [];
  const found: { date: string; markdown: string }[] = [];

  // On lit TOUT avant d'envoyer quoi que ce soit : mieux vaut échouer sans
  // rien envoyer que d'expédier la moitié des jours demandés.
  for (const date of dates) {
    const file = path.join(DIGESTS_DIR, `${date}.md`);
    try {
      found.push({ date, markdown: await fs.readFile(file, "utf-8") });
    } catch {
      missing.push(date);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Digest introuvable pour : ${missing.join(", ")} — attendu dans data/digests/<jour>.md. Aucun mail envoyé.`
    );
  }

  for (const { date, markdown } of found) {
    const emailId = await sendEmail({
      subject: `📰 Digest — ${date}`,
      markdown,
      footerNote: `Digest du ${date}`,
    });
    console.log(`${date} : envoyé (${emailId})`);
  }
  console.log(`${found.length} digest(s) envoyé(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
