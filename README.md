# 📰 Mon Agent News

Agent IA autonome de veille tech/IA/géopolitique. 100% gratuit, t'appartient entièrement.

## Ce qu'il fait

- **Chaque nuit (03:37 UTC, rattrapage à 10:37)** : récupère les nouveaux articles depuis 18 flux RSS (Tech/IA/dev + actu générale/géopolitique), télécharge leur contenu complet, demande à un LLM de noter leur pertinence selon tes intérêts, garde ceux ≥ 7/10. Les articles sans date de publication sont écartés et le contenu ancien remis en avant (reposts Hacker News, rétrospectives) est pénalisé : seule l'actu fraîche passe.
- **Chaque matin (05:07 UTC, rattrapage à 08:07 — réception ~8h heure de Paris)** : compile les nouveaux articles, génère un compte-rendu structuré (IA & opportunités, tech & industrie, contexte mondial, et une section « À tester / appliquer » uniquement quand quelque chose est réellement actionnable), te l'envoie par email en HTML mis en page. Un tracker `data/sent.json` garantit qu'aucun article n'est envoyé deux fois — c'est aussi ce qui rend les runs de rattrapage inoffensifs.
- **Le 1er du mois (06:07 UTC, rattrapage le 2)** : compare tous les digests quotidiens du mois écoulé et envoie un **bilan mensuel** court — les outils IA les plus intéressants pour ton stack (vibecoding, SaaS, apps web, Claude Code), l'état des LLM locaux, les tendances de fond, et UNE chose à tester. Le profil qui guide cette sélection est dans `config/sources.json` → `profile`.

> ⚠️ **Les paliers gratuits ne suffisent pas au volume quotidien.** Un digest, c'est ~165 articles à noter, soit une dizaine d'appels avec le contenu complet. En septembre 2026, le quota Mistral épuisé et Gemini refusant les requêtes de taille réelle ont mis l'agent en mode dégradé pendant quatre jours, et le rattrapage a échoué deux fois pour la même raison. Une clé payante à petit budget sur **un seul** provider est le vrai correctif ; tout le reste est du contournement.

Tout tourne sur GitHub Actions (gratuit sur repo public), avec une **chaîne de fallback LLM** (Mistral → Groq → Gemini, tous gratuits) et Resend (gratuit). Si tous les LLM plantent, l'email est envoyé quand même en mode dégradé (articles bruts groupés par catégorie). Si même ça échoue, une issue GitHub est ouverte automatiquement → tu reçois un email natif GitHub.

Les données vivent dans ton repo.

## Setup (15 minutes)

### 1. Créer le repo

```bash
# Crée un nouveau repo GitHub (peut être privé ou public)
# Clone ce dossier dedans, puis :
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TON-USER/mon-agent-news.git
git push -u origin main
```

### 2. Récupérer les clés API gratuites

Tu peux configurer **1, 2 ou 3 providers LLM** — l'agent essaie chacun dans l'ordre Mistral → Groq → Gemini et utilise le premier qui répond. Plus tu en mets, plus tu es résilient. Le minimum c'est 1, le recommandé c'est les 3.

