# Architecture Write-Up (Deliverable 4.4)

## System design

The pipeline is one function — `triageOne(provider, message)` — composed of small,
single-purpose units. A message flows through it in five stages:

```
                 ┌─────────────── TypeScript engine (the brain) ───────────────┐
 Inbound msg ──▶ │ Ingest → LLM call (classify + enrich + summary) → Decide →   │ ──▶ Sinks
 (Step 1)        │           one structured call, schema-validated    (code)    │     JSON file
                 │                                              routing+escalate │     Google Sheet
                 └──────────────────────────────────────────────────────────────┘
```

**What triggers what.**
- *Ingestion (Step 1).* Two triggers, same logic. In the code engine, `run.ts`
  reads `data/samples.json` (a batch trigger — trivially swappable for a folder
  watch or HTTP handler). In n8n, a **Webhook** node fires per message. The point
  is the workflow starts on its own when a message arrives.
- *LLM call (Steps 2, 3, 5).* One call per message through an `LLMProvider`
  behind an interface, so OpenAI / Groq / Gemini are interchangeable. The response
  is parsed and validated against a Zod schema, with one retry on malformed output.
- *Decision (Steps 4 & 6).* `decide()` — pure, synchronous, unit-tested code —
  maps the classification to a queue and applies the escalation rules.
- *Output (Step 5).* Records are written to `output/records.json` +
  `output/escalation.json`, and optionally appended to a Google Sheet (`Triage`
  and `Escalation` tabs).

**Where state is held.** Deliberately almost nowhere. Each message is processed
independently and statelessly; the only persistence is the output sink (files or
the Sheet). There is no database and no shared mutable state between messages,
which makes the pipeline trivially parallelizable and safe to retry. The two n8n
Code nodes carry the exact same prompt and decision logic as the engine (the
workflow is *generated* from the prompt source), so both surfaces behave identically.

**The one idea everything follows from:** the LLM interprets language; code makes
decisions. Anything auditable, testable, or safety-relevant (where money goes,
whether a human is pulled in) is code. This keeps the model's fuzziness contained
to the one place it adds value.

## Routing logic

Five categories map to four queues; escalation is a fifth destination that
overrides the queue.

| Category | Queue | Why |
|---|---|---|
| Bug Report | Engineering | Broken product behaviour → the team that fixes code. |
| Incident/Outage | Engineering | Same team, but always escalated (below). |
| Feature Request | Product | Roadmap decisions, not a fix. |
| Billing Issue | Billing | Invoices/charges/refunds. |
| Technical Question | IT/Security | Our sample questions are auth/integration (SSO/Okta). A real deployment would add a general Support/Success queue and split "how-do-I" from "is-it-secure". |

Routing is a static category→queue map (`CATEGORY_TO_QUEUE`). It's a pure function
so it's instant, free, and unit-tested — and a non-engineer can read and change it.
`routing.primary_queue` always records where a ticket *would* go, even when
escalation overrides `final_destination`, so the human reviewer keeps that context.

## Escalation logic

A record is flagged for human review and sent to the **Escalation** queue (instead
of its normal queue) if **any** rule fires. Reasons accumulate so the reviewer sees
every trigger:

| Rule | Rationale |
|---|---|
| `confidence < 0.70` | The model told us it's unsure — a human is cheaper than a misroute. Threshold is strict (`0.70` passes). |
| category = `Incident/Outage` | Outages are high-blast-radius; never let one sit in a queue. |
| outage keywords (`outage`, `down for all users`, `multiple users affected`, `all users`) | A safety net independent of the classifier — catches outages even if the category is wrong. |
| billing discrepancy `> $500` | Money over a threshold needs eyes. Defined as `|charged − expected|`. |

**A deliberate subtlety:** sample #3 disputes a $1,240 charge against a $980 rate.
The *discrepancy* is **$260**, under the $500 bar, so it routes normally to Billing.
I define "billing error" as the discrepancy, not the charged amount, because the
discrepancy is the actual dispute size — the number a human would triage on. (Both
thresholds are strict `>` / `<`, and both are unit-tested at the boundary.)

Across the five samples the canonical (Groq) run exercised: three clean auto-routes
(Bug → Engineering, Feature → Product, ambiguous SSO → IT/Security), one billing
case that stays *below* the escalation bar (the $260 discrepancy), and one
keyword/category escalation (the outage). The low-confidence fallback is where it
got interesting: I predicted the hedged SSO question would trip `<0.70`, and whether
it does turns out to be **model-dependent** — Groq scored it 0.80 (auto-routed),
Gemini scored the same message 0.65 (escalated), and Gemini even scored it 0.90 on a
separate run. That instability is the point (see below): self-reported confidence is
poorly calibrated, so escalation never rests on it alone — the deterministic
keyword/category and billing rules are the reliable safety net. (Full log: RESULTS.md.)

## What I'd do differently at production scale

- **Reliability.** Wrap provider calls in a retry-with-backoff + timeout and a
  circuit breaker; on repeated failure, route to a dead-letter queue rather than
  dropping the message (the engine already isolates per-message failures so one bad
  message can't sink a batch). Make sink writes idempotent with the message ID as a
  key. Add structured logging + tracing per stage.
- **Cost.** `gpt-4o-mini`-class models are already cheap; the bigger levers are
  caching the (large) system prompt, batching, and using a small/local model
  (Groq/Ollama) for the easy 80% while reserving a stronger model for
  low-confidence cases — a confidence-tiered cascade.
- **Latency.** Ingestion should enqueue (SQS/Kafka) and workers should process
  asynchronously so a slow LLM call never blocks intake. The one call per message
  keeps per-item latency low; concurrency handles throughput.
- **Correctness over time.** Log every decision, sample human overrides from the
  escalation queue, and build a labelled eval set so prompt/threshold changes are
  measured, not guessed. Add drift alerts on category mix and escalation rate.

## Phase 2 (one more week)

1. **Agreement-based confidence.** Use the existing `compare` mode in the hot path:
   escalate on *model disagreement*, a better-calibrated uncertainty signal than
   self-reported confidence.
2. **Evaluation harness.** A labelled fixture set + CI check on classification
   accuracy and routing correctness, so prompts can't silently regress.
3. **Reply drafting.** For high-confidence, low-risk categories, draft a suggested
   first response for the agent to approve — the next automation step after routing.
4. **Feedback loop.** Capture human re-routes from the Escalation queue and feed
   them back as few-shot examples / threshold tuning.
5. **Richer entity extraction + dedup.** Link messages to accounts/invoices in the
   CRM and detect duplicate reports of the same outage.

## Tooling choices

- **TypeScript + Node** for the engine: strong typing on the record shape (Zod
  doubles as runtime validation *and* static types), easy to test, and the decision
  logic drops straight into n8n Code nodes.
- **Multi-provider adapter (OpenAI / Groq / Gemini)** over plain `fetch`, no vendor
  SDKs — uniform, transparent, and no lock-in. Default `gpt-4o-mini` for its
  accuracy-per-cent on classification; Groq for speed/free tier; Gemini for its
  free tier. `compare` mode shows the prompt holds across all three.
- **n8n** for the visual surface because it's what the role uses and it makes the
  trigger → route → escalate flow legible at a glance.
- **Google Sheets** as the sink: zero-friction for a downstream team to read,
  filter, and act on — no app to build.
