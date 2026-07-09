import { readFile } from "node:fs/promises";
import { z } from "zod";
import { InboundSchema, type Inbound, type TriageRecord } from "./schema.js";
import { DEFAULT_MODELS, type ProviderName } from "./providers/index.js";

/** Minimal `--flag=value` / `--flag` parser (no dependency needed). */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.slice(2).split("=");
    out[k] = v === undefined ? true : v;
  }
  return out;
}

const PROVIDERS = ["openai", "groq", "gemini"] as const;

export function resolveProviderName(raw: string | undefined): ProviderName {
  const name = (raw ?? process.env.TRIAGE_PROVIDER ?? "openai").toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(name)) {
    throw new Error(`Unknown provider "${name}". Use one of: ${PROVIDERS.join(", ")}.`);
  }
  return name as ProviderName;
}

export function resolveModel(raw: string | undefined, provider: ProviderName): string {
  // Explicit --model always wins.
  if (raw) return raw;
  // TRIAGE_MODEL is paired with TRIAGE_PROVIDER — it must NOT leak onto a
  // different provider chosen via --provider (e.g. gpt-4o-mini on Groq). Only
  // honour it when we're actually running the env's default provider.
  const envProvider = (process.env.TRIAGE_PROVIDER ?? "openai").toLowerCase();
  if (process.env.TRIAGE_MODEL && provider === envProvider) return process.env.TRIAGE_MODEL;
  return DEFAULT_MODELS[provider];
}

export async function loadSamples(path: string): Promise<Inbound[]> {
  const raw = await readFile(path, "utf8");
  return z.array(InboundSchema).parse(JSON.parse(raw));
}

/** Compact console table so a human can eyeball results without opening files. */
export function printSummary(records: TriageRecord[]): void {
  console.log("\n─────────────────────────────────────────────────────────────────────");
  for (const r of records) {
    const flag = r.escalation.flagged ? "  ⚑ ESCALATED" : "";
    console.log(
      `${r.id}  ${r.classification.category.padEnd(18)} ${r.classification.priority.padEnd(6)} ` +
        `conf=${r.classification.confidence.toFixed(2)}  → ${r.routing.final_destination}${flag}`,
    );
    if (r.escalation.flagged) {
      for (const reason of r.escalation.reasons) console.log(`        ↳ ${reason}`);
    }
  }
  const escalated = records.filter((r) => r.escalation.flagged).length;
  console.log("─────────────────────────────────────────────────────────────────────");
  console.log(`${records.length} processed · ${escalated} escalated · ${records.length - escalated} auto-routed\n`);
}
