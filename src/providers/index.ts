import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { GeminiProvider } from "./gemini.js";
import type { LLMProvider, ProviderName } from "./types.js";

export type { LLMProvider, ProviderName } from "./types.js";
export { parseLlmOutput } from "./types.js";

/** Sensible, cheap, current defaults. Override with --model or TRIAGE_MODEL. */
export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o-mini",
  groq: "llama-3.3-70b-versatile",
  gemini: "gemini-2.5-flash",
};

const ENV_KEY: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
};

function requireKey(name: ProviderName): string {
  const envVar = ENV_KEY[name];
  const key = process.env[envVar];
  if (!key) {
    throw new Error(
      `Missing ${envVar}. Set it in .env to use the "${name}" provider ` +
        `(see .env.example).`,
    );
  }
  return key;
}

/** Build a provider by name, reading its key from the environment. */
export function getProvider(name: ProviderName, model?: string): LLMProvider {
  const chosenModel = model ?? DEFAULT_MODELS[name];
  switch (name) {
    case "openai":
      return new OpenAICompatibleProvider({
        name: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: requireKey("openai"),
        model: chosenModel,
      });
    case "groq":
      return new OpenAICompatibleProvider({
        name: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: requireKey("groq"),
        model: chosenModel,
      });
    case "gemini":
      return new GeminiProvider({ apiKey: requireKey("gemini"), model: chosenModel });
    default:
      throw new Error(`Unknown provider: ${name as string}`);
  }
}

/** Which providers have a key configured right now (used by compare mode). */
export function availableProviders(): ProviderName[] {
  return (Object.keys(ENV_KEY) as ProviderName[]).filter((p) => !!process.env[ENV_KEY[p]]);
}
