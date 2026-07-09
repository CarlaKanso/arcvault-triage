# ArcVault — AI Intake & Triage Pipeline

An agentic workflow that ingests unstructured inbound customer messages and
**classifies → enriches → routes → escalates** them into the right queue, then
writes a clean structured record for the receiving team.

Built for the Valsoft AI Engineer assessment. Two delivery surfaces, one brain:

- **Pure-code version** (`src/`) — the real logic: prompts, a multi-provider LLM
  adapter (OpenAI / Groq / Gemini), deterministic routing & escalation, tests,
  and structured JSON output. Runs entirely in TypeScript as an HTTP webhook
  server (`npm run serve`) or a one-shot batch (`npm run triage`). No n8n needed.
- **n8n workflow** (`n8n/`) — a self-contained visual version for the demo,
  generated from the *same* prompt so it classifies identically.

> **Design principle:** the LLM only interprets unstructured text (classification,
> entity extraction, summary). Every *decision* — which queue, escalate or not —
> is pure, unit-tested TypeScript. Decisions must be auditable, testable, and free.

---

## Quick start (TypeScript engine)

```bash
npm install
cp .env.example .env        # then paste at least one API key
npm test                    # 16 unit tests, no API key needed
npm run triage              # processes the 5 samples → output/records.json
```

Pick a provider or model:

```bash
npm run triage -- --provider=groq
npm run triage -- --provider=gemini --model=gemini-2.5-flash
npm run triage -- --provider=openai --model=gpt-4o-mini
```

Compare providers on the same inputs (needs ≥2 keys set):

```bash
npm run compare                            # every provider with a key
npm run compare -- --providers=openai,groq
```

Outputs land in `output/`:
- `records.json` — all 5 records, every field populated (deliverable 4.2)
- `escalation.json` — only the human-review records
- `comparison.json` — cross-provider diff (from `npm run compare`)

## Two ways to run

There are two delivery surfaces, run independently:

- **Pure-code version (no n8n)** — everything runs in TypeScript.
  - `npm run serve` — start the HTTP webhook server (`src/server.ts`) on `http://localhost:3000`
  - `npm run triage` — one-shot batch over `data/samples.json` → `output/*.json`
  - `npm run compare` — same messages across multiple providers
- **n8n version** — the visual workflow (needs n8n running in Docker, see below).
  - `npm run n8n:build` — regenerate `n8n/*.json` from the current prompt
  - `npm run n8n:post` — fire the 5 samples at a running n8n webhook

Both surfaces call the *same* engine, so they classify and route identically.

### The webhook server (`npm run serve`)

The pure-code stand-in for n8n's webhook. Provider/model come from
`TRIAGE_PROVIDER` / `TRIAGE_MODEL` in `.env`. Set `API_KEY` to require an
`x-api-key` header; set `PORT` to change the port.

```bash
npm run serve
# POST a single message (accepts { source, raw_message } or { source, message })
curl -X POST http://localhost:3000/webhook/ingest \
  -H "Content-Type: application/json" \
  -d '{"source":"Email","message":"I keep getting a 403 error when logging in."}'

# Run all 5 samples through the pipeline
curl -X POST http://localhost:3000/process-all

# Liveness + which provider is active
curl http://localhost:3000/health
```

Each ingest appends to `output/records.json` (+ `output/escalation.json`).

## Scripts

| Command | What it does |
|---|---|
| `npm run serve` | Start the pure-code HTTP webhook server (`/webhook/ingest`, `/process-all`, `/health`) |
| `npm run serve:watch` | Same, with hot reload |
| `npm run triage` | Process all samples → JSON (add `--sheets` to also push to Google Sheets) |
| `npm run compare` | Same messages across multiple providers, diff classifications |
| `npm run n8n:build` | Regenerate the n8n workflow from the current prompt |
| `npm run n8n:post` | Fire the 5 samples at a running n8n webhook (defaults to the local test URL) |
| `npm test` | Run the unit tests (routing/escalation + orchestration + server, offline) |
| `npm run typecheck` | `tsc --noEmit` |

---

## Optional: write to Google Sheets

The engine writes to a Sheet using a **service account** (headless, no OAuth prompt).

1. In [Google Cloud Console](https://console.cloud.google.com/): create a project and **enable the Google Sheets API**.
2. Create a **Service Account** → **Keys** → **Add key → JSON**. Save it as `google-service-account.json` in the project root.
3. Create a Google Sheet. Copy its ID from the URL: `docs.google.com/spreadsheets/d/`**`<ID>`**`/edit`.
4. **Share the Sheet** with the service account's `client_email` (from the JSON) as **Editor**.
5. In `.env` set `GOOGLE_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON=./google-service-account.json`.
6. Run:

```bash
npm run triage -- --sheets
```

It creates two tabs — `Triage` (all records) and `Escalation` (flagged only) — and
rewrites them each run so there are never duplicate rows.

---

## Optional: run the n8n workflow (visual demo)

Flow: **Webhook → Build LLM request → Call LLM (Groq) → Decide & assemble
(routing + escalation) → Append to Triage → Is escalated? → Append to Escalation.**

The LLM step is a generic HTTP node pointed at Groq's OpenAI-compatible endpoint —
swap the URL/model/key in `scripts/build-n8n.ts` to target OpenAI or any other.

1. Start n8n (Docker):
   ```bash
   docker run -it --rm -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
   ```
   Open http://localhost:5678.
2. **Import** `n8n/arcvault-triage.workflow.json` (top-right menu → *Import from File*).
3. Create the two credentials (imported nodes always need this):
   - **Call LLM (Groq)** → an **HTTP Header Auth** credential: name `Authorization`,
     value `Bearer <your-groq-key>`.
   - **Append to Triage / Escalation** → a **Google Sheets** credential. Easiest is
     to reuse the same service account (credential type *Service Account*, paste the JSON).
   - In both Sheets nodes, reselect your spreadsheet and the `Triage` / `Escalation` tabs.
4. **Execute workflow** (test mode) to get the Test webhook URL, then fire the samples:
   ```bash
   npm run n8n:post -- http://localhost:5678/webhook-test/arcvault-triage
   ```
   (Or just `npm run n8n:post` after you **Activate** the workflow — it defaults to
   the production URL `http://localhost:5678/webhook/arcvault-triage`.)
5. Screenshot each node's output + the filled Sheet → deliverable 4.1.

---

## Deliverables map

| Assessment item | Where |
|---|---|
| 4.1 Working workflow | `npm run triage` (code) · `n8n/arcvault-triage.workflow.json` + screenshots |
| 4.2 Structured output | `output/records.json`, `output/escalation.json`, Google Sheet |
| 4.3 Prompt documentation | [`prompts.md`](prompts.md) |
| 4.4 Architecture write-up | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Design spec (decisions) | [`DESIGN.md`](DESIGN.md) |
| Live run log (what broke + fixes) | [`RESULTS.md`](RESULTS.md) |

## Repo layout

```
src/providers/     multi-LLM adapter (OpenAI/Groq share one impl; Gemini its own)
src/prompts/       the one triage prompt (single source of truth)
src/pipeline/      decide.ts — pure routing + escalation (unit-tested)
src/sinks/         jsonFile.ts, sheets.ts
src/server.ts      pure-code HTTP webhook server (the n8n stand-in)
src/{schema,triage,run,compare,util}.ts
test/              decide.test.ts, triage.test.ts, server.test.ts
scripts/           build-n8n.ts, post-samples.ts
data/samples.json  the 5 synthetic inputs
n8n/               generated workflow + screenshots/
```
