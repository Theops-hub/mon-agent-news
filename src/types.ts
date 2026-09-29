// Types partagés entre la collecte (collect.ts) et le digest (digest.ts).
// Source unique de vérité pour éviter que les définitions divergent.

// Fiabilité d'une source, qui décide de la façon dont le digest peut citer son
// contenu : un fait rapporté par la presse ne s'écrit pas comme l'avis d'un
// utilisateur ni comme l'argumentaire d'un vendeur.
export type Trust = "verified" | "community" | "promotional";

export type Source = { name: string; url: string; category: string; trust?: Trust };

export type Article = {
  title: string;
  link: string;
  source: string;
  category: string;
  pubDate: string;
  trust?: Trust;
  contentSnippet?: string;
  fullContent?: string;
  score?: number;
  reason?: string;
  summary?: string;
};
