# 📰 Mon Agent News

Agent IA autonome de veille hebdomadaire. 100% gratuit, t'appartient entièrement.

## Ce qu'il fait

- **Chaque matin** : récupère les nouveaux articles depuis ~18 flux RSS (Tech/IA/dev + actu générale/géopolitique + Reddit), télécharge leur contenu complet, demande à Mistral Small de noter leur pertinence selon tes intérêts, garde ceux ≥ 7/10.
- **Chaque dimanche soir** : compile les articles de la semaine, génère un compte-rendu structuré par thème, te l'envoie par email.

Tout tourne sur GitHub Actions (gratuit), avec Mistral Small (tier gratuit), Resend (gratuit). Les données vivent dans ton repo.

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

**Mistral API** (plan "Experiment" gratuit) :
- Va sur https://console.mistral.ai/
- Crée un compte (carte bancaire demandée pour vérification — rien n'est facturé tant que tu restes en plan Experiment)
- **API Keys → Create new key**, copie-la

**Resend** (3000 emails/mois gratuits) :
- Crée un compte sur https://resend.com
- Va dans "API Keys", crée une clé
- L'expéditeur par défaut `onboarding@resend.dev` fonctionne mais n'envoie qu'à ton propre email vérifié. Pour envoyer ailleurs, vérifie un domaine.

### 3. Configurer les secrets GitHub

Sur ton repo : **Settings → Secrets and variables → Actions → New repository secret**.

Ajoute ces secrets :

| Nom | Valeur |
|---|---|
| `MISTRAL_API_KEY` | ta clé Mistral |
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

Si ça passe au vert, le cron quotidien est opérationnel. Pareil pour `Weekly Digest` quand tu veux tester l'email.

## Personnalisation

Tout est dans `config/sources.json` :

- **`sources`** : ajoute/enlève des flux RSS (y compris des subreddits via leur flux `.rss`). Le format est simple : `name`, `url`, `category`.
- **`interests`** : la liste qui guide Mistral pour scorer les articles. Plus c'est précis, mieux c'est.
- **`minScore`** : seuil pour qu'un article soit gardé (7 par défaut, monte à 8 si trop de bruit, baisse à 6 si tu ne reçois rien).

## Coûts

- GitHub Actions : gratuit (largement sous les quotas)
- Mistral Small : gratuit (plan "Experiment", largement suffisant pour cet usage)
- Resend : gratuit (3000 emails/mois)

**Total : 0 €/mois** tant que tu restes dans les tiers gratuits, ce qui est très large pour cet usage.

## Structure

```
mon-agent-news/
├── .github/workflows/
│   ├── daily-collect.yml   # cron quotidien 07:00 UTC
│   └── weekly-digest.yml   # cron hebdo dimanche 18:00 UTC
├── src/
│   ├── collect.ts          # collecte RSS + fetch contenu + scoring Mistral
│   └── digest.ts           # synthèse hebdo (Mistral) + email
├── config/
│   └── sources.json        # tes flux + intérêts
├── data/
│   ├── articles/           # JSON quotidiens (auto-commités)
│   └── digests/            # MD hebdomadaires (auto-commités)
└── package.json
```

## Améliorations possibles plus tard

- Détection de doublons inter-sources (un même sujet couvert par 3 médias = 1 entrée)
- Catégorisation automatique plus fine
- Mode "breaking news" : alerte immédiate si score ≥ 9
- Interface web statique (GitHub Pages) pour browser les digests passés
