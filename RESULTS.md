# Live Run Results

What actually happened when the pipeline ran on the 5 samples — including the
things that went wrong and what I changed. (The assessment explicitly asks "what
did the AI get wrong that you had to fix" — this is that log.)

## Canonical output — `output/records.json`

Provider: **Groq · `llama-3.3-70b-versatile`** (free tier). Command: `npm run triage -- --provider=groq`.

| # | Message | Category | Priority | Conf | Destination | Escalated |
|---|---|---|---|---|---|---|
| 001 | 403 login error after update | Bug Report | High | 0.95 | Engineering | — |
| 002 | Bulk export feature request | Feature Request | Low | 0.95 | Product | — |
| 003 | Invoice $1,240 vs $980 rate | Billing Issue | Medium | 0.95 | Billing | — |
| 004 | SSO/Okta, "not sure if right place" | Technical Question | Low | 0.80 | IT/Security | — |
| 005 | Dashboard down, multiple users | Incident/Outage | High | 0.95 | **Escalation** | **YES** |

- **msg-003** correctly extracted `invoice_number: 8821`, `amount: 1240`,
  `expected_amount: 980`. The $260 discrepancy is **below** the $500 bar, so it
  routed normally to Billing — the threshold works exactly as designed.
- **msg-005** escalated with two independent reasons (category = Incident/Outage
  **and** keyword "Multiple users affected"), routed to the Escalation queue.

## Things that went wrong (and the fixes)

1. **OpenAI key was out of quota (HTTP 429).** The first run produced 0 records —
   but the pipeline isolated the failure per-message and never crashed. The fix
   was free: switch provider (`--provider=groq`). This is the multi-provider
   design paying for itself on the very first run.
2. **`TRIAGE_MODEL` leaked across providers.** With `TRIAGE_MODEL=gpt-4o-mini` in
   `.env`, `--provider=groq` tried to call `gpt-4o-mini` on Groq → 404. Fixed the
   precedence in `resolveModel()`: an env model only applies to its own provider;
   switching providers falls back to that provider's default.
3. **Gemini free tier rejected `gemini-2.0-flash` (429, `limit: 0`).** Listed the
   key's accessible models and switched the default to **`gemini-2.5-flash`**,
   which works.
4. **Compare mode mistook a provider error for consensus.** When only one provider
   answered, the old logic reported "agree". Fixed it to require ≥2 successful
   providers before claiming agreement (`comparable` flag), so an error never reads
   as agreement.

## Cross-provider comparison — `output/comparison.json`

`npm run compare -- --providers=groq,gemini` — all 5 messages, both providers answered.

- **Category: 5/5 agreement.** Groq (Llama-3.3) and Gemini-2.5 classify all five
  identically → the prompt is not overfit to one model.
- **The interesting one — msg-004 (SSO/Okta).** Same category (Technical Question),
  but the confidence diverged: **Groq 0.80 → auto-routed**, **Gemini 0.65 →
  escalated** (below the 0.70 bar). Same input, different escalation decision.

## The headline finding: self-reported confidence is not reliable

I had predicted msg-004 (a hedged, ambiguous message) would trip the `<0.70`
fallback. Reality was messier and more instructive:

- Groq scored it **0.80**; Gemini scored it **0.65** in the compare run.
- Gemini even scored it **0.90** on a *separate* standalone run — the same model,
  same input, different confidence run to run.

So the low-confidence escalation path *does* fire (Gemini, 0.65) — but whether it
fires depends on the model and even the run. The deterministic paths (routing,
keyword/category escalation, the billing threshold) are rock-solid and reproducible;
the confidence path is inherently soft. This is exactly why **ARCHITECTURE.md**'s
Phase 2 leads with *agreement-based confidence* (escalate on model disagreement) as
a better-calibrated signal than any single model's self-report.

## Verification

- `npm test` → **16/16** unit tests pass (routing, escalation boundaries, and the
  orchestration/retry path — all offline, no API key needed).
- `npm run typecheck` → clean.