**Mistral API** (plan "Experiment" gratuit) :
- Va sur https://console.mistral.ai/
- Crée un compte (carte bancaire demandée pour vérification — rien n'est facturé tant que tu restes en plan Experiment)
- **API Keys → Create new key**, copie-la

**Groq** (free tier généreux, ~14 400 req/jour, pas de CB) :
- Va sur https://console.groq.com/
- Crée un compte (Google/GitHub)
- **API Keys → Create API Key**, copie-la

**Google Gemini** (1 500 req/jour gratuites, pas de CB) :
- Va sur https://aistudio.google.com/apikey
- Connecte-toi avec ton compte Google
- **Create API Key**, copie-la

**Resend** (3000 emails/mois gratuits) :
- Crée un compte sur https://resend.com
- Va dans "API Keys", crée une clé
- L'expéditeur par défaut `onboarding@resend.dev` fonctionne mais n'envoie qu'à ton propre email vérifié. Pour envoyer ailleurs, vérifie un domaine.

### 3. Configurer les secrets GitHub

Sur ton repo : **Settings → Secrets and variables → Actions → New repository secret**.

Ajoute ces secrets :

| Nom | Valeur |
|---|---|
| `MISTRAL_API_KEY` | ta clé Mistral *(optionnel si Groq ou Gemini présent)* |
| `GROQ_API_KEY` | ta clé Groq *(optionnel si Mistral ou Gemini présent)* |
| `GEMINI_API_KEY` | ta clé Gemini *(optionnel si Mistral ou Groq présent)* |
| `RESEND_API_KEY` | ta clé Resend |
| `EMAIL_TO` | ton email perso |
| `EMAIL_FROM` | `onboarding@resend.dev` (ou ton domaine vérifié) |

### 4. Tester en local (optionnel)

```bash
npm install
MISTRAL_API_KEY=xxx npm run collect
```

Tu devrais voir un nouveau fichier dans `data/articles/`.

### 5. Lancer manuellement la première fois

Sur GitHub : **Actions → Daily News Collection → Run workflow**.

Si ça passe au vert, le cron quotidien est opérationnel. Pareil pour `Biweekly Digest` quand tu veux tester l'email.

## Personnalisation

Tout est dans `config/sources.json` :

- **`sources`** : ajoute/enlève des flux RSS. Le format est simple : `name`, `url`, `category` (`tech`, `ia`, ou `geopolitique`).
- **`interests`** : la liste qui guide le LLM pour scorer les articles. Préfixe par `PRIORITAIRE` les sujets que tu veux voir remonter en priorité.
- **`profile`** : qui tu es et comment tu bosses — c'est ce qui oriente la sélection d'outils du bilan mensuel.
- **`minScore`** : seuil pour qu'un article soit gardé (7 par défaut, monte à 8 si trop de bruit, baisse à 6 si tu ne reçois rien).

Tu peux aussi ajuster dans `src/digest.ts` :
- `DIGEST_WINDOW_DAYS` (2 par défaut) : combien de jours d'articles le digest couvre.
- `DIGEST_TOP_N` (30 par défaut) : combien d'articles sont passés au LLM pour la synthèse. Seuls ces articles-là sont marqués comme envoyés dans `data/sent.json` : ceux qui n'ont pas tenu dans le top restent éligibles au digest du lendemain.

## Coûts

- GitHub Actions : **gratuit et illimité sur repo public** (sur repo privé, quota 2000 min/mois — le repo a été passé en public pour éviter de buter dessus)
- Mistral Small / Groq / Gemini : tous gratuits, largement suffisants pour cet usage
- Resend : gratuit (3000 emails/mois)

**Total : 0 €/mois** tant que tu restes dans les tiers gratuits, ce qui est très large pour cet usage.

## Fiabilité

L'agent est conçu pour ne jamais te laisser sans nouvelles :

1. **Chaîne de fallback LLM** : Mistral → Groq → Gemini. Chaque provider est retenté 3 fois avec backoff exponentiel (2s → 4s, en respectant l'en-tête `Retry-After`) sur les erreurs transitoires — 429 rate limit, 503 surcharge, timeout réseau. Si le retry ne suffit pas, l'agent bascule sur le suivant et met le provider en pause 5 min, pour ne pas repayer le backoff à chaque appel d'un run qui en enchaîne des dizaines (la pause est levée d'office si plus aucun autre provider ne répond). Une erreur définitive (clé révoquée, modèle retiré du catalogue) écarte le provider immédiatement et pour tout le reste du run, sans réessayer 28 fois pour rien.
2. **Mode dégradé** : si TOUS les LLM échouent, le digest est quand même envoyé avec les articles bruts groupés par catégorie (préfixé "⚠️ Digest dégradé").
3. **Timeouts + sortie explicite** : 60s par appel LLM, 20 min max par workflow, et `process.exit` en fin de script (des handles résiduels ont déjà suspendu un run jusqu'au timeout, perdant les articles du jour).
4. **Crons de rattrapage** : la collecte et le digest ont chacun un second cron quelques heures plus tard, qui ne fait rien si le premier a réussi (garde sur le fichier du jour / tracker `sent.json`) et prend le relais sinon. Couvre les crons sautés ou très retardés par GitHub.
5. **Retry d'envoi** : 3 tentatives espacées pour l'email Resend avant de déclarer l'échec.
6. **Notification d'échec** : si un workflow plante OU est annulé par timeout, ou si le digest constate que rien n'a été collecté depuis 2 jours, une issue GitHub est ouverte → GitHub t'envoie un email natif. Aucun mode de panne silencieux connu.
7. **Healthcheck LLM hebdomadaire** : chaque lundi, un workflow teste chaque provider individuellement (le fallback masque les pannes au quotidien) et alerte si une clé est morte, un quota épuisé, un modèle déprécié, ou s'il reste moins de 2 providers valides. L'alerte nomme l'action à faire (mettre à jour le nom du modèle, régénérer tel secret) plutôt que de lister les causes possibles.
8. **Escalade des pannes qui durent** : une panne récurrente renomme son issue GitHub avec le nombre d'échecs consécutifs et la date du premier (« — 7 échecs depuis le 2026-07-20 »). L'objet de l'email GitHub change donc à chaque fois, au lieu de se noyer dans un fil d'issue déjà lu.

> ⚠️ **Les identifiants de modèles périment.** `gemini-2.0-flash` a été retiré du catalogue Google en août 2026 : Gemini renvoyait 404 à chaque appel. Comme Groq n'avait pas de clé configurée, la chaîne reposait en réalité sur Mistral seul, et le premier rate limit Mistral a fait basculer le digest en mode dégradé pendant 4 jours. Le healthcheck l'avait signalé chaque lundi depuis le 20 juillet. **Quand le healthcheck passe au rouge, traite-le.** Les noms de modèles sont regroupés en haut de `src/llm.ts`.

## Structure

```
mon-agent-news/
├── .github/workflows/
│   ├── daily-collect.yml      # crons 03:37 + rattrapage 10:37 UTC
│   ├── daily-digest.yml       # crons 05:07 + rattrapage 08:07 UTC (mail ~8h Paris)
│   ├── monthly-digest.yml     # bilan mensuel le 1er du mois (rattrapage le 2)
│   ├── llm-healthcheck.yml    # test hebdo de chaque provider LLM (lundi 06:11)
│   ├── feed-healthcheck.yml   # test hebdo de chaque flux RSS (lundi 06:41)
│   ├── catchup-digest.yml     # rattrapage manuel des jours partis en mode dégradé
│   ├── send-digest.yml        # envoie par mail un digest déjà écrit (sans LLM)
│   └── notify-failure.yml     # ouvre une issue auto si un workflow échoue/timeout
├── src/
│   ├── llm.ts                 # chaîne fallback Mistral → Groq → Gemini + retry
│   ├── host-queue.ts          # sérialise les requêtes RSS par domaine
│   ├── feed-health.ts         # vérifie que chaque flux répond et date ses articles
│   ├── send-digest.ts         # envoi d'un digest existant, sans appel LLM
│   ├── digest-core.ts         # scoring et rédaction du digest (partagés)
│   ├── collect.ts             # collecte RSS + fetch contenu + scoring LLM
│   ├── digest.ts              # synthèse quotidienne + email (mode dégradé garanti)
│   ├── catchup.ts             # régénère les digests d'un jour passé + email
│   ├── monthly.ts             # bilan mensuel : outils du mois selon ton profil
│   └── email.ts               # rendu HTML des emails + envoi Resend avec retry
├── config/
│   └── sources.json           # tes flux + intérêts + profil
├── data/
│   ├── articles/              # JSON quotidiens (auto-commités)
│   ├── digests/               # MD quotidiens + monthly/ (auto-commités)
│   └── sent.json              # tracker URL → date d'envoi (anti-doublons, purge 60j)
└── package.json
```

## Sources et flux RSS

Les sources sont dans `config/sources.json`, réparties en trois catégories :
`ia`, `tech` et `business`. La catégorie `business` alimente la section
« 💰 Idées marché à saisir » du digest.

**Avant d'ajouter une source**, lance le workflow **Feed Health Check** : il
vérifie que chaque flux répond, parse, et surtout **date ses articles** — un
flux sans dates est inutilisable, puisque la collecte écarte tout article non
daté pour garantir la fraîcheur. Sans ce check, un flux mort ne se voyait pas :
`collect.ts` se contente d'un avertissement dans les logs et rend un tableau
vide, donc le digest s'appauvrit en silence.

⚠️ **Reddit : un seul flux, pas deux.** Depuis les IP des runners GitHub,
Reddit ne laisse passer qu'une requête par run et renvoie 429 aux suivantes,
quel que soit l'espacement entre elles — c'est un quota par IP, pas une limite
de débit. Le créneau est occupé par `r/LocalLLaMA`. En ajouter un second rend
le healthcheck rouge chaque semaine et laisse une source muette.

Les requêtes sont sérialisées par domaine (`src/host-queue.ts`) : parallèle
entre hôtes, séquentiel à l'intérieur d'un hôte avec 5 s d'écart. Utile pour
`hnrss.org`, qui sert trois flux.

## Envoyer un digest déjà écrit

Si un digest existe dans `data/digests/<jour>.md` et qu'il ne reste qu'à le
livrer — chaîne LLM à court de quota, digest rédigé à la main, renvoi demandé —
le workflow **Send Digest** l'envoie **sans appeler aucun provider** :

```
2026-09-04 2026-09-05
```

Tous les fichiers sont lus avant le premier envoi : si un jour manque, la
commande échoue sans qu'aucun mail ne soit parti. L'outil ne touche pas à
`data/sent.json` et n'a aucune protection contre le double envoi.

## Rattraper des jours partis en mode dégradé

Si la chaîne LLM tombe, le digest part quand même mais en mode dégradé : articles
bruts, sans notation ni résumé. Les articles restent stockés dans
`data/articles/` — rien n'est perdu, ils n'ont juste jamais été résumés.

Une fois la cause corrigée (vérifier d'abord avec le workflow **LLM Health
Check**), lance le workflow **Catch-up Digest** depuis l'onglet Actions, en
passant les jours à rattraper séparés par des espaces :

```
2026-09-04 2026-09-05 2026-09-06 2026-09-07
```

Pour chaque jour, il note et résume les articles, réécrit
`data/articles/<jour>.json` avec les scores, envoie un mail
« 📰 Digest (rattrapage) — <jour> » et remplace `data/digests/<jour>-degraded.md`
par un `<jour>.md` propre (sans ça, le bilan mensuel compterait le jour deux fois).

Les articles de ces jours-là avaient été marqués « envoyés » dans `sent.json`
sans l'avoir été : le rattrapage libère ces entrées avant de commencer, puis ne
remarque que ce qui part réellement. La déduplication reste active **entre** les
jours rattrapés. Si la chaîne LLM est toujours en panne, le rattrapage s'arrête
au premier jour au lieu d'envoyer un second digest dégradé.

En local :

```bash
MISTRAL_API_KEY=xxx RESEND_API_KEY=xxx EMAIL_TO=toi@exemple.fr \
  npm run catchup -- 2026-09-04 2026-09-05
```

## Améliorations possibles plus tard

- Détection de doublons inter-sources (un même sujet couvert par 3 médias = 1 entrée)
- Catégorisation automatique plus fine
- Mode "breaking news" : alerte immédiate si score ≥ 9
- Interface web statique (GitHub Pages) pour browser les digests passés
