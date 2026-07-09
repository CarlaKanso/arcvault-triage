import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { availableProviders, getProvider, type ProviderName } from "./providers/index.js";
import { triageOne } from "./triage.js";
import { loadSamples, parseArgs, resolveModel } from "./util.js";

/**
 * Compare mode: run the same messages through 2+ providers and diff the
 * classifications. Two payoffs:
 *  1. Proves the prompt isn't overfit to one model (prompt-quality evidence).
 *  2. Cross-model agreement is a second, independent confidence signal — where
 *     models disagree is exactly where a human should look. This is honest
 *     material for the "what did the AI get wrong" interview question.
 *
 *   npm run compare                              # all providers with a key set
 *   npm run compare -- --providers=openai,groq   # pick the field
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const names: ProviderName[] = args.providers
    ? (String(args.providers).split(",") as ProviderName[])
    : availableProviders();

  if (names.length < 2) {
    console.error(
      `Compare needs >=2 providers with keys set. Available now: [${names.join(", ") || "none"}].`,
    );
    process.exit(1);
  }

  const providers = names.map((n) => getProvider(n, resolveModel(undefined, n)));
  const messages = await loadSamples((args.input as string) ?? "data/samples.json");
  console.log(`Comparing ${messages.length} messages across: ${names.join(", ")}\n`);

  const rows = [];
  for (const msg of messages) {
    const results = await Promise.allSettled(providers.map((p) => triageOne(p, msg)));
    const byProvider: Record<string, unknown> = {};
    const categories = new Set<string>();
    const escalations = new Set<boolean>();
    let successCount = 0;

    results.forEach((res, i) => {
      const name = providers[i].name;
      if (res.status === "fulfilled") {
        const r = res.value;
        successCount++;
        categories.add(r.classification.category);
        escalations.add(r.escalation.flagged);
        byProvider[name] = {
          category: r.classification.category,
          priority: r.classification.priority,
          confidence: r.classification.confidence,
          final_destination: r.routing.final_destination,
          escalated: r.escalation.flagged,
        };
      } else {
        byProvider[name] = { error: res.reason?.message ?? String(res.reason) };
      }
    });

    // Agreement is only meaningful when >=2 providers actually answered. A
    // provider that errored must never be counted as consensus.
    const comparable = successCount >= 2;
    const categoryAgreement = comparable ? categories.size === 1 : null;
    const escalationAgreement = comparable ? escalations.size === 1 : null;
    rows.push({
      id: msg.id,
      message: msg.raw_message,
      providers_succeeded: successCount,
      comparable,
      category_agreement: categoryAgreement,
      escalation_agreement: escalationAgreement,
      byProvider,
    });

    const mark = !comparable
      ? `⚠ only ${successCount} provider(s) answered — not comparable`
      : categoryAgreement
        ? `✓ agree (${[...categories][0]})`
        : `✗ DISAGREE  ${[...categories].join(" / ")}`;
    console.log(`${msg.id}  category ${mark}`);
    if (!comparable || !categoryAgreement || !escalationAgreement) {
      for (const [name, v] of Object.entries(byProvider)) {
        console.log(`      ${name.padEnd(7)} ${JSON.stringify(v)}`);
      }
    }
  }

  await mkdir("output", { recursive: true });
  await writeFile("output/comparison.json", JSON.stringify(rows, null, 2), "utf8");
  const comparableRows = rows.filter((r) => r.comparable);
  const disagreements = comparableRows.filter((r) => r.category_agreement === false).length;
  console.log(
    `\nWrote output/comparison.json · ${comparableRows.length}/${rows.length} rows comparable · ` +
      `${disagreements} category disagreement(s)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
