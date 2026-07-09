import "dotenv/config";
import { getProvider } from "./providers/index.js";
import { triageOne } from "./triage.js";
import { writeJsonOutputs } from "./sinks/jsonFile.js";
import { sheetsConfigFromEnv, writeToSheets } from "./sinks/sheets.js";
import { loadSamples, parseArgs, printSummary, resolveModel, resolveProviderName } from "./util.js";

/**
 * CLI entrypoint — Step 1 (ingestion of the batch) through Step 5 (output).
 *
 *   npm run triage                      # default provider, writes output/*.json
 *   npm run triage -- --provider=groq   # pick a provider
 *   npm run triage -- --sheets          # also push to Google Sheets
 *   npm run triage -- --input=data/samples.json
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const providerName = resolveProviderName(args.provider as string | undefined);
  const model = resolveModel(args.model as string | undefined, providerName);
  const inputPath = (args.input as string) ?? "data/samples.json";

  const provider = getProvider(providerName, model);
  const messages = await loadSamples(inputPath);

  console.log(`Triaging ${messages.length} messages with ${providerName}/${model}…`);

  // Process one at a time. Free-tier LLM APIs have low per-minute limits, so a
  // concurrent burst gets rate-limited; sequential processing plus the
  // retry/backoff inside triageOne keeps a small batch comfortably within them.
  // Failures are still captured per-message so one bad message never sinks the batch.
  const records = [];
  for (const m of messages) {
    try {
      records.push(await triageOne(provider, m));
    } catch (err) {
      console.error(`✗ ${m.id} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  await writeJsonOutputs(records, {
    recordsPath: "output/records.json",
    escalationPath: "output/escalation.json",
  });
  console.log("Wrote output/records.json and output/escalation.json");

  if (args.sheets) {
    const cfg = sheetsConfigFromEnv();
    if (!cfg) {
      console.error("--sheets requested but GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON are not set.");
    } else {
      await writeToSheets(records, cfg);
      console.log(`Wrote ${records.length} rows to Google Sheet ${cfg.spreadsheetId}`);
    }
  }

  printSummary(records);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
