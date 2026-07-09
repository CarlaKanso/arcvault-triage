import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts/triage.prompt.js";
import { decide } from "./pipeline/decide.js";
import { parseLlmOutput, type LLMProvider } from "./providers/index.js";
import type { Inbound, LlmOutput, TriageRecord } from "./schema.js";

const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Transient provider failures worth waiting out: rate limits (free tiers cap
 *  requests per minute) and temporary unavailability / overload. */
function isTransient(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return (
    /HTTP (408|409|425|429|500|502|503|529)\b/.test(m) ||
    /RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|overloaded|rate.?limit|quota/i.test(m)
  );
}

/** How long to wait before retrying a transient error. Honours a provider's
 *  "retry in Ns" hint (Gemini/Groq send one) when present, else exponential
 *  backoff, capped so a single message never stalls the batch too long. */
function backoffMs(err: unknown, attempt: number): number {
  const m = err instanceof Error ? err.message : String(err);
  const hint = m.match(/retry in ([\d.]+)\s*s/i);
  if (hint) return Math.min(Math.ceil(parseFloat(hint[1]) * 1000) + 500, 30_000);
  return Math.min(1000 * 2 ** (attempt - 1), 8_000); // 1s → 2s → 4s → 8s
}

/**
 * Ask the model, tolerating bad responses and free-tier rate limits. Two kinds
 * of failure get two treatments: malformed JSON is retried immediately with a
 * firmer nudge; a rate-limit / temporary-unavailability error is retried after a
 * backoff wait (respecting the provider's "retry in Ns" hint). If it still fails
 * after MAX_ATTEMPTS, we throw so the caller records the failure rather than
 * silently dropping a customer message.
 */
async function classifyAndEnrich(provider: LLMProvider, msg: Inbound): Promise<LlmOutput> {
  const user = buildUserPrompt(msg);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const system =
        attempt === 1
          ? SYSTEM_PROMPT
          : SYSTEM_PROMPT + "\n\nIMPORTANT: your previous reply was not valid. Return ONLY the JSON object, all keys present.";
      const raw = await provider.complete({ system, user });
      return parseLlmOutput(raw);
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_ATTEMPTS) break;
      // Rate-limited / temporarily down → wait it out. Malformed output → retry now.
      if (isTransient(err)) await sleep(backoffMs(err, attempt));
    }
  }
  throw new Error(
    `Triage failed for ${msg.id} after ${MAX_ATTEMPTS} attempts (${provider.name}/${provider.model}): ${(lastErr as Error).message}`,
  );
}

/** Run one message through Steps 2-6 and assemble the final record. */
export async function triageOne(provider: LLMProvider, msg: Inbound): Promise<TriageRecord> {
  const llm = await classifyAndEnrich(provider, msg);

  const { routing, escalation } = decide({
    category: llm.category,
    confidence: llm.confidence,
    raw_message: msg.raw_message,
    amount: llm.identifiers.amount,
    expected_amount: llm.identifiers.expected_amount,
  });

  return {
    id: msg.id,
    source: msg.source,
    received_at: msg.received_at,
    raw_message: msg.raw_message,
    classification: {
      category: llm.category,
      priority: llm.priority,
      confidence: llm.confidence,
    },
    enrichment: {
      core_issue: llm.core_issue,
      identifiers: llm.identifiers,
      urgency_signal: llm.urgency_signal,
    },
    routing,
    escalation,
    summary: llm.summary,
    model: { provider: provider.name, model: provider.model },
  };
}
