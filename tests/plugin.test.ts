import { describe, test, expect } from "bun:test";
import plugin from "../src/plugin.js";
import unified from "../src/index.js";

const directory = "/tmp/opencode-workspace";

async function configOf(entry: (input: any) => Promise<any> | any, input: any) {
  const hooks = await entry(input);
  return hooks.config as (cfg: Record<string, any>) => Promise<void>;
}

describe("plugin directory cwd injection", () => {
  test("plugin path injects PluginInput.directory when cwd is unset", async () => {
    const config = await configOf(plugin, { directory, client: {} });
    const cfg: Record<string, any> = { provider: { agy: { models: { x: { name: "x" } } } } };
    await config(cfg);
    expect(cfg.provider.agy.options.cwd).toBe(directory);
  });

  test("plugin path preserves user-configured cwd", async () => {
    const config = await configOf(plugin, { directory, client: {} });
    const cfg: Record<string, any> = {
      provider: { agy: { models: { x: { name: "x" } }, options: { cwd: "/explicit" } } },
    };
    await config(cfg);
    expect(cfg.provider.agy.options.cwd).toBe("/explicit");
  });

  test("unified plugin path injects PluginInput.directory when cwd is unset", async () => {
    const config = await configOf(unified, { directory, client: {} });
    const cfg: Record<string, any> = { provider: { agy: { models: { x: { name: "x" } } } } };
    await config(cfg);
    expect(cfg.provider.agy.options.cwd).toBe(directory);
  });

  test("unified plugin path preserves user-configured cwd", async () => {
    const config = await configOf(unified, { directory, client: {} });
    const cfg: Record<string, any> = {
      provider: { agy: { models: { x: { name: "x" } }, options: { cwd: "/explicit" } } },
    };
    await config(cfg);
    expect(cfg.provider.agy.options.cwd).toBe("/explicit");
  });

  for (const [name, entry] of [
    ["plugin", plugin],
    ["unified", unified],
  ] as const) {
    test(`${name} path does not inject blank directory`, async () => {
      const models = { x: { name: "x" } };
      for (const blank of ["", "   "]) {
        const config = await configOf(entry, { directory: blank, client: {} });
        const cfg: Record<string, any> = { provider: { agy: { models } } };
        await config(cfg);
        expect(cfg.provider.agy.options?.cwd).toBeUndefined();
      }
    });

    test(`${name} path preserves configured empty cwd`, async () => {
      const config = await configOf(entry, { directory, client: {} });
      const cfg: Record<string, any> = {
        provider: { agy: { models: { x: { name: "x" } }, options: { cwd: "" } } },
      };
      await config(cfg);
      expect(cfg.provider.agy.options.cwd).toBe("");
    });
  }
});
