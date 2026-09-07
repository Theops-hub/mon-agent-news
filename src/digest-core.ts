// Cœur du pipeline : notation/résumé des articles et rédaction du digest.
//
// Extrait de collect.ts et digest.ts pour être partagé avec le rattrapage
// (src/catchup.ts). Les prompts sont longs et se répondent l'un à l'autre —
// les dupliquer dans un script de rattrapage les aurait fait diverger dès la
// première retouche.

import { callLLM } from "./llm.js";
import sourcesConfig from "../config/sources.json" with { type: "json" };
import type { Article } from "./types.js";

// Combien d'articles sont passés au LLM pour la synthèse. Ce sont les seuls
// que le digest mentionne, donc les seuls à marquer comme envoyés.
export const DIGEST_TOP_N = 30;

// Taille des batches de scoring. Elle arbitre entre volume du prompt (le
// contenu complet est lourd) et NOMBRE d'appels — et c'est le nombre d'appels
// qui coince : les offres gratuites limitent les requêtes par minute, pas les
// tokens. 12 articles par appel divise par deux les requêtes d'un run.
const SCORING_BATCH_SIZE = 12;
// Pause entre batches, calibrée pour rester sous les ~10 requêtes/minute des
// paliers gratuits. À 1,5 s, le rattrapage du 7 septembre 2026 tapait ~40
// req/min et se faisait rate-limiter dès le premier jour.
const SCORING_BATCH_PAUSE_MS = 6000;

// Découpe un tableau en chunks de taille n
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Fait noter et résumer un batch d'articles par la chaîne LLM (batch pour économiser des appels).
export async function scoreAndSummarize(articles: Article[]): Promise<Article[]> {
  if (articles.length === 0) return [];

  const interests = sourcesConfig.interests.map((i) => `- ${i}`).join("\n");
  const articlesText = articles
    .map((a, i) => {
      const body = a.fullContent || a.contentSnippet || "";
      const label = a.fullContent ? "Contenu" : "Extrait (contenu complet indisponible)";
      return `[${i}] Source: ${a.source} | Catégorie: ${a.category} | Publié: ${a.pubDate}\nTitre: ${a.title}\n${label} : ${body}`;
    })
    .join("\n\n---\n\n");

  const prompt = `Tu es un assistant de veille. Nous sommes le ${new Date().toISOString().slice(0, 10)}. Voici mes centres d'intérêt :
${interests}

Voici ${articles.length} articles avec leur contenu (souvent complet). Pour CHACUN, donne :
- "score" : pertinence pour mes intérêts de 1 à 10
- "reason" : 1 phrase expliquant la note
- "summary" : résumé en 3-5 phrases en français basé sur le contenu fourni (même si l'article est en anglais). Couvre les faits clés, pas seulement le titre.

RÈGLE DE FRAÎCHEUR (prioritaire sur tout le reste) : je ne veux QUE de l'actualité récente. Si le contenu est manifestement ancien — année passée dans le titre (ex. « ... (2019) »), billet de blog ou paper vieux de plusieurs mois/années remis en avant (fréquent sur Hacker News), rétrospective, anniversaire — donne un score de 3 maximum, même si le sujet correspond à mes intérêts. Seule exception : un fait NOUVEAU à propos d'un sujet ancien (nouvelle version, nouvelle décision, nouveau résultat) reste noté normalement.

Réponds UNIQUEMENT en JSON valide, sous cette forme exacte :
{"results": [{"index": 0, "score": 8, "reason": "...", "summary": "..."}, ...]}

Articles :
${articlesText}`;

  try {
    const { text, provider } = await callLLM({ prompt, jsonMode: true });
    console.log(`Scoring batch via ${provider}`);
    // Extrait le JSON même si entouré de ```json ... ```
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]) as {
      results: { index: number; score: number; reason: string; summary: string }[];
    };

    return articles.map((a, i) => {
      const r = parsed.results.find((x) => x.index === i);
      return r ? { ...a, score: r.score, reason: r.reason, summary: r.summary } : a;
    });
  } catch (err) {
    console.error("Scoring LLM échoué pour ce batch:", (err as Error).message);
    return articles;
  }
}

// Note et résume une liste d'articles, par batches successifs. Les articles
// dont le batch échoue ressortent tels quels, sans score : c'est à l'appelant
// de décider quoi en faire (surtout pas de les traiter comme des zéros).
export async function scoreInBatches(articles: Article[]): Promise<Article[]> {
  const batches = chunk(articles, SCORING_BATCH_SIZE);
  const scored: Article[] = [];
  for (let b = 0; b < batches.length; b++) {
    const result = await scoreAndSummarize(batches[b]);
    scored.push(...result);
    if (b < batches.length - 1) {
      await new Promise((r) => setTimeout(r, SCORING_BATCH_PAUSE_MS));
    }
  }
  return scored;
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
    business: "💰 Marché & opportunités",
  };

  const sections: string[] = [];
  for (const [cat, list] of byCategory) {
    const title = categoryEmoji[cat] ?? cat;
    const items = list
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((a) => {
        const scoreTag = typeof a.score === "number" ? ` *(score ${a.score})*` : "";
        const summary = a.summary || a.contentSnippet || "";
        const summaryLine = summary ? `\n  ${summary.slice(0, 400)}` : "";
        return `- **${a.title}** — ${a.source}${scoreTag}${summaryLine}\n  [Lien](${a.link})`;
      })
      .join("\n\n");
    sections.push(`## ${title}\n\n${items}`);
  }

  return `${header}\n\n${sections.join("\n\n")}`;
}

