import { z } from "zod";

/**
 * Schema definitions for the triage pipeline.
 *
 * `LlmOutput` is what we ask the LLM to return (Steps 2-3 + the human summary).
 * `TriageRecord` is the final persisted record: LLM output + deterministic
 * routing/escalation (Steps 4 & 6) + provenance. Keeping these separate makes
 * the boundary explicit — the model fills the first, our code fills the rest.
 */

export const CATEGORIES = [
  "Bug Report",
  "Feature Request",
  "Billing Issue",
  "Technical Question",
  "Incident/Outage",
] as const;

export const PRIORITIES = ["Low", "Medium", "High"] as const;

export const QUEUES = [
  "Engineering",
  "Product",
  "Billing",
  "IT/Security",
  "Escalation",
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Queue = (typeof QUEUES)[number];

/** Structured identifiers pulled from the message (Step 3 — Enrichment). */
export const IdentifiersSchema = z.object({
  account: z.string().nullable().default(null),
  invoice_number: z.string().nullable().default(null),
  error_code: z.string().nullable().default(null),
  /** The charge/amount in dispute or referenced, if any (numeric, no currency symbol). */
  amount: z.number().nullable().default(null),
  /** The amount the customer says they expected (e.g. contract rate), if any. */
  expected_amount: z.number().nullable().default(null),
  /** Any other identifiers worth surfacing (order IDs, ticket refs, etc.). */
  other: z.array(z.string()).default([]),
});
export type Identifiers = z.infer<typeof IdentifiersSchema>;

/** Exactly what the LLM must return. Validated on every call. */
export const LlmOutputSchema = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  /** Model's self-reported certainty in the classification, 0.0-1.0. */
  confidence: z.number().min(0).max(1),
  /** The core issue in one sentence (Step 3). */
  core_issue: z.string().min(1),
  identifiers: IdentifiersSchema,
  /** One phrase describing why this is (or isn't) urgent (Step 3). */
  urgency_signal: z.string().min(1),
  /** 2-3 sentence human-readable summary for the receiving team (Step 5). */
  summary: z.string().min(1),
});
export type LlmOutput = z.infer<typeof LlmOutputSchema>;

export const RoutingSchema = z.object({
  /** Where this would go based purely on category. */
  primary_queue: z.enum(QUEUES),
  /** Actual destination — equals primary_queue unless escalated. */
  final_destination: z.enum(QUEUES),
});
export type Routing = z.infer<typeof RoutingSchema>;

export const EscalationSchema = z.object({
  flagged: z.boolean(),
  reasons: z.array(z.string()),
});
export type Escalation = z.infer<typeof EscalationSchema>;

/** The raw inbound message (Step 1 — Ingestion). */
export const InboundSchema = z.object({
  id: z.string(),
  source: z.string(),
  received_at: z.string(),
  raw_message: z.string().min(1),
});
export type Inbound = z.infer<typeof InboundSchema>;

/** The final record written to disk / Sheet (all fields from Steps 2-6). */
export const TriageRecordSchema = InboundSchema.extend({
  classification: z.object({
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    confidence: z.number().min(0).max(1),
  }),
  enrichment: z.object({
    core_issue: z.string(),
    identifiers: IdentifiersSchema,
    urgency_signal: z.string(),
  }),
  routing: RoutingSchema,
  escalation: EscalationSchema,
  summary: z.string(),
  model: z.object({ provider: z.string(), model: z.string() }),
});
export type TriageRecord = z.infer<typeof TriageRecordSchema>;
