import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import { getProvider, type LLMProvider } from "./providers/index.js";
import { triageOne } from "./triage.js";
import { InboundSchema } from "./schema.js";
import { appendJsonOutput, writeJsonOutputs } from "./sinks/jsonFile.js";
import { loadSamples, resolveModel, resolveProviderName } from "./util.js";

/**
 * Pure-code delivery surface — the HTTP webhook server. This is what replaces
 * n8n's runtime role (a live endpoint that triages inbound messages). It reuses
 * the exact same engine as the batch CLI: getProvider → triageOne → decide → sinks.
 * No triage logic lives here; the server is just transport + I/O.
 */

const RECORDS_PATH = "output/records.json";
const ESCALATION_PATH = "output/escalation.json";
const OUTPUT_OPTS = { recordsPath: RECORDS_PATH, escalationPath: ESCALATION_PATH };

/**
 * Build the Express app around a given provider. The provider is injected (rather
 * than built inside) so tests can pass a fake one with no API key or network.
 */
export function createApp(provider: LLMProvider): express.Express {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // Optional API-key gate. Only enforced when API_KEY is set, so local/demo use
  // stays frictionless while a deployment can lock it down with one env var.
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.header("x-api-key") !== apiKey) {
        res.status(401).json({ error: "Invalid or missing x-api-key header." });
        return;
      }
      next();
    });
  }

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", provider: provider.name, model: provider.model });
  });

  /**
   * POST /webhook/ingest — triage a single message.
   * Accepts this repo's shape { id?, source, received_at?, raw_message } and also
   * the atwi-style { source, message }; missing fields are filled with defaults.
   */
  app.post("/webhook/ingest", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawMessage = body.raw_message ?? body.message;
      if (typeof rawMessage !== "string" || rawMessage.trim() === "") {
        res.status(400).json({ error: "Body must include 'raw_message' (or 'message') as a non-empty string." });
        return;
      }

      const parsed = InboundSchema.safeParse({
        id: body.id ?? `req-${randomUUID()}`,
        source: body.source ?? "Unknown",
        received_at: body.received_at ?? new Date().toISOString(),
        raw_message: rawMessage,
      });
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body.", details: parsed.error.flatten() });
        return;
      }

      const record = await triageOne(provider, parsed.data);
      await appendJsonOutput(record, OUTPUT_OPTS);
      res.status(200).json(record);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /process-all — run a whole sample file through the pipeline (HTTP twin of
   * the batch CLI). Override the input file with ?input=path. Per-message failures
   * are captured so one bad message never sinks the batch.
   */
  app.post("/process-all", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inputPath = typeof req.query.input === "string" ? req.query.input : "data/samples.json";
      const messages = await loadSamples(inputPath);

      // Sequential for the same reason as the batch CLI: free-tier rate limits
      // punish a concurrent burst. triageOne backs off on rate-limit errors.
      const records = [];
      const errors: Array<{ id: string; error: string }> = [];
      for (const m of messages) {
        try {
          records.push(await triageOne(provider, m));
        } catch (err) {
          errors.push({ id: m.id, error: (err as Error)?.message ?? String(err) });
        }
      }

      await writeJsonOutputs(records, OUTPUT_OPTS);
      res.status(200).json({
        processed: records.length,
        escalated: records.filter((r) => r.escalation.flagged).length,
        errors,
        records,
      });
    } catch (err) {
      next(err);
    }
  });

  // Global error handler — never leak internals to the caller.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

/** Boot the server with the provider/model chosen by env (TRIAGE_PROVIDER/TRIAGE_MODEL). */
function start(): void {
  const providerName = resolveProviderName(undefined);
  const model = resolveModel(undefined, providerName);
  const provider = getProvider(providerName, model);
  const port = Number(process.env.PORT ?? 3000);

  createApp(provider).listen(port, () => {
    console.log(`ArcVault triage server → http://localhost:${port}  (${providerName}/${model})`);
    console.log("  POST /webhook/ingest   { source, raw_message }  (or { source, message })");
    console.log("  POST /process-all      runs data/samples.json");
    console.log("  GET  /health");
  });
}

// Auto-start only when run directly (npm run serve), never on import (tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
