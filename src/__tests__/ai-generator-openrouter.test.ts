import { describe, it, expect, vi } from "vitest";
import {
  generateAIPitch,
  MODEL_CHAIN,
  type PitchGenerateInput,
} from "../lib/ai-generator.js";

const input = {
  artistName: "The Remedy",
  contactName: "Sarah",
  tone: "professional",
} as unknown as PitchGenerateInput;

const reply = `---SUBJECT---
Drift
---VARIANT 1---
Direct
---VARIANT 2---
Story
---VARIANT 3---
Value
---END---`;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("generateAIPitch on OpenRouter", () => {
  it("asks the approved pair in order, deepseek first", () => {
    expect(MODEL_CHAIN).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "~z-ai/glm-flash-latest",
    ]);
  });

  it("sends an OpenAI-style request to OpenRouter with the key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response(200, { choices: [{ message: { content: reply } }] }),
      );

    const result = await generateAIPitch(
      input,
      "or-key",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.subject).toBe("Drift");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer or-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(body.messages[0].role).toBe("system");
  });

  it("falls over to GLM when deepseek refuses the request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(404, { error: { message: "No endpoints found" } }),
      )
      .mockResolvedValueOnce(
        response(200, { choices: [{ message: { content: reply } }] }),
      );

    const result = await generateAIPitch(
      input,
      "or-key",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.body).toBe("Direct");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).model).toBe(
      "~z-ai/glm-flash-latest",
    );
  });

  it("names every model in the error when the whole chain fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response(400, { error: { message: "bad" } }));

    await expect(
      generateAIPitch(input, "or-key", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/deepseek-v4\.1-flash.*glm-flash-latest/);
  });
});
