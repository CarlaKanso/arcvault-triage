import type { ChatArgs, LLMProvider, ProviderName } from "./types.js";

interface Config {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Works for OpenAI and any OpenAI-compatible endpoint (Groq, Together, Mistral,
 * local vLLM, ...). Both providers we ship on this path differ only by baseUrl,
 * key, and model name — so there is exactly one implementation to maintain.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(cfg: Config) {
    this.name = cfg.name;
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
  }

  async complete({ system, user, temperature = 0.1 }: ChatArgs): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${this.name} HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name}: empty completion`);
    return content;
  }
}
