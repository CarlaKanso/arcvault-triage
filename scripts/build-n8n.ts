/**
 * Generates n8n/arcvault-triage.workflow.json from the SAME prompt the code
 * engine uses (imported below) plus a faithful copy of the decision logic from
 * src/pipeline/decide.ts (which is the unit-tested source of truth). Run:
 *
 *   npx tsx scripts/build-n8n.ts
 *
 * Generating (rather than hand-writing) the workflow guarantees the n8n demo
 * and the TypeScript engine classify with an identical prompt — no drift.
 */
import { writeFile } from "node:fs/promises";
import { SYSTEM_PROMPT } from "../src/prompts/triage.prompt.js";

// The n8n LLM step uses a GENERIC HTTP node, so it points at any OpenAI-compatible
// endpoint. We default to Groq (free tier, works today) — swap these three values
// to target OpenAI, Together, a local vLLM, etc. Nothing else changes.
const LLM_URL = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL = "llama-3.3-70b-versatile";
const PROVIDER_NAME = "groq";

// --- Code node 1: build the chat-completions request from the webhook payload ---
const buildRequestCode = String.raw`const body = $json.body ?? $json;
const SYSTEM = ${JSON.stringify(SYSTEM_PROMPT)};
const user = 'Source: ' + body.source + '\nReceived: ' + body.received_at +
  '\nMessage:\n"""\n' + body.raw_message + '\n"""\n\nReturn the JSON object now.';
return { model: ${JSON.stringify(LLM_MODEL)}, messages: [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: user },
] };`;

// --- Code node 2: parse LLM output + run deterministic routing/escalation ---
// Mirrors src/pipeline/decide.ts (unit-tested). Emits a FLAT row so Google
// Sheets auto-maps columns and the webhook returns a clean record.
const assembleCode = String.raw`const resp = $json;
const content = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '{}';
const llm = JSON.parse(content);
const inbound = $('Webhook').item.json.body;

const CONFIDENCE_THRESHOLD = 0.7;
const BILLING_ESCALATION_USD = 500;
const CATEGORY_TO_QUEUE = { 'Bug Report':'Engineering','Incident/Outage':'Engineering','Feature Request':'Product','Billing Issue':'Billing','Technical Question':'IT/Security' };
const OUTAGE_PATTERNS = [/\boutage\b/i,/down for (all|everyone)/i,/multiple users affected/i,/\ball users\b/i];

const id = llm.identifiers || {};
const reasons = [];
if (llm.confidence < CONFIDENCE_THRESHOLD) reasons.push('Low classification confidence (' + Number(llm.confidence).toFixed(2) + ' < ' + CONFIDENCE_THRESHOLD + ').');
if (llm.category === 'Incident/Outage') reasons.push('Classified as Incident/Outage — outages always need a human.');
const hit = OUTAGE_PATTERNS.find(function (re) { return re.test(inbound.raw_message); });
if (hit) reasons.push('Matched outage/incident keyword: "' + inbound.raw_message.match(hit)[0] + '".');
if (id.amount != null && id.expected_amount != null) {
  const disc = Math.abs(id.amount - id.expected_amount);
  if (disc > BILLING_ESCALATION_USD) reasons.push('Billing discrepancy $' + disc + ' exceeds $' + BILLING_ESCALATION_USD + '.');
}
const flagged = reasons.length > 0;
const primary = CATEGORY_TO_QUEUE[llm.category];

return {
  id: inbound.id, source: inbound.source, received_at: inbound.received_at,
  category: llm.category, priority: llm.priority, confidence: llm.confidence,
  primary_queue: primary, final_destination: flagged ? 'Escalation' : primary,
  escalation_flag: flagged ? 'YES' : 'no', escalation_reasons: reasons.join(' | '),
  core_issue: llm.core_issue, account: id.account || '', invoice_number: id.invoice_number || '',
  error_code: id.error_code || '', amount: id.amount != null ? id.amount : '',
  expected_amount: id.expected_amount != null ? id.expected_amount : '',
  other: (id.other || []).join(', '), urgency_signal: llm.urgency_signal, summary: llm.summary,
  provider: ${JSON.stringify(PROVIDER_NAME)}, model: ${JSON.stringify(LLM_MODEL)}, raw_message: inbound.raw_message,
};`;

const sheetLocator = (tab: string) => ({
  documentId: { __rl: true, value: "REPLACE_WITH_YOUR_SPREADSHEET_ID", mode: "id" as const },
  sheetName: { __rl: true, value: tab, mode: "name" as const, cachedResultName: tab },
});

