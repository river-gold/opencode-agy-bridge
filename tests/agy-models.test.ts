import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyAgyModels,
  isModelCacheFresh,
  parseAgyModels,
  saveModelCache,
} from "../src/agy-models";

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
  test("keeps original ids when suffix siblings exist without a base id", () => {
    const models = parseAgyModels(sample);
    expect(models["gemini-3.7-flash"]).toBeUndefined();
    expect(models["gemini-3.7-flash-high"]).toEqual({ name: "Gemini 3.7 Flash (High)" });
    expect(models["gemini-3.7-flash-medium"]).toEqual({ name: "Gemini 3.7 Flash (Medium)" });
    expect(models["gemini-3.7-flash-low"]).toEqual({ name: "Gemini 3.7 Flash (Low)" });
  });

  test("keeps a lone suffixed id as-is", () => {
    const models = parseAgyModels(sample);
    expect(models["gemini-3.1-pro-high"]).toEqual({ name: "Gemini 3.1 Pro (High)" });
    expect(models["gpt-oss-120b-medium"]).toEqual({ name: "GPT-OSS 120B (Medium)" });
    expect(models["claude-opus-4-6-thinking"]).toEqual({ name: "Claude Opus 4.6 (Thinking)" });
    expect(models["claude-sonnet-4-6"]).toEqual({ name: "Claude Sonnet 4.6 (Thinking)" });
  });

  test("groups suffix siblings when the base id is also present", () => {
    const models = parseAgyModels(
      "gemini-3.7-flash\tGemini 3.7 Flash\n" +
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n" +
        "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n" +
        "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n",
    );
    expect(models["gemini-3.7-flash"]).toEqual({
      name: "Gemini 3.7 Flash",
      variants: {
        high: { model: "gemini-3.7-flash-high" },
        medium: { model: "gemini-3.7-flash-medium" },
        low: { model: "gemini-3.7-flash-low" },
      },
    });
    expect(models["gemini-3.7-flash-high"]).toBeUndefined();
    expect(models["gemini-3.7-flash-medium"]).toBeUndefined();
    expect(models["gemini-3.7-flash-low"]).toBeUndefined();
  });

  test("groups arbitrary suffixes when the base id is also present", () => {
    const models = parseAgyModels("foo\tFoo\nfoo-fast\tFoo (fast)\nfoo-deep\tFoo (deep)\n");
    expect(models.foo).toEqual({
      name: "Foo",
      variants: {
        fast: { model: "foo-fast" },
        deep: { model: "foo-deep" },
      },
    });
    expect(models["foo-fast"]).toBeUndefined();
    expect(models["foo-deep"]).toBeUndefined();
  });

  test("parses space-aligned columns", () => {
    const models = parseAgyModels("gemini-3.6-flash-high   Gemini 3.6 Flash (High)\n");
    expect(models["gemini-3.6-flash-high"]).toEqual({ name: "Gemini 3.6 Flash (High)" });
  });
});

describe("model cache", () => {
  test("isModelCacheFresh is false when missing or expired", () => {
    expect(isModelCacheFresh(null, 1000, 100)).toBe(false);
    expect(isModelCacheFresh({ binary: "agy", fetchedAt: 0, models: {} }, 200, 100)).toBe(false);
    expect(isModelCacheFresh({ binary: "agy", fetchedAt: 150, models: {} }, 200, 100)).toBe(true);
  });

  test("uses cache without listing when fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-models-cache-"));
    const cacheFile = join(dir, "models.json");
    let listed = 0;
    try {
      await saveModelCache(cacheFile, {
        binary: "agy",
        fetchedAt: 1000,
        models: { "cached-model": { name: "Cached" } },
      });
      const cfg: { provider?: Record<string, any> } = {};
      await applyAgyModels(cfg, {
        cacheFile,
        now: 1000,
        ttlMs: 10_000,
        list: async () => {
          listed += 1;
          return { "fresh-model": { name: "Fresh" } };
        },
      });
      expect(listed).toBe(0);
      expect(cfg.provider?.agy?.models["cached-model"]).toEqual({ name: "Cached" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stale cache is used immediately and refresh writes next cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-models-cache-"));
    const cacheFile = join(dir, "models.json");
    try {
      await saveModelCache(cacheFile, {
        binary: "agy",
        fetchedAt: 0,
        models: { "cached-model": { name: "Cached" } },
      });
      const cfg: { provider?: Record<string, any> } = {};
      await applyAgyModels(cfg, {
        cacheFile,
        now: 10_000,
        ttlMs: 100,
        waitRefresh: true,
        list: async () => ({ "fresh-model": { name: "Fresh" } }),
      });
      expect(cfg.provider?.agy?.models["cached-model"]).toEqual({ name: "Cached" });
      expect(cfg.provider?.agy?.models["fresh-model"]).toBeUndefined();

      const next: { provider?: Record<string, any> } = {};
      await applyAgyModels(next, {
        cacheFile,
        now: 10_000,
        ttlMs: 100_000,
        list: async () => {
          throw new Error("should not list");
        },
      });
      expect(next.provider?.agy?.models["fresh-model"]).toEqual({ name: "Fresh" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists when cache JSON has no version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-models-cache-"));
    const cacheFile = join(dir, "models.json");
    let listed = 0;
    try {
      await writeFile(
        cacheFile,
        JSON.stringify({
          binary: "agy",
          fetchedAt: 1000,
          models: { "cached-model": { name: "Cached" } },
        }),
        "utf-8",
      );
      const cfg: { provider?: Record<string, any> } = {};
      await applyAgyModels(cfg, {
        cacheFile,
        now: 1000,
        ttlMs: 10_000,
        list: async () => {
          listed += 1;
          return { "fresh-model": { name: "Fresh" } };
        },
      });
      expect(listed).toBe(1);
      expect(cfg.provider?.agy?.models["fresh-model"]).toEqual({ name: "Fresh" });
      expect(cfg.provider?.agy?.models["cached-model"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists once when cache is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-models-cache-"));
    const cacheFile = join(dir, "models.json");
    try {
      const cfg: { provider?: Record<string, any> } = {};
      await applyAgyModels(cfg, {
        cacheFile,
        now: 1,
        list: async () => ({ "fresh-model": { name: "Fresh" } }),
      });
      expect(cfg.provider?.agy?.models["fresh-model"]).toEqual({ name: "Fresh" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips discovery when models are configured manually", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-models-cache-"));
    const cacheFile = join(dir, "models.json");
    let listed = 0;
    try {
      const models = { manual: { name: "Manual" } };
      const cfg: { provider?: Record<string, any> } = {
        provider: { agy: { models } },
      };
      await applyAgyModels(cfg, {
        cacheFile,
        list: async () => {
          listed += 1;
          return { automatic: { name: "Automatic" } };
        },
      });
      expect(listed).toBe(0);
      expect(cfg.provider?.agy?.models).toBe(models);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("discovers models when configured models are empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-models-cache-"));
    const cacheFile = join(dir, "models.json");
    try {
      const cfg: { provider?: Record<string, any> } = {
        provider: { agy: { models: {} } },
      };
      await applyAgyModels(cfg, {
        cacheFile,
        now: 1,
        list: async () => ({ automatic: { name: "Automatic" } }),
      });
      expect(cfg.provider?.agy?.models.automatic).toEqual({ name: "Automatic" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
