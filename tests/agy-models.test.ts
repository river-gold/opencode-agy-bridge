import { describe, test, expect } from "bun:test";
import { parseAgyModels } from "../src/agy-models";

const sample = `Fetching available models...
gemini-3.7-flash-high	Gemini 3.7 Flash (High)
gemini-3.7-flash-medium	Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low	Gemini 3.7 Flash (Low)
gemini-3.1-pro-high	Gemini 3.1 Pro (High)
claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking	Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium	GPT-OSS 120B (Medium)
`;

describe("parseAgyModels", () => {
  test("keeps agy model ids including effort suffix", () => {
    const models = parseAgyModels(sample);
    expect(models["gemini-3.7-flash-high"]).toEqual({ name: "Gemini 3.7 Flash (High)" });
    expect(models["gemini-3.7-flash-medium"]).toEqual({ name: "Gemini 3.7 Flash (Medium)" });
    expect(models["gemini-3.7-flash-low"]).toEqual({ name: "Gemini 3.7 Flash (Low)" });
    expect(models["gpt-oss-120b-medium"]).toEqual({ name: "GPT-OSS 120B (Medium)" });
    expect(models["gemini-3.7-flash"]).toBeUndefined();
  });

  test("keeps ids without effort suffix as-is", () => {
    const models = parseAgyModels(sample);
    expect(models["claude-sonnet-4-6"]).toEqual({ name: "Claude Sonnet 4.6 (Thinking)" });
    expect(models["claude-opus-4-6-thinking"]).toEqual({ name: "Claude Opus 4.6 (Thinking)" });
  });

  test("parses space-aligned columns", () => {
    const models = parseAgyModels("gemini-3.6-flash-high   Gemini 3.6 Flash (High)\n");
    expect(models["gemini-3.6-flash-high"]).toEqual({ name: "Gemini 3.6 Flash (High)" });
  });
});
