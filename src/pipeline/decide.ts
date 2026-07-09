import type { Category, Escalation, Queue, Routing } from "../schema.js";

/**
 * Deterministic decision logic — Step 4 (routing) and Step 6 (escalation).
 *
 * NOTHING here calls an LLM. This is the auditable core of the system: given a
 * classification, where does the ticket go and does a human need to see it?
 * It is pure, synchronous, and fully unit-tested. The n8n "Code" node pastes
 * this same logic so both delivery surfaces decide identically.
 */

export const CONFIDENCE_THRESHOLD = 0.7;
export const BILLING_ESCALATION_USD = 500;

const CATEGORY_TO_QUEUE: Record<Category, Queue> = {
  "Bug Report": "Engineering",
  "Incident/Outage": "Engineering",
  "Feature Request": "Product",
  "Billing Issue": "Billing",
  "Technical Question": "IT/Security",
};

/** Step 4: map a category to its standard destination queue. */
export function routePrimary(category: Category): Queue {
  return CATEGORY_TO_QUEUE[category];
}

/** Phrases that signal a service-wide problem needing immediate human eyes. */
const OUTAGE_PATTERNS: RegExp[] = [
  /\boutage\b/i,
  /down for (all|everyone)/i,
  /multiple users affected/i,
  /\ball users\b/i,
];

export interface EscalationInput {
  category: Category;
  confidence: number;
  raw_message: string;
  amount: number | null;
  expected_amount: number | null;
}

/**
 * Step 6: decide whether a record must go to a human instead of its queue.
 * Reasons accumulate so the reviewer sees every trigger, not just the first.
 */
export function escalate(input: EscalationInput): Escalation {
  const reasons: string[] = [];

  if (input.confidence < CONFIDENCE_THRESHOLD) {
    reasons.push(
      `Low classification confidence (${input.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}).`,
    );
  }

  if (input.category === "Incident/Outage") {
    reasons.push("Classified as Incident/Outage — outages always need a human.");
  }

  const matched = OUTAGE_PATTERNS.find((re) => re.test(input.raw_message));
  if (matched) {
    const hit = input.raw_message.match(matched)?.[0] ?? "";
    reasons.push(`Matched outage/incident keyword: "${hit}".`);
  }

  if (input.amount != null && input.expected_amount != null) {
    const discrepancy = Math.abs(input.amount - input.expected_amount);
    if (discrepancy > BILLING_ESCALATION_USD) {
      reasons.push(
        `Billing discrepancy $${discrepancy} exceeds $${BILLING_ESCALATION_USD}.`,
      );
    }
  }

  return { flagged: reasons.length > 0, reasons };
}

/** Combine routing + escalation: escalation overrides the destination. */
export function decide(input: EscalationInput): { routing: Routing; escalation: Escalation } {
  const primary_queue = routePrimary(input.category);
  const escalation = escalate(input);
  return {
    routing: {
      primary_queue,
      final_destination: escalation.flagged ? "Escalation" : primary_queue,
    },
    escalation,
  };
}
