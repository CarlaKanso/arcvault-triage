import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import type { ChatArgs, LLMProvider, ProviderName } from "../src/providers/types.js";

// Don't touch the filesystem: stub the sinks the server writes to.
vi.mock("../src/sinks/jsonFile.js", () => ({
  appendJsonOutput: vi.fn(async () => []),
  writeJsonOutputs: vi.fn(async () => {}),
}));

/** A scripted provider so the HTTP layer is tested offline (no API key, no network). */
class FakeProvider implements LLMProvider {
  readonly name: ProviderName = "openai";
  readonly model = "fake";
  async complete(_args: ChatArgs): Promise<string> {
    return JSON.stringify({
      category: "Bug Report",
      priority: "High",
      confidence: 0.95,
      core_issue: "User cannot log in (403).",
      identifiers: { account: null, invoice_number: null, error_code: "403", amount: null, expected_amount: null, other: [] },
      urgency_signal: "Login fully blocked.",
      summary: "A user is blocked from logging in with a 403 error.",
    });
  }
}

const app = createApp(new FakeProvider());

describe("triage server", () => {
  it("GET /health reports the active provider", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", provider: "openai", model: "fake" });
  });

  it("POST /webhook/ingest triages a message and generates an id", async () => {
    const res = await request(app)
      .post("/webhook/ingest")
      .send({ source: "Email", message: "I keep getting a 403 error when logging in." });

    expect(res.status).toBe(200);
    expect(res.body.classification.category).toBe("Bug Report");
    expect(res.body.routing.final_destination).toBe("Engineering");
    expect(res.body.escalation.flagged).toBe(false);
    expect(res.body.id).toMatch(/^req-/);
    expect(res.body.source).toBe("Email");
  });

  it("POST /webhook/ingest returns 400 when the message is missing", async () => {
    const res = await request(app).post("/webhook/ingest").send({ source: "Email" });
    expect(res.status).toBe(400);
  });
});
