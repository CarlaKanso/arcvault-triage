import { readFile } from "node:fs/promises";
import { google } from "googleapis";
import type { TriageRecord } from "../schema.js";

/**
 * Google Sheets sink (Step 5 destination). Uses a service account so it runs
 * headless — no interactive OAuth. Share your Sheet with the service account's
 * client_email as Editor, then set GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON.
 *
 * We CLEAR and rewrite each tab per run so re-running the demo never leaves
 * duplicated rows — the sheet always reflects the latest triage exactly.
 */

const HEADER = [
  "id", "source", "received_at",
  "category", "priority", "confidence",
  "primary_queue", "final_destination", "escalation_flag", "escalation_reasons",
  "core_issue", "account", "invoice_number", "error_code", "amount", "expected_amount", "other",
  "urgency_signal", "summary",
  "provider", "model", "raw_message",
];

function toRow(r: TriageRecord): (string | number)[] {
  const id = r.enrichment.identifiers;
  return [
    r.id, r.source, r.received_at,
    r.classification.category, r.classification.priority, r.classification.confidence,
    r.routing.primary_queue, r.routing.final_destination,
    r.escalation.flagged ? "YES" : "no", r.escalation.reasons.join(" | "),
    r.enrichment.core_issue,
    id.account ?? "", id.invoice_number ?? "", id.error_code ?? "",
    id.amount ?? "", id.expected_amount ?? "", id.other.join(", "),
    r.enrichment.urgency_signal, r.summary,
    r.model.provider, r.model.model, r.raw_message,
  ];
}

export interface SheetsConfig {
  serviceAccountJsonPath: string;
  spreadsheetId: string;
}

export function sheetsConfigFromEnv(): SheetsConfig | null {
  const serviceAccountJsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!serviceAccountJsonPath || !spreadsheetId) return null;
  return { serviceAccountJsonPath, spreadsheetId };
}

async function getClient(cfg: SheetsConfig) {
  const raw = await readFile(cfg.serviceAccountJsonPath, "utf8");
  const creds = JSON.parse(raw) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

/** Write all records to the Triage tab and flagged ones to the Escalation tab. */
export async function writeToSheets(records: TriageRecord[], cfg: SheetsConfig): Promise<void> {
  const sheets = await getClient(cfg);

  // Ensure both tabs exist.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.spreadsheetId });
  const existing = new Set(meta.data.sheets?.map((s) => s.properties?.title));
  const toCreate = ["Triage", "Escalation"].filter((t) => !existing.has(t));
  if (toCreate.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cfg.spreadsheetId,
      requestBody: {
        requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  const escalated = records.filter((r) => r.escalation.flagged);
  await writeTab(sheets, cfg.spreadsheetId, "Triage", records);
  await writeTab(sheets, cfg.spreadsheetId, "Escalation", escalated);
}

async function writeTab(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  title: string,
  records: TriageRecord[],
): Promise<void> {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: title });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${title}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADER, ...records.map(toRow)] },
  });
}
