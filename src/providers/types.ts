import { LlmOutputSchema, type LlmOutput } from "../schema.js";

export type ProviderName = "openai" | "groq" | "gemini";

export interface ChatArgs {
  system: string;
  user: string;
  /** Sampling temperature. Low by default — triage should be near-deterministic. */
  temperature?: number;
}

/**
 * A provider is anything that can turn (system, user) prompts into raw text,
 * where we've asked for JSON. Keeping the interface this small is the whole
 * point: adding a fourth provider is ~30 lines, and nothing downstream changes.
 */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** Return the model's raw text response (expected to be a JSON object string). */
  complete(args: ChatArgs): Promise<string>;
}

/** Strip accidental ```json fences some models add despite instructions. */
export function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  return t;
}

/**
 * Parse + validate a provider response into LlmOutput. Throws on failure so the
 * caller can retry once. Zod's coercion/defaults absorb minor shape drift
 * (e.g. a missing `other` array) without a second round-trip.
 */
export function parseLlmOutput(raw: string): LlmOutput {
  const cleaned = stripFences(raw);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Response was not valid JSON: ${(e as Error).message}\n---\n${cleaned.slice(0, 500)}`);
  }
  return LlmOutputSchema.parse(json);
}
