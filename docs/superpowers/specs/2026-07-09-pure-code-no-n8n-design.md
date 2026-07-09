# Design Spec — Pure-code (no-n8n) delivery surface

_Approved design, 2026-07-09. Captured before implementation._

## Goal

`arcvault-triage` ships two delivery surfaces today: the TypeScript engine (`src/`)
and an n8n workflow (`n8n/`). Add a **pure-code** surface that stands on its own
without n8n — a live HTTP webhook server plus the existing batch CLI — and split
the package.json scripts so the **n8n version** and the **pure-code version** run
separately. `atwi-response` is the reference example of what "pure code" looks like.

## Core principle (unchanged)

One brain, reused. The server and the batch CLI both call the *same* engine —
`getProvider()` → `triageOne()` → `decide()` → sinks. No triage logic is
duplicated. n8n's only runtime role in this repo — being a webhook service — is
what `src/server.ts` replaces in code.

## What's added / changed

### `src/server.ts` (new) — Express webhook server
- `GET /health` → `{ status: "ok", provider, model }`
- `POST /webhook/ingest` — one message → one triaged record. Accepts this repo's
  shape `{ id?, source, received_at?, raw_message }` **and** atwi's `{ source, message }`
  (normalized: `raw_message ??= message`, `id ??= req-<uuid>`, `received_at ??= now`,
  `source ??= "Unknown"`). Validated with `InboundSchema` (`safeParse` → 400 on bad
  input). Runs `triageOne`, **appends** to `output/records.json` (+ `escalation.json`),
  returns the record.
- `POST /process-all` — runs `data/samples.json` (override with `?input=`) through the
  pipeline (HTTP twin of `run.ts`), writes outputs, returns
  `{ processed, escalated, errors, records }`.
- Provider/model resolved from env at startup (`resolveProviderName`/`resolveModel`).
- Lean security: `express.json({ limit: "100kb" })`, optional `x-api-key` auth (active
  only when `API_KEY` is set), a global error handler. No helmet/cors/rate-limit/
  injection-guard (deferred; easy to add later).
- Exports `createApp(provider)` so tests inject a fake provider; auto-starts only when
  run directly (`import.meta.url === pathToFileURL(process.argv[1]).href`), so importing
  it in tests never binds a port or requires an API key.

### `src/sinks/jsonFile.ts` (edit) — add `appendJsonOutput`
Reads existing `records.json` (if present), pushes the new record, and rewrites both
files via the existing `writeJsonOutputs` (single source of truth for the escalation
filter). `writeJsonOutputs` itself is untouched; the batch CLI is unaffected.

### `scripts/post-samples.ts` (edit)
Default the target URL to `http://localhost:5678/webhook/arcvault-triage` when no arg
is passed, so `npm run n8n:post` works out of the box.

### `package.json` — split the two versions
| Version | Scripts |
|---|---|
| **Pure-code (no n8n)** | `serve` (`tsx src/server.ts`), `serve:watch` (`tsx watch src/server.ts`), `triage` *(kept)*, `compare` *(kept)* |
| **n8n** | `n8n:build` (`tsx scripts/build-n8n.ts`), `n8n:post` (`tsx scripts/post-samples.ts`) |

Adds `express` (dep); `@types/express`, `supertest`, `@types/supertest` (dev).

### `test/server.test.ts` (new)
Supertest smoke test with a stubbed provider and mocked sinks: `/health`, ingest happy
path (→ Bug Report / Engineering, generated `req-` id), ingest 400 on missing message.
Existing 16 tests stay green.

### `.env.example`, `README.md`
Document `PORT` / `API_KEY` and a "Two ways to run" section (pure-code vs n8n).

## Kept, unchanged
`n8n/*.json`, `scripts/build-n8n.ts`, `run.ts`, `compare.ts`, and all of
`src/providers`, `src/pipeline`, `src/prompts`, `src/schema.ts`, `src/sinks/sheets.ts`.
Nothing is deleted — both versions keep working side by side.

## Verification
`npm run typecheck` clean · `npm test` green (existing + new server tests) · `npm run serve`
boots and `POST /webhook/ingest` + `GET /health` respond.
