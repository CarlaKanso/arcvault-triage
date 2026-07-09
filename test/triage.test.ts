import { describe, it, expect } from "vitest";
import { triageOne } from "../src/triage.js";
import { TriageRecordSchema, type Inbound, type LlmOutput } from "../src/schema.js";
import type { ChatArgs, LLMProvider, ProviderName } from "../src/providers/types.js";

/** A scripted provider so we can test the orchestration offline (no API calls). */
class FakeProvider implements LLMProvider {
  readonly name: ProviderName = "openai";
  readonly model = "fake";
  private calls = 0;
  constructor(private readonly replies: string[]) {}
  async complete(_args: ChatArgs): Promise<string> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls++;
    return reply;
  }
}

const msg: Inbound = {
  id: "t-1",
  source: "Email",
  received_at: "2026-02-10T09:00:00-05:00",
  raw_message: "Test message.",
};

function llm(partial: Partial<LlmOutput>): string {
  const full: LlmOutput = {
    category: "Bug Report",
    priority: "Medium",
    confidence: 0.9,
    core_issue: "Something broke.",
    identifiers: { account: null, invoice_number: null, error_code: null, amount: null, expected_amount: null, other: [] },
    urgency_signal: "n/a",
    summary: "A test summary sentence.",
    ...partial,
  };
  return JSON.stringify(full);
}

describe("triageOne — orchestration + assembly", () => {
  it("produces a schema-valid record and routes a confident bug to Engineering", async () => {
    const rec = await triageOne(new FakeProvider([llm({ category: "Bug Report", confidence: 0.95 })]), msg);
    expect(() => TriageRecordSchema.parse(rec)).not.toThrow();
    expect(rec.routing.final_destination).toBe("Engineering");
    expect(rec.escalation.flagged).toBe(false);
    expect(rec.model).toEqual({ provider: "openai", model: "fake" });
  });

  it("escalates an outage regardless of the primary queue", async () => {
    const rec = await triageOne(new FakeProvider([llm({ category: "Incident/Outage", confidence: 0.99 })]), msg);
    expect(rec.routing.primary_queue).toBe("Engineering");
    expect(rec.routing.final_destination).toBe("Escalation");
    expect(rec.escalation.flagged).toBe(true);
  });

  it("recovers from a malformed first response via one retry", async () => {
    const rec = await triageOne(
      new FakeProvider(["not json at all", llm({ category: "Feature Request", confidence: 0.9 })]),
      msg,
    );
    expect(rec.classification.category).toBe("Feature Request");
    expect(rec.routing.final_destination).toBe("Product");
  });

  it("throws after repeated malformed responses", async () => {
    await expect(
      triageOne(new FakeProvider(["nope", "still nope"]), msg),
    ).rejects.toThrow(/after \d+ attempts/);
  });
});
