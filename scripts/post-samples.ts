/**
 * Fire the 5 sample messages at a running n8n webhook, one by one, so you can
 * screenshot the executions and the Google Sheet filling up.
 *
 *   npx tsx scripts/post-samples.ts http://localhost:5678/webhook/arcvault-triage
 *
 * (Use the "Test URL" while the workflow editor is open, or the "Production URL"
 * after you Activate the workflow.)
 */
import { readFile } from "node:fs/promises";

// Defaults to the local n8n test webhook; pass a URL to target another (e.g. the
// Production URL after you Activate the workflow).
const url = process.argv[2] ?? "http://localhost:5678/webhook/arcvault-triage";
console.log(`Posting samples to ${url}`);

const samples = JSON.parse(await readFile("data/samples.json", "utf8")) as unknown[];

for (const msg of samples) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  const text = await res.text();
  const id = (msg as { id: string }).id;
  console.log(`\n=== POST ${id} → HTTP ${res.status} ===`);
  console.log(text.slice(0, 800));
}