// Renvoie le digest ET la liste des articles réellement inclus dedans : seuls
// ceux-là doivent être marqués comme envoyés (voir main()).
// La période est passée explicitement plutôt que déduite de la date du jour :
// le rattrapage (src/catchup.ts) régénère des digests pour des jours passés, et
// `today` servait aussi de repère de fraîcheur au LLM.
export async function generateDigest(
  articles: Article[],
  period: { startDate: string; endDate: string }
): Promise<{ markdown: string; degraded: boolean; included: Article[] }> {
  const { startDate, endDate } = period;

  if (articles.length === 0) {
    return {
      markdown: "# Digest\n\nAucun article notable sur la période.",
      degraded: false,
      included: [],
    };
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

5bis. **Mise en forme des liens** : le texte d'un lien Markdown doit être court et lisible — le nom de la source ou de l'outil (ex. \`[TechCrunch](url)\`, \`[Bonsai 27B](url)\`), JAMAIS l'URL brute ni un chemin type "site.com/2026/07/14/titre-complet". Mets en **gras** les noms d'outils, de modèles et d'entreprises à leur première mention dans chaque paragraphe.

6. **Articles 10/10 obligatoires** : tout article noté 10/10 dans la liste ci-dessus DOIT être mentionné dans le digest (en intro ou dans une section thématique). Aucune omission tolérée pour les articles 10/10 — sauf s'il s'agit d'actualité géopolitique, auquel cas il est ignoré comme le reste.

============================================
STRUCTURE À PRODUIRE :
============================================

# Digest — du [date début] au [date fin]

**Introduction** (3-4 phrases) : grandes tendances de la période, factuelles, basées strictement sur les articles ci-dessus.

## 🚀 Avancées IA & opportunités à saisir (≈ 50%)
Pour chaque sujet IA pertinent (nouveaux modèles, papers, outils testables, signaux d'adoption en entreprise), un paragraphe dense de 4-7 phrases. Termine chaque paragraphe par les liens Markdown vers les sources (uniquement celles présentes dans les articles ci-dessus).

## 🛠️ Tech & industrie (≈ 25%)
Mouvements de marché, levées, deals, lancements produits, réglementation tech. Paragraphes courts, factuels.

## 💰 Idées marché à saisir (≈ 25%) — SECTION OPTIONNELLE
Le lecteur est développeur solo ET entrepreneur : il veut lancer une activité en ligne vite quand une fenêtre s'ouvre. N'inclus ici QUE des sujets relevant d'un de ces deux signaux, et dis lequel :

1. **Capacité nouvelle** — un modèle, une API, un outil ou une baisse de prix qui rend faisable et vendable un service qui ne l'était pas avant. Écris ce que ça permet de VENDRE, pas seulement ce que ça permet de faire.
2. **Traction observable** — un produit, un indie hacker ou une startup qui montre des revenus, une croissance ou une levée sur un créneau réplicable par une personne seule. Donne les chiffres cités dans l'article, jamais d'estimation de ta part.

Pour chaque piste, en 3 à 5 phrases : ce qui vient de changer, ce que ça rend vendable, qui paierait, et le premier pas concret. Termine par le ou les liens Markdown.

**Cette section est OPTIONNELLE et tu dois l'OMETTRE complètement si rien dans les articles ci-dessus ne relève réellement de ces deux signaux.** Un digest plus court vaut mieux qu'une opportunité inventée. N'utilise JAMAIS cette section pour recycler une annonce de modèle déjà traitée plus haut, une levée de fonds d'un géant (non réplicable), ou une tendance vague sans acheteur identifiable. Zéro piste solide = zéro ligne, pas de section.

**INTERDIT** : aucune actualité géopolitique, conflit, élection ou fait divers dans ce digest, quelle que soit la section. Si de tels articles figurent dans la liste, ignore-les purement et simplement.

## 🎯 À tester / appliquer (section OPTIONNELLE)
Inclus cette section UNIQUEMENT si des articles appellent une action que le lecteur (développeur individuel) peut réaliser lui-même : tester un outil ou modèle disponible publiquement, appliquer une mise à jour de sécurité, essayer une API, lire un paper ou une doc technique. De 1 à 3 actions maximum, chacune en 2-3 phrases avec le ou les liens Markdown vers les sources. Les mouvements de marché, la géopolitique et les annonces corporate ne sont PAS actionnables par le lecteur : n'en tire jamais d'action. Si rien n'est réellement actionnable, OMETS complètement la section — pas de remplissage.

Date d'aujourd'hui : ${endDate}.`;

  try {
    const { text, provider } = await callLLM({ prompt, temperature: 0.2 });
    console.log(`Digest généré via ${provider}`);
    return { markdown: text, degraded: false, included: top };
  } catch (err) {
    console.error("Tous les LLM ont échoué pour le digest :", (err as Error).message);
    console.warn("Passage en mode dégradé : envoi des articles bruts.");
    return {
      markdown: buildFallbackDigest(top, startDate, endDate),
      degraded: true,
      included: top,
    };
  }
}
