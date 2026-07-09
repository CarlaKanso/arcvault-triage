import type { ChatArgs, LLMProvider } from "./types.js";

interface Config {
  apiKey: string;
  model: string;
}

/**
 * Google Gemini. Different request/response shape from the OpenAI family, so it
 * gets its own implementation — but it satisfies the same LLMProvider interface,
 * so the pipeline neither knows nor cares which one it's talking to.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  private readonly apiKey: string;

  constructor(cfg: Config) {
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
  }

  async complete({ system, user, temperature = 0.1 }: ChatArgs): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`gemini HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("gemini: empty completion");
    return content;
  }
}
