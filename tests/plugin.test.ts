import { describe, test, expect } from "bun:test";
import plugin from "../src/plugin.js";
import unified from "../src/index.js";

const directory = "/tmp/opencode-workspace";

async function configOf(entry: (input: any) => Promise<any> | any, input: any) {
  const hooks = await entry(input);
  return hooks.config as (cfg: Record<string, any>) => Promise<void>;
}

async function headersOf(entry: (input: any) => Promise<any> | any, input: any) {
  const hooks = await entry(input);
  return hooks["chat.headers"] as (incoming: any, output: any) => Promise<void>;
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

describe("plugin chat.headers session scope", () => {
  const pluginInput = { directory, client: {} };

  for (const [name, entry] of [
    ["plugin", plugin],
    ["unified", unified],
  ] as const) {
    test(`${name} sets original session id and agent scope for helper agents`, async () => {
      const hook = await headersOf(entry, pluginInput);
      for (const agent of ["title", "summary", "compaction"]) {
        const output = { headers: {} as Record<string, string> };
        await hook(
          { sessionID: "sess-orig", agent, model: { providerID: "agy" } },
          output,
        );
        expect(output.headers["x-agy-session-id"]).toBe("sess-orig");
        expect(output.headers["x-agy-session-scope"]).toBe(agent);
      }
    });

    test(`${name} sets session id without scope for build agent`, async () => {
      const hook = await headersOf(entry, pluginInput);
      const output = { headers: {} as Record<string, string> };
      await hook(
        { sessionID: "sess-orig", agent: "build", model: { providerID: "agy" } },
        output,
      );
      expect(output.headers["x-agy-session-id"]).toBe("sess-orig");
      expect(output.headers["x-agy-session-scope"]).toBeUndefined();
    });

    test(`${name} does not add session headers for non-agy provider`, async () => {
      const hook = await headersOf(entry, pluginInput);
      const output = { headers: {} as Record<string, string> };
      await hook(
        { sessionID: "sess-orig", agent: "title", model: { providerID: "openai" } },
        output,
      );
      expect(output.headers["x-agy-session-id"]).toBeUndefined();
      expect(output.headers["x-agy-session-scope"]).toBeUndefined();
    });

    test(`${name} sets x-agy-effort from message.model.variant when top-level variant is absent`, async () => {
      const hook = await headersOf(entry, pluginInput);
      const output = { headers: {} as Record<string, string> };
      await hook(
        {
          sessionID: "sess-orig",
          agent: "build",
          model: {
            providerID: "agy",
            options: { effort: "low", reasoningEffort: "low" },
            effort: "low",
            reasoningEffort: "low",
          },
          provider: { options: { effort: "low", reasoningEffort: "low" } },
          message: { model: { variant: "high" } },
        },
        output,
      );
      expect(output.headers["x-agy-effort"]).toBe("high");
    });
  }
});
