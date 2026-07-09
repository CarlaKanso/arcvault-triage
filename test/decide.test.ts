import { describe, it, expect } from "vitest";
import {
  routePrimary,
  escalate,
  decide,
  CONFIDENCE_THRESHOLD,
  BILLING_ESCALATION_USD,
} from "../src/pipeline/decide.js";

describe("routePrimary — category → queue mapping (Step 4)", () => {
  it("maps every category to its queue", () => {
    expect(routePrimary("Bug Report")).toBe("Engineering");
    expect(routePrimary("Incident/Outage")).toBe("Engineering");
    expect(routePrimary("Feature Request")).toBe("Product");
    expect(routePrimary("Billing Issue")).toBe("Billing");
    expect(routePrimary("Technical Question")).toBe("IT/Security");
  });
});

const base = {
  category: "Bug Report" as const,
  confidence: 0.95,
  raw_message: "The export button throws an error for my account.",
  amount: null,
  expected_amount: null,
};

describe("escalate — human-review flag (Step 6)", () => {
  it("does NOT flag a confident, non-outage, non-billing message", () => {
    const e = escalate(base);
    expect(e.flagged).toBe(false);
    expect(e.reasons).toEqual([]);
  });

  it("flags when confidence is below the threshold", () => {
    const e = escalate({ ...base, confidence: 0.5 });
    expect(e.flagged).toBe(true);
    expect(e.reasons.join(" ")).toMatch(/confidence/i);
  });

  it("treats the confidence threshold as strict (0.70 does NOT flag)", () => {
    expect(escalate({ ...base, confidence: CONFIDENCE_THRESHOLD }).flagged).toBe(false);
    expect(escalate({ ...base, confidence: CONFIDENCE_THRESHOLD - 0.01 }).flagged).toBe(true);
  });

  it("always flags Incident/Outage by category", () => {
    const e = escalate({ ...base, category: "Incident/Outage" });
    expect(e.flagged).toBe(true);
    expect(e.reasons.join(" ")).toMatch(/outage/i);
  });

  it("flags on an outage keyword even when the category is not Outage", () => {
    const e = escalate({
      ...base,
      category: "Bug Report",
      raw_message: "Dashboard is slow. Multiple users affected.",
    });
    expect(e.flagged).toBe(true);
    expect(e.reasons.join(" ")).toMatch(/keyword/i);
  });

  it("does NOT flag a billing discrepancy at or below $500", () => {
    // Sample #3: $1,240 charged vs $980 expected → $260 gap → stays in Billing.
    const e = escalate({
      ...base,
      category: "Billing Issue",
      amount: 1240,
      expected_amount: 980,
    });
    expect(e.flagged).toBe(false);
  });

  it("treats the billing threshold as strict (exactly $500 does NOT flag)", () => {
    const e = escalate({ ...base, category: "Billing Issue", amount: 1500, expected_amount: 1000 });
    expect(e.flagged).toBe(false);
    expect(BILLING_ESCALATION_USD).toBe(500);
  });

  it("flags a billing discrepancy greater than $500", () => {
    const e = escalate({ ...base, category: "Billing Issue", amount: 1600, expected_amount: 1000 });
    expect(e.flagged).toBe(true);
    expect(e.reasons.join(" ")).toMatch(/\$600|billing/i);
  });

  it("accumulates multiple reasons", () => {
    const e = escalate({
      ...base,
      category: "Incident/Outage",
      confidence: 0.4,
      raw_message: "Total outage, multiple users affected.",
    });
    expect(e.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("decide — routing + escalation combined", () => {
  it("keeps the primary destination when not escalated", () => {
    const d = decide({ ...base, category: "Feature Request", confidence: 0.9 });
    expect(d.routing.primary_queue).toBe("Product");
    expect(d.routing.final_destination).toBe("Product");
    expect(d.escalation.flagged).toBe(false);
  });

  it("overrides the destination to Escalation when flagged, but remembers the primary", () => {
    const d = decide({ ...base, category: "Incident/Outage", confidence: 0.9 });
    expect(d.routing.primary_queue).toBe("Engineering");
    expect(d.routing.final_destination).toBe("Escalation");
    expect(d.escalation.flagged).toBe(true);
  });
});