const workflow = {
  name: "ArcVault — AI Intake & Triage",
  active: false,
  settings: { executionOrder: "v1" },
  pinData: {},
  nodes: [
    {
      parameters: { httpMethod: "POST", path: "arcvault-triage", responseMode: "lastNode", options: {} },
      id: "node-webhook",
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [240, 320],
      webhookId: "arcvault-triage-webhook",
    },
    {
      parameters: { mode: "runOnceForEachItem", jsCode: buildRequestCode },
      id: "node-build",
      name: "Build LLM request",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [460, 320],
    },
    {
      parameters: {
        method: "POST",
        url: LLM_URL,
        authentication: "genericCredentialType",
        genericAuthType: "httpHeaderAuth",
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          "={{ { \"model\": $json.model, \"temperature\": 0.1, \"response_format\": { \"type\": \"json_object\" }, \"messages\": $json.messages } }}",
        options: {},
      },
      id: "node-llm",
      name: "Call LLM (Groq)",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [680, 320],
      credentials: { httpHeaderAuth: { id: "REPLACE_CRED_ID", name: "Groq Header Auth" } },
    },
    {
      parameters: { mode: "runOnceForEachItem", jsCode: assembleCode },
      id: "node-decide",
      name: "Decide & assemble",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [900, 320],
    },
    {
      parameters: {
        authentication: "serviceAccount",
        operation: "append",
        ...sheetLocator("Triage"),
        columns: { mappingMode: "autoMapInputData", value: {}, matchingColumns: [], schema: [] },
        options: {},
      },
      id: "node-sheet-triage",
      name: "Append to Triage",
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.5,
      position: [1120, 320],
      credentials: { googleApi: { id: "REPLACE_CRED_ID", name: "Google Service Account" } },
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
          combinator: "and",
          conditions: [
            {
              id: "cond-escalated",
              leftValue: "={{ $json.escalation_flag }}",
              rightValue: "YES",
              operator: { type: "string", operation: "equals" },
            },
          ],
        },
        options: {},
      },
      id: "node-if",
      name: "Is escalated?",
      type: "n8n-nodes-base.if",
      typeVersion: 2,
      position: [1340, 320],
    },
    {
      parameters: {
        authentication: "serviceAccount",
        operation: "append",
        ...sheetLocator("Escalation"),
        columns: { mappingMode: "autoMapInputData", value: {}, matchingColumns: [], schema: [] },
        options: {},
      },
      id: "node-sheet-esc",
      name: "Append to Escalation",
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.5,
      position: [1560, 200],
      credentials: { googleApi: { id: "REPLACE_CRED_ID", name: "Google Service Account" } },
    },
  ],
  connections: {
    Webhook: { main: [[{ node: "Build LLM request", type: "main", index: 0 }]] },
    "Build LLM request": { main: [[{ node: "Call LLM (Groq)", type: "main", index: 0 }]] },
    "Call LLM (Groq)": { main: [[{ node: "Decide & assemble", type: "main", index: 0 }]] },
    "Decide & assemble": { main: [[{ node: "Append to Triage", type: "main", index: 0 }]] },
    "Append to Triage": { main: [[{ node: "Is escalated?", type: "main", index: 0 }]] },
    "Is escalated?": { main: [[{ node: "Append to Escalation", type: "main", index: 0 }], []] },
  },
};

await writeFile("n8n/arcvault-triage.workflow.json", JSON.stringify(workflow, null, 2), "utf8");
console.log("Wrote n8n/arcvault-triage.workflow.json");

// --- Robust demo variant: same brain, no Google Sheets sink ---------------
// The Sheets nodes are the one fragile part across n8n versions (the columns
// mapping schema drifts). This variant swaps them for pass-through NoOp nodes
// that name the destination queue, so the branch is still visible and the only
// credential needed is the LLM header auth. The Google Sheet is populated by the
// code engine (`npm run triage -- --sheets`), so no evidence is lost.
const keep = workflow.nodes.filter(
  (n) => n.type !== "n8n-nodes-base.googleSheets",
);
const routeNode = (name: string, y: number) => ({
  parameters: {},
  id: `node-${name.toLowerCase().replace(/\W+/g, "-")}`,
  name,
  type: "n8n-nodes-base.noOp",
  typeVersion: 1,
  position: [1560, y] as [number, number],
});
const demoWorkflow = {
  ...workflow,
  name: "ArcVault — AI Intake & Triage (demo, no Sheets)",
  nodes: [...keep, routeNode("→ Standard queue", 420), routeNode("→ Escalation queue", 200)],
  connections: {
    Webhook: { main: [[{ node: "Build LLM request", type: "main", index: 0 }]] },
    "Build LLM request": { main: [[{ node: "Call LLM (Groq)", type: "main", index: 0 }]] },
    "Call LLM (Groq)": { main: [[{ node: "Decide & assemble", type: "main", index: 0 }]] },
    "Decide & assemble": { main: [[{ node: "Is escalated?", type: "main", index: 0 }]] },
    "Is escalated?": {
      main: [
        [{ node: "→ Escalation queue", type: "main", index: 0 }],
        [{ node: "→ Standard queue", type: "main", index: 0 }],
      ],
    },
  },
};
await writeFile("n8n/arcvault-triage.demo.workflow.json", JSON.stringify(demoWorkflow, null, 2), "utf8");
console.log("Wrote n8n/arcvault-triage.demo.workflow.json");
