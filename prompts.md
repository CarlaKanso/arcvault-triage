# Prompt Documentation (Deliverable 4.3)

The pipeline uses **one** LLM prompt per message. It performs Step 2
(classification), Step 3 (enrichment), and drafts the Step 5 summary in a single
structured call. Routing (Step 4) and escalation (Step 6) are **not** asked of
the model — they are deterministic code.

The prompt lives in [`src/prompts/triage.prompt.ts`](src/prompts/triage.prompt.ts)
and is imported verbatim by both the TypeScript engine and the n8n workflow
generator, so there is exactly one source of truth.

---

## System prompt

```
You are the intake triage agent for ArcVault, a B2B software company.
You read a single inbound customer message and return a strict JSON object.
You classify and extract only — you do NOT decide routing or escalation.

CATEGORIES (choose exactly one) — Bug Report, Feature Request, Billing Issue,
Technical Question, Incident/Outage:
- "Bug Report": the product is broken or behaving incorrectly for this customer
  (errors, a feature not working as intended). Usually affects one account.
- "Feature Request": a suggestion or ask for new/enhanced functionality that does
  not exist yet. Nothing is broken.
- "Billing Issue": questions or disputes about invoices, charges, pricing,
  payments, or refunds.
- "Technical Question": a "how do I / is it possible / are we able to" question
  about using, configuring, integrating, or evaluating the product. This INCLUDES
  pre-sales and evaluation questions. Nothing is reported as broken.
- "Incident/Outage": the product is unavailable or degraded as a service problem,
  typically affecting multiple users or described as "down", "outage", or "on your end".

PRIORITY (choose exactly one) — Low, Medium, High:
- "High": customer is fully blocked (e.g. cannot log in at all), an active outage,
  many users affected, a security/auth problem, data loss, or large financial impact.
- "Medium": a real problem for one customer that is not fully blocking; most billing
  disputes; single-user issues with a workaround.
- "Low": no time pressure — feature ideas, general questions, evaluations.

CONFIDENCE (0.0-1.0): report your GENUINE certainty in the CATEGORY.
- Use 0.90+ only when the category is unmistakable.
- Lower it (roughly 0.50-0.70) when the message is vague, fits two categories, is a
  pre-sales/evaluation question, or hedges (e.g. "not sure if this is the right place").
- Do not inflate confidence. A calibrated 0.6 is more useful than a false 0.95.

ENRICHMENT:
- "core_issue": the single core issue in ONE sentence.
- "identifiers": pull any that appear, else null. account, invoice_number (digits
  only), error_code, amount (NUMBER, strip "$"/commas), expected_amount, other[].
- "urgency_signal": one short phrase on why this is or isn't urgent, grounded in the text.

SUMMARY:
- "summary": 2-3 plain-language sentences for the receiving team. Say what is being
  asked, name key identifiers, and note any urgency. No greetings, no fluff.

OUTPUT: return ONLY a JSON object with EXACTLY these keys ...  (full shape in source)
Do not include markdown, code fences, or commentary. JSON only.
```

## User prompt (per message)

```
Source: {source}
Received: {received_at}
Message:
"""
{raw_message}
"""

Return the JSON object now.
```

---

## Why it's structured this way

**One call, not three.** Classification, enrichment, and the summary are all
*reading comprehension* over the same short message, so splitting them into three
prompts would triple latency and cost for no accuracy gain and give three prompts
to keep in sync. Routing/escalation are deliberately excluded because they are
policy, not language understanding — code does them so they're testable and cheap.

**Explicit category definitions.** The default failure mode of a bare category
list is predictable confusion: *Feature Request vs Technical Question* (sample #4,
SSO) and *Bug Report vs Incident/Outage* (single-user error vs service-wide). One
sentence per category, each naming the distinguishing signal ("nothing is broken",
"affects multiple users"), removes most of that ambiguity without a few-shot block.

**Calibrated confidence is load-bearing, not decorative.** The `< 0.70` escalation
fallback only works if confidence tracks real ambiguity. So the prompt explicitly
tells the model to *lower* confidence on vague, dual-category, or hedged messages
and forbids inflation. Honesty note from the live run: sample #4 ("not sure if this
is the right place… evaluating switching") is exactly this kind of hedged message,
and the models split on it — Groq scored 0.80 (auto-routed), Gemini scored 0.65
(escalated), and Gemini gave 0.90 on a separate run. Same input, different confidence
across models and even across runs. That is direct evidence that self-reported
confidence is only weakly calibrated — and the reason "what I'd change" leads with
agreement-based confidence instead. (See RESULTS.md.)

**Strict JSON + schema validation + low temperature.** The prompt demands JSON
only; the code requests the provider's JSON mode, validates every response with a
Zod schema, and retries once on malformed output. Temperature is `0.1` because
triage should be near-deterministic — the same ticket should route the same way
twice. Belt and suspenders, but each layer catches a different real failure.

**Numbers extracted as numbers.** `amount`/`expected_amount` are required to be
numeric (strip `$` and commas) specifically so the escalation rule ("billing
discrepancy > $500") is arithmetic in code, not the model eyeballing dollar signs.

## Tradeoffs I accepted

- **Self-reported confidence is weakly calibrated.** LLM confidence is not a true
  probability. I use it as a coarse triage signal and pair it with keyword/category
  rules so escalation never rests on the score alone. (See mitigation below.)
- **Zero-shot, no examples.** Keeps the prompt short and cheap and avoids biasing
  toward the sample phrasings. Cost: a couple of points of accuracy on genuinely
  ambiguous inputs that a few-shot block might catch.
- **English-only, single-message.** No thread history, no language detection.

## What I'd change with more time

- **Agreement-based confidence.** Run 2 providers (the `compare` mode already does
  this) and treat *disagreement* as the escalation trigger instead of, or alongside,
  self-reported confidence — a far better calibrated "is this uncertain?" signal.
- **A few-shot block** with 1–2 deliberately hard, near-boundary examples per
  category, and an eval set to measure the accuracy/cost tradeoff instead of guessing.
- **`logprobs`-based confidence** on providers that expose it, for a real probability.
- **Priority rubric per category** (e.g. billing severity scaled by dollar amount).
