// Healthcheck hebdomadaire de la chaîne LLM.
// Teste chaque provider individuellement (le fallback de callLLM masque les
// pannes : tant qu'un provider répond, on ne voit pas que les autres sont
// morts). Détecte les clés invalides, quotas épuisés et modèles dépréciés
// AVANT que le dernier provider de la chaîne ne tombe à son tour.
//
// Échoue (exit 1) si : un provider configuré ne répond pas, ou s'il reste
// moins de 2 providers configurés (chaîne de fallback trop fragile).
// L'échec du workflow déclenche notify-failure → issue GitHub → email.

import { PROVIDERS } from "./llm.js";

async function main() {
  const failures: string[] = [];
  const missing: string[] = [];

  for (const { name, call, configured } of PROVIDERS) {
    if (!configured) {
      console.warn(`${name}: clé API absente — provider hors de la chaîne de fallback`);
      missing.push(name);
      continue;
    }
    try {
      await call({ prompt: "Réponds uniquement par le mot : OK", timeoutMs: 30_000 });
      console.log(`${name}: OK`);
    } catch (err) {
      console.error(`${name}: ÉCHEC — ${(err as Error).message}`);
      failures.push(name);
    }
  }

  const healthy = PROVIDERS.length - missing.length - failures.length;
  console.log(`Bilan : ${healthy}/${PROVIDERS.length} provider(s) opérationnel(s)`);

  if (failures.length > 0) {
    console.error(
      `Provider(s) configuré(s) mais en panne : ${failures.join(", ")} — clé révoquée, quota épuisé ou modèle déprécié ?`
    );
    process.exit(1);
  }
  if (healthy < 2) {
    console.error(
      `Moins de 2 providers opérationnels (absents : ${missing.join(", ") || "aucun"}) — la chaîne de fallback est trop fragile, ajouter une clé.`
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
