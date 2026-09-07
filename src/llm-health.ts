// Healthcheck hebdomadaire de la chaîne LLM.
// Teste chaque provider individuellement (le fallback de callLLM masque les
// pannes : tant qu'un provider répond, on ne voit pas que les autres sont
// morts). Détecte les clés invalides, quotas épuisés et modèles dépréciés
// AVANT que le dernier provider de la chaîne ne tombe à son tour.
//
// Échoue (exit 1) si : un provider configuré ne répond pas, ou s'il reste
// moins de 2 providers configurés (chaîne de fallback trop fragile).
// L'échec du workflow déclenche notify-failure → issue GitHub → email.

import { PROVIDERS, callProvider, LLMHttpError } from "./llm.js";

// Comme en production, un 503 passager ne doit pas être signalé comme une panne :
// 2 tentatives suffisent à distinguer le hoquet de la panne réelle.
const HEALTH_ATTEMPTS = 2;

// Traduit le statut HTTP en action concrète : sans ça, l'alerte hebdomadaire
// disait « clé révoquée, quota épuisé ou modèle déprécié ? » sans trancher, et
// le 404 de gemini-2.0-flash est resté 6 semaines sans être traité.
function diagnose(name: string, model: string, err: unknown): string {
  if (!(err instanceof LLMHttpError)) {
    return `${name} : injoignable (${(err as Error).message}) — panne réseau ou API down ?`;
  }
  switch (err.status) {
    case 404:
      return `${name} : le modèle « ${model} » n'existe plus côté provider — ACTION : mettre à jour la constante dans src/llm.ts.`;
    case 401:
    case 403:
      return `${name} : clé API refusée (HTTP ${err.status}) — ACTION : régénérer le secret ${name.toUpperCase()}_API_KEY.`;
    case 429:
      return `${name} : quota ou rate limit épuisé (HTTP 429) — ACTION : vérifier le plan, ou accepter que ce provider ne serve que de secours.`;
    default:
      return `${name} : HTTP ${err.status} persistant après ${HEALTH_ATTEMPTS} tentatives — ${err.message.slice(0, 200)}`;
  }
}

async function main() {
  const diagnostics: string[] = [];
  const failures: string[] = [];
  const missing: string[] = [];

  for (const provider of PROVIDERS) {
    const { name, model, configured } = provider;
    if (!configured) {
      console.warn(`${name}: clé API absente — provider hors de la chaîne de fallback`);
      missing.push(name);
      continue;
    }
    try {
      await callProvider(
        provider,
        { prompt: "Réponds uniquement par le mot : OK", timeoutMs: 30_000 },
        HEALTH_ATTEMPTS
      );
      console.log(`${name}: OK (modèle ${model})`);
    } catch (err) {
      console.error(`${name}: ÉCHEC — ${(err as Error).message}`);
      diagnostics.push(diagnose(name, model, err));
      failures.push(name);
    }
  }

  const healthy = PROVIDERS.length - missing.length - failures.length;
  console.log(`Bilan : ${healthy}/${PROVIDERS.length} provider(s) opérationnel(s)`);

  if (failures.length > 0) {
    console.error(`\nProvider(s) configuré(s) mais en panne : ${failures.join(", ")}`);
    for (const d of diagnostics) console.error(`  → ${d}`);
    process.exit(1);
  }
  if (healthy < 2) {
    console.error(
      `\nMoins de 2 providers opérationnels (absents : ${missing.join(", ") || "aucun"}) — ` +
        `la chaîne de fallback est trop fragile.\n` +
        `  → ACTION : ajouter un secret ${missing.map((m) => `${m.toUpperCase()}_API_KEY`).join(" ou ")} dans les settings du repo.`
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
