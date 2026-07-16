// Fallback chain : Mistral → Groq → Gemini
// L'objectif est qu'au moins un provider réponde, même si les autres sont down/quota.

type LLMOptions = {
  prompt: string;
  jsonMode?: boolean;
  temperature?: number;
  timeoutMs?: number;
};

export type LLMResult = {
  text: string;
  provider: "mistral" | "groq" | "gemini";
};

const DEFAULT_TIMEOUT_MS = 60_000;

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Modèles : le plus gros gratuit disponible chez chaque provider
const MISTRAL_MODEL = "mistral-small-latest";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GEMINI_MODEL = "gemini-2.0-flash";

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

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
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

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Réponse vide");
  return text;
}

type Provider = LLMResult["provider"];
// Exporté pour le healthcheck hebdomadaire (src/llm-health.ts), qui teste
// chaque provider individuellement pour détecter clés mortes et modèles dépréciés.
export const PROVIDERS: {
  name: Provider;
  call: (opts: LLMOptions) => Promise<string>;
  configured: boolean;
}[] = [
  { name: "mistral", call: callMistral, configured: Boolean(MISTRAL_API_KEY) },
  { name: "groq", call: callGroq, configured: Boolean(GROQ_API_KEY) },
  { name: "gemini", call: callGemini, configured: Boolean(GEMINI_API_KEY) },
];

// Essaie chaque provider dans l'ordre. Le premier qui répond gagne.
export async function callLLM(opts: LLMOptions): Promise<LLMResult> {
  const errors: string[] = [];
  for (const { name, call } of PROVIDERS) {
    try {
      const text = await call(opts);
      if (errors.length > 0) {
        console.warn(`LLM fallback réussi avec ${name} après échecs : ${errors.join(" | ")}`);
      }
      return { text, provider: name };
    } catch (err) {
      const msg = `${name}: ${(err as Error).message}`;
      console.warn(`LLM ${name} a échoué — ${msg}`);
      errors.push(msg);
    }
  }
  throw new Error(`Tous les providers LLM ont échoué : ${errors.join(" | ")}`);
}
