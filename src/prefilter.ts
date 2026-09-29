// Pré-sélection SANS LLM, pour tenir dans les paliers gratuits.
//
// Le facteur limitant n'est pas le volume de tokens mais le NOMBRE d'appels :
// chacun est une occasion de tomber sur un 429 (quota) ou un 503 (modèle
// saturé). Noter 148 articles demandait 13 appels ; en n'en notant que les plus
// prometteurs, on descend à 2, ce qui laisse enfin de la marge aux retries.
//
// Aucun article n'est jeté : la collecte les sauvegarde tous. Le pré-filtre
// décide seulement lesquels méritent un appel LLM, et attribue à tous un
// `heuristicScore` qui sert de classement de repli quand la notation échoue.

import type { Article, Trust } from "./types.js";

export type PrefilterConfig = {
  /** Nombre d'articles envoyés à la notation LLM. */
  limit: number;
  /** Plafond par source, pour qu'un flux bavard ne monopolise pas la sélection. */
  perSourceCap: number;
  /** Termes qui signalent un sujet prioritaire, par poids. */
  keywords: { weight: number; terms: string[] }[];
};

// Titre normalisé pour repérer le même sujet publié par plusieurs sources :
// minuscules, accents retirés, ponctuation retirée, espaces normalisés.
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Une source vérifiée l'emporte sur un post communautaire ou promotionnel quand
// les deux traitent du même sujet.
const TRUST_RANK: Record<Trust, number> = { verified: 2, community: 1, promotional: 0 };
const trustRank = (a: Article): number => TRUST_RANK[a.trust ?? "verified"];

export function heuristicScore(article: Article, config: PrefilterConfig): number {
  const haystack = `${article.title} ${article.contentSnippet ?? ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  let score = 0;
  for (const group of config.keywords) {
    // Chaque groupe est PLAFONNÉ à deux termes touchés. Sans ce plafond, un post
    // auto-promotionnel qui empile les mots-clés dans sa description écrasait une
    // vraie nouvelle au titre court : un rachat à 8 milliards se retrouvait
    // classé sous un « Show HN » quelconque. Les malus, eux, s'appliquent
    // pleinement — un article hors sujet doit pouvoir couler.
    const matches = group.terms.filter((t) => haystack.includes(t)).length;
    score += group.weight < 0 ? matches * group.weight : Math.min(matches, 2) * group.weight;
  }

  // Un article dont le contenu complet a été récupéré donne un meilleur résumé
  // qu'un simple extrait de flux : léger bonus à qualité de signal égale.
  if (article.fullContent) score += 1;

  // À pertinence comparable, une source vérifiée passe devant : c'est un fait
  // rapporté, pas une affirmation à vérifier. Le promotionnel reste éligible
  // (les nouveaux outils sortent là) mais ne doit pas dominer le classement.
  const trust = article.trust ?? "verified";
  if (trust === "verified") score += 3;
  else if (trust === "promotional") score -= 1;

  return score;
}

export type PrefilterResult = {
  /** Articles à envoyer à la notation LLM, du plus prometteur au moins. */
  candidates: Article[];
  /** Tous les articles, chacun porteur de son heuristicScore. */
  all: Article[];
  duplicatesRemoved: number;
  cappedBySource: number;
};

export function prefilter(articles: Article[], config: PrefilterConfig): PrefilterResult {
  // 1. Score heuristique pour tout le monde.
  const scored = articles.map((a) => ({ ...a, heuristicScore: heuristicScore(a, config) }));

  // 2. Déduplication inter-sources sur le titre normalisé. La collecte ne
  // dédoublonne que par source+titre, donc le même sujet relayé par trois
  // sources consommait jusqu'ici trois places de notation.
  const bestByTitle = new Map<string, Article>();
  let duplicatesRemoved = 0;
  for (const a of scored) {
    const key = normalizeTitle(a.title);
    if (!key) continue;
    const current = bestByTitle.get(key);
    if (!current) {
      bestByTitle.set(key, a);
      continue;
    }
    duplicatesRemoved++;
    const better =
      trustRank(a) > trustRank(current) ||
      (trustRank(a) === trustRank(current) &&
        (a.heuristicScore ?? 0) > (current.heuristicScore ?? 0));
    if (better) bestByTitle.set(key, a);
  }

  // 3. Tri par pertinence, puis fraîcheur à score égal.
  const unique = [...bestByTitle.values()].sort((x, y) => {
    const d = (y.heuristicScore ?? 0) - (x.heuristicScore ?? 0);
    if (d !== 0) return d;
    return new Date(y.pubDate).getTime() - new Date(x.pubDate).getTime();
  });

  // 4. Plafond par source, puis limite globale.
  const perSource = new Map<string, number>();
  const candidates: Article[] = [];
  let cappedBySource = 0;
  for (const a of unique) {
    if (candidates.length >= config.limit) break;
    const used = perSource.get(a.source) ?? 0;
    if (used >= config.perSourceCap) {
      cappedBySource++;
      continue;
    }
    perSource.set(a.source, used + 1);
    candidates.push(a);
  }

  return { candidates, all: scored, duplicatesRemoved, cappedBySource };
}
