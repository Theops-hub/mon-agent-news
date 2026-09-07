// Fallback chain : Mistral → Groq → Gemini
// L'objectif est qu'au moins un provider réponde, même si les autres sont down/quota.
//
// Deux niveaux de résilience, appris de la panne du 4 au 7 septembre 2026 où la
// chaîne entière est tombée et le digest est passé en mode dégradé 4 jours :
//  1. Retry avec backoff exponentiel À L'INTÉRIEUR d'un provider, pour les
//     erreurs transitoires (429 rate limit, 503 surcharge, timeout réseau).
//     Sans ça, un simple pic de charge chez Mistral suffisait à faire tomber la
//     chaîne — alors qu'une seconde tentative aurait suffi.
//  2. Bascule vers le provider suivant si le retry n'a rien donné — ou
//     immédiatement, sans perdre de temps, si l'erreur est définitive
//     (clé révoquée, modèle retiré du catalogue).

type LLMOptions = {
  prompt: string;
  jsonMode?: boolean;
  temperature?: number;
  timeoutMs?: number;
};

export type ProviderName = "mistral" | "groq" | "gemini";

export type LLMResult = {
  text: string;
  provider: ProviderName;
};

const DEFAULT_TIMEOUT_MS = 60_000;

// Retry : 3 tentatives par provider, backoff 2s → 4s, plafonné à 60s.
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
// Un 429 se traite différemment d'un 503 : les quotas gratuits se comptent par
// MINUTE, donc attendre 2s puis 4s ne sert à rien — il faut laisser la fenêtre
// se vider. Le rattrapage du 7 septembre 2026 l'a appris à ses dépens : il
// saturait Gemini, repartait trop vite, et re-saturait aussitôt.
const RATE_LIMIT_BACKOFF_BASE_MS = 20_000;

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Modèles : le plus gros gratuit disponible chez chaque provider.
// ⚠️ Ces identifiants périment. Le healthcheck hebdomadaire (llm-healthcheck.yml)
// est là pour signaler un modèle retiré — gemini-2.0-flash l'a été en août 2026
// et l'agent a mis 6 semaines à s'en apercevoir.
const MISTRAL_MODEL = "mistral-small-latest";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GEMINI_MODEL = "gemini-3.6-flash";

// Erreur HTTP d'un provider, avec le statut conservé : c'est lui qui décide si
// on retente (transitoire) ou si on bascule tout de suite (définitif).
export class LLMHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "LLMHttpError";
  }
}

// Erreur définitive : réessayer ne changera rien. Requête malformée (400),
// clé invalide ou révoquée (401/403), modèle absent du catalogue (404).
// Tout le reste — 429, 5xx, coupure réseau, timeout — est traité comme transitoire.
function isPermanent(err: unknown): boolean {
  return err instanceof LLMHttpError && [400, 401, 403, 404].includes(err.status);
}

// En-tête Retry-After : soit un nombre de secondes, soit une date HTTP.
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = new Date(header).getTime();
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Le serveur sait mieux que nous quand revenir : Retry-After prime sur le
// backoff calculé, mais reste plafonné pour ne pas manger le budget du workflow.
// Le jitter évite que tous les batches se resynchronisent sur la même fenêtre de quota.
function backoffMs(attempt: number, err: unknown): number {
  const isRateLimit = err instanceof LLMHttpError && err.status === 429;
  const base = isRateLimit ? RATE_LIMIT_BACKOFF_BASE_MS : BACKOFF_BASE_MS;
  const exponential = Math.min(base * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  const retryAfterMs = err instanceof LLMHttpError ? err.retryAfterMs : undefined;
  const wait = retryAfterMs === undefined ? exponential : Math.min(retryAfterMs, BACKOFF_CAP_MS);
  return wait + Math.floor(Math.random() * 500);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
  const errText = await res.text().catch(() => "");
  throw new LLMHttpError(
    `HTTP ${res.status}: ${errText.slice(0, 300)}`,
    res.status,
    parseRetryAfter(res.headers.get("retry-after"))
  );
}

// Mistral & Groq exposent une API OpenAI-compatible. On utilise fetch direct
// pour contrôler le timeout (les SDK n'ont pas de timeout configurable simple).
async function callOpenAICompatible(
  url: string,
  apiKey: string,
  model: string,
  opts: LLMOptions
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: opts.prompt }],
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  await assertOk(res);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Réponse vide");
  return text;
}

