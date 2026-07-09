import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TriageRecord } from "../schema.js";

/** Persist all records + a filtered escalation view (Step 5 output destination). */
export async function writeJsonOutputs(
  records: TriageRecord[],
  opts: { recordsPath: string; escalationPath: string },
): Promise<void> {
  await mkdir(dirname(opts.recordsPath), { recursive: true });
  const escalated = records.filter((r) => r.escalation.flagged);
  await writeFile(opts.recordsPath, JSON.stringify(records, null, 2), "utf8");
  await writeFile(opts.escalationPath, JSON.stringify(escalated, null, 2), "utf8");
}

/**
 * Append a single record to `records.json` and rebuild `escalation.json`.
 * Used by the webhook server, where messages arrive one at a time rather than
 * as a batch. Missing/unreadable files are treated as an empty log, so the first
 * ingest bootstraps the output. Returns the full record list after appending.
 */
export async function appendJsonOutput(
  record: TriageRecord,
  opts: { recordsPath: string; escalationPath: string },
): Promise<TriageRecord[]> {
  let existing: TriageRecord[] = [];
  try {
    const parsed = JSON.parse(await readFile(opts.recordsPath, "utf8"));
    if (Array.isArray(parsed)) existing = parsed as TriageRecord[];
  } catch {
    // No records file yet (or it's not valid JSON) — start a fresh log.
  }
  const records = [...existing, record];
  await writeJsonOutputs(records, opts);
  return records;
}
