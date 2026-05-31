# 📰 Mon Agent News

Agent IA autonome de veille tech/IA/géopolitique. 100% gratuit, t'appartient entièrement.

## Ce qu'il fait

- **Chaque matin** : récupère les nouveaux articles depuis 17 flux RSS (Tech/IA/dev + actu générale/géopolitique), télécharge leur contenu complet, demande à un LLM de noter leur pertinence selon tes intérêts, garde ceux ≥ 7/10.
- **Mercredi et dimanche soir** : compile les articles des 4 derniers jours, génère un compte-rendu structuré (IA & opportunités, tech & industrie, contexte mondial, 3 actions concrètes), te l'envoie par email.

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
- **`interests`** : la liste qui guide Mistral pour scorer les articles. Préfixe par `PRIORITAIRE` les sujets que tu veux voir remonter en priorité.
- **`minScore`** : seuil pour qu'un article soit gardé (7 par défaut, monte à 8 si trop de bruit, baisse à 6 si tu ne reçois rien).

Tu peux aussi ajuster dans `src/digest.ts` :
- `DIGEST_WINDOW_DAYS` (4 par défaut) : combien de jours d'articles le digest couvre.
- `DIGEST_TOP_N` (50 par défaut) : combien d'articles sont passés à Mistral pour la synthèse.

## Coûts

- GitHub Actions : **gratuit et illimité sur repo public** (sur repo privé, quota 2000 min/mois — le repo a été passé en public pour éviter de buter dessus)
- Mistral Small / Groq / Gemini : tous gratuits, largement suffisants pour cet usage
- Resend : gratuit (3000 emails/mois)

**Total : 0 €/mois** tant que tu restes dans les tiers gratuits, ce qui est très large pour cet usage.

## Fiabilité

L'agent est conçu pour ne jamais te laisser sans nouvelles :

1. **Chaîne de fallback LLM** : Mistral → Groq → Gemini. Si l'un est en panne/quota, l'agent bascule automatiquement.
2. **Mode dégradé** : si TOUS les LLM échouent, le digest est quand même envoyé avec les articles bruts groupés par catégorie (préfixé "⚠️ Digest dégradé").
3. **Timeouts** : 60s par appel LLM, 15 min max par workflow (filet de sécurité contre les blocages réseau).
4. **Notification d'échec** : si un workflow plante entièrement, une issue GitHub est ouverte → GitHub t'envoie un email natif. Tu sais qu'il y a un truc à regarder.

## Structure

```
mon-agent-news/
├── .github/workflows/
│   ├── daily-collect.yml      # cron quotidien 07:00 UTC
│   ├── biweekly-digest.yml    # cron mercredi + dimanche 18:00 UTC
│   └── notify-failure.yml     # ouvre une issue auto si un workflow échoue
├── src/
│   ├── llm.ts                 # chaîne fallback Mistral → Groq → Gemini
│   ├── collect.ts             # collecte RSS + fetch contenu + scoring LLM
│   └── digest.ts              # synthèse 2x/semaine + email (mode dégradé garanti)
├── config/
│   └── sources.json           # tes flux + intérêts
├── data/
│   ├── articles/              # JSON quotidiens (auto-commités)
│   └── digests/               # MD bi-hebdo (auto-commités)
└── package.json
```

## Améliorations possibles plus tard

- Détection de doublons inter-sources (un même sujet couvert par 3 médias = 1 entrée)
- Catégorisation automatique plus fine
- Mode "breaking news" : alerte immédiate si score ≥ 9
- Interface web statique (GitHub Pages) pour browser les digests passés
