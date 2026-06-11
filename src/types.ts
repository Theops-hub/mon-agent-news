// Types partagés entre la collecte (collect.ts) et le digest (digest.ts).
// Source unique de vérité pour éviter que les définitions divergent.

export type Source = { name: string; url: string; category: string };

export type Article = {
  title: string;
  link: string;
  source: string;
  category: string;
  pubDate: string;
  contentSnippet?: string;
  fullContent?: string;
  score?: number;
  reason?: string;
  summary?: string;
};
