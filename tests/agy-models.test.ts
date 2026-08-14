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
  test("groups last hyphen token when the same base appears twice or more", () => {
    const models = parseAgyModels(sample);
    expect(models["gemini-3.7-flash"]).toEqual({
      name: "Gemini 3.7 Flash",
      variants: {
        high: { model: "gemini-3.7-flash-high" },
        medium: { model: "gemini-3.7-flash-medium" },
        low: { model: "gemini-3.7-flash-low" },
      },
    });
    expect(models["gemini-3.7-flash-high"]).toBeUndefined();
  });

  test("keeps a lone suffixed id as-is", () => {
    const models = parseAgyModels(sample);
    expect(models["gemini-3.1-pro-high"]).toEqual({ name: "Gemini 3.1 Pro (High)" });
    expect(models["gpt-oss-120b-medium"]).toEqual({ name: "GPT-OSS 120B (Medium)" });
    expect(models["claude-opus-4-6-thinking"]).toEqual({ name: "Claude Opus 4.6 (Thinking)" });
    expect(models["claude-sonnet-4-6"]).toEqual({ name: "Claude Sonnet 4.6 (Thinking)" });
  });

  test("groups arbitrary suffixes, not only effort words", () => {
    const models = parseAgyModels("foo-fast\tFoo (fast)\nfoo-deep\tFoo (deep)\n");
    expect(models.foo).toEqual({
      name: "Foo",
      variants: {
        fast: { model: "foo-fast" },
        deep: { model: "foo-deep" },
      },
    });
  });

  test("parses space-aligned columns", () => {
    const models = parseAgyModels("gemini-3.6-flash-high   Gemini 3.6 Flash (High)\n");
    expect(models["gemini-3.6-flash-high"]).toEqual({ name: "Gemini 3.6 Flash (High)" });
  });
});
