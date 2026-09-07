// Healthcheck des flux RSS de config/sources.json.
//
// collect.ts avale les flux morts en silence — un `console.warn` par source en
// échec, noyé dans les logs, et le digest du jour est simplement plus pauvre
// sans que personne ne sache pourquoi. Ce script rend la panne visible, et sert
// aussi à valider une source AVANT de l'ajouter durablement.
//
// Échoue (exit 1) si une source ne répond pas, ne parse pas, ou ne renvoie
// aucun article — l'échec du workflow déclenche notify-failure → issue GitHub.

import Parser from "rss-parser";
import sourcesConfig from "../config/sources.json" with { type: "json" };
import type { Source } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; mon-agent-news/1.0; +https://github.com/) news-aggregator-bot";

const parser = new Parser({ timeout: 20000, headers: { "User-Agent": USER_AGENT } });

// Les flux sont testés en parallèle limité : 21 sources séquentielles à 20 s de
// timeout chacune dépasseraient le budget du workflow dans le pire cas.
const CONCURRENCY = 5;

type Result = { source: Source; ok: boolean; detail: string };

async function check(source: Source): Promise<Result> {
  try {
    const feed = await parser.parseURL(source.url);
    const items = feed.items?.length ?? 0;
    if (items === 0) {
      return { source, ok: false, detail: "flux parsé mais vide (0 article)" };
    }
    // Une source qui ne date jamais ses items est inutilisable : collect.ts
    // écarte les articles sans date pour garantir la fraîcheur.
    const dated = feed.items!.filter((i) => i.pubDate || i.isoDate).length;
    if (dated === 0) {
      return { source, ok: false, detail: `${items} article(s) mais AUCUNE date de publication — tous seraient écartés par la collecte` };
    }
    return { source, ok: true, detail: `${items} article(s), ${dated} daté(s)` };
  } catch (err) {
    return { source, ok: false, detail: (err as Error).message.slice(0, 160) };
  }
}

async function main() {
  const sources = sourcesConfig.sources as Source[];
  console.log(`Vérification de ${sources.length} flux...\n`);

  const results: Result[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, sources.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= sources.length) return;
        results[i] = await check(sources[i]);
      }
    })
  );

  for (const r of results) {
    const tag = r.ok ? "OK  " : "KO  ";
    console.log(`${tag} [${r.source.category}] ${r.source.name} — ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nBilan : ${results.length - failed.length}/${results.length} flux opérationnels`);

  if (failed.length > 0) {
    console.error(`\n${failed.length} flux en échec :`);
    for (const r of failed) {
      console.error(`  → ${r.source.name} (${r.source.url}) : ${r.detail}`);
    }
    console.error(
      "\nACTION : corriger l'URL dans config/sources.json, ou retirer la source si le flux n'existe plus."
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