async function callMistral(opts: LLMOptions): Promise<string> {
  if (!MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY absent");
  return callOpenAICompatible(
    "https://api.mistral.ai/v1/chat/completions",
    MISTRAL_API_KEY,
    MISTRAL_MODEL,
    opts
  );
}

async function callGroq(opts: LLMOptions): Promise<string> {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY absent");
  return callOpenAICompatible(
    "https://api.groq.com/openai/v1/chat/completions",
    GROQ_API_KEY,
    GROQ_MODEL,
    opts
  );
}

async function callGemini(opts: LLMOptions): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY absent");

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      ...(opts.jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  await assertOk(res);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Réponse vide");
  return text;
}

export type ProviderDef = {
  name: ProviderName;
  model: string;
  call: (opts: LLMOptions) => Promise<string>;
  configured: boolean;
};

// Exporté pour le healthcheck hebdomadaire (src/llm-health.ts), qui teste
// chaque provider individuellement pour détecter clés mortes et modèles dépréciés.
export const PROVIDERS: ProviderDef[] = [
  { name: "mistral", model: MISTRAL_MODEL, call: callMistral, configured: Boolean(MISTRAL_API_KEY) },
  { name: "groq", model: GROQ_MODEL, call: callGroq, configured: Boolean(GROQ_API_KEY) },
  { name: "gemini", model: GEMINI_MODEL, call: callGemini, configured: Boolean(GEMINI_API_KEY) },
];

// Un provider, avec retry sur les erreurs transitoires. Exporté pour que le
// healthcheck teste dans les mêmes conditions que la production : un 503
// passager ne doit pas être signalé comme une panne de provider.
export async function callProvider(
  provider: ProviderDef,
  opts: LLMOptions,
  maxAttempts = MAX_ATTEMPTS
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await provider.call(opts);
    } catch (err) {
      lastError = err;
      if (isPermanent(err)) throw err;
      if (attempt === maxAttempts) break;
      const wait = backoffMs(attempt, err);
      console.warn(
        `${provider.name} : échec transitoire (${(err as Error).message.slice(0, 120)}) — ` +
          `nouvelle tentative dans ${Math.round(wait / 1000)}s [${attempt}/${maxAttempts - 1}]`
      );
      await sleep(wait);
    }
  }
  throw lastError;
}

// Providers écartés pour la durée du process après une erreur définitive.
// La collecte enchaîne ~28 batches : sans ça, chaque batch refaisait un
// aller-retour vers un modèle retiré avant de basculer. Réinitialisé à chaque run.
const disabled = new Map<ProviderName, string>();

// Provider en pause après avoir épuisé son budget de retry sur une erreur
// transitoire : inutile de repayer le backoff à chaque appel d'un run qui en
// enchaîne des dizaines. 60 s et pas plus — les quotas gratuits se comptent
// par minute, donc un provider rate-limité redevient utilisable très vite, et
// une pause trop longue écarterait à tort le seul provider qui fonctionne.
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const cooldownUntil = new Map<ProviderName, number>();

// Essaie chaque provider dans l'ordre. Le premier qui répond gagne.
export async function callLLM(opts: LLMOptions): Promise<LLMResult> {
  const errors: string[] = [];
  let skippedByCooldown = 0;

  const tryChain = async (respectCooldown: boolean): Promise<LLMResult | null> => {
    for (const provider of PROVIDERS) {
      const { name } = provider;

      if (!provider.configured) {
        if (respectCooldown) errors.push(`${name}: clé API absente`);
        continue;
      }
      const reason = disabled.get(name);
      if (reason) {
        if (respectCooldown) errors.push(`${name}: écarté pour ce run (${reason})`);
        continue;
      }
      const pausedUntil = cooldownUntil.get(name) ?? 0;
      if (respectCooldown && Date.now() < pausedUntil) {
        errors.push(
          `${name}: en pause encore ${Math.ceil((pausedUntil - Date.now()) / 1000)}s (échec récent)`
        );
        skippedByCooldown++;
        continue;
      }

      try {
        const text = await callProvider(provider, opts);
        cooldownUntil.delete(name); // il répond de nouveau
        if (errors.length > 0) {
          console.warn(`LLM fallback réussi avec ${name} après échecs : ${errors.join(" | ")}`);
        }
        return { text, provider: name };
      } catch (err) {
        const msg = `${name}: ${(err as Error).message}`;
        console.warn(`LLM ${name} a échoué — ${msg}`);
        if (isPermanent(err)) {
          const status = (err as LLMHttpError).status;
          disabled.set(name, `HTTP ${status}`);
          console.error(
            `LLM ${name} écarté pour la suite du run (erreur définitive HTTP ${status}) — ` +
              `vérifier la clé API ou le nom du modèle « ${provider.model} » dans src/llm.ts.`
          );
        } else {
          cooldownUntil.set(name, Date.now() + RATE_LIMIT_COOLDOWN_MS);
          console.warn(
            `LLM ${name} mis en pause ${RATE_LIMIT_COOLDOWN_MS / 1000}s après épuisement des tentatives.`
          );
        }
        errors.push(msg);
      }
    }
    return null;
  };

  const result = await tryChain(true);
  if (result) return result;

  // La chaîne a échoué alors que des providers n'ont même pas été essayés, au
  // seul motif qu'ils étaient en pause. Ne jamais abandonner sans les avoir
  // tentés : la pause est une optimisation, pas un verdict.
  if (skippedByCooldown > 0) {
    console.warn(
      `Chaîne en échec avec ${skippedByCooldown} provider(s) en pause — nouvelle passe sans tenir compte des pauses.`
    );
    const retried = await tryChain(false);
    if (retried) return retried;
  }

  throw new Error(`Tous les providers LLM ont échoué : ${errors.join(" | ")}`);
}
