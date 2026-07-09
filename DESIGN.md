# Design Spec — ArcVault AI Intake & Triage Pipeline

_Approved design. Captured before implementation as the single source of truth for decisions._

## Goal
Automate intake → classification → enrichment → routing → structured output → escalation for
unstructured inbound customer messages. Process the 5 synthetic samples end-to-end.

## Core principle
**The LLM only interprets unstructured text. Every decision is deterministic code.**
- LLM: classification + entity extraction + human summary — one structured call per message.
- Routing (Step 4) and Escalation (Step 6): pure, unit-tested TypeScript functions. No LLM.

Rationale: decision logic in code is auditable, testable, instant, and free. We never let the
model silently decide where money-related or outage tickets go.

## Two delivery surfaces, one brain
- **TypeScript engine** = the brain: prompts, multi-provider adapter, routing, escalation,
  schema validation, tests, JSON output. Produces the graded records.
- **n8n workflow** = self-contained visual shell for the demo: Webhook → LLM node → Code node
  (same routing/escalation JS pasted in) → Switch → Google Sheets. Reuses the same prompt strings.

## Multi-provider LLM adapter (differentiator)
`LLMProvider` interface with implementations for **OpenAI**, **Groq** (OpenAI-compatible, shares
one impl), and **Gemini**. Selectable by env/CLI. All use native JSON output + Zod validation +
one retry on malformed output. A `compare` mode runs all 5 messages through 2+ providers and
diffs the classifications — proves the prompt isn't overfit and gives a data-backed answer to
"what did the AI get wrong."

## Categories → queues (4 queues, exceeds ≥3 requirement) + Escalation queue
| Category | Primary queue |
|---|---|
| Bug Report | Engineering |
| Incident/Outage | Engineering (+ always escalate) |
| Feature Request | Product |
| Billing Issue | Billing |
| Technical Question | IT/Security |

## Escalation (route to Escalation queue instead of primary) if ANY:
- `confidence < 0.70`
- category is `Incident/Outage`
- outage signals in text: `outage`, `down for all users`, `multiple users affected`
- billing discrepancy `> $500`, defined as `disputed − expected`

## How the 5 samples exercise every path
1. 403 login error → Bug Report / High → Engineering. (happy path)
2. Bulk export feature → Feature Request / Low → Product. (happy path)
3. Invoice $1,240 vs $980 → Billing / Med → Billing. Discrepancy $260 < $500 → **no auto-escalate**. (threshold boundary)
4. SSO/Okta, "not sure if this is the right place" → Technical Question → IT/Security. (predicted this would trip the <0.70 fallback; at runtime it's **model-dependent** — Groq scored 0.80 and auto-routed, Gemini scored 0.65 and escalated. See RESULTS.md.)
5. Dashboard down, multiple users → Incident/Outage / High → **escalates via keyword + category**. (keyword path)

## Output record (per message)
```json
{
  "id": "msg-003", "source": "Support Portal", "received_at": "...", "raw_message": "...",
  "classification": { "category": "Billing Issue", "priority": "Medium", "confidence": 0.88 },
  "enrichment": {
    "core_issue": "Invoice charged $1,240 but contract rate is $980/month.",
    "identifiers": { "account": null, "invoice_number": "8821", "error_code": null, "amount": 1240, "expected_amount": 980, "other": [] },
    "urgency_signal": "..."
  },
  "routing": { "primary_queue": "Billing", "final_destination": "Billing" },
  "escalation": { "flagged": false, "reasons": [] },
  "summary": "2-3 sentence human-readable summary for the receiving team.",
  "model": { "provider": "openai", "model": "gpt-4o-mini" }
}
```
Written to `output/records.json` (+ `output/escalation.json`) and appended to a Google Sheet
(tabs: `Triage` = all, `Escalation` = flagged).

## Decisions made
- **One LLM call** (classify + enrich + summary) — cheaper/faster, one prompt to maintain.
- **n8n uses a generic HTTP node** → any OpenAI-compatible endpoint (defaults to Groq; swap URL+model+key to change). Not the native OpenAI node, so it's provider-portable.
- **Default model** `gpt-4o-mini`.
- Providers implemented over plain `fetch` (no vendor SDKs) → uniform, transparent, no lock-in.

## Phased build
- A — passing core: engine, OpenAI, routing/escalation + tests, records.json, prompts.md, ARCHITECTURE.md.
- B — differentiators: Groq + Gemini + compare; Google Sheets sink.
- C — visual: n8n workflow + screenshots.
