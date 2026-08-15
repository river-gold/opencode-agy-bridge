import { describe, test, expect } from "bun:test";
import { createAgyProvider } from "../src/provider.js";
import { writeFile, chmod, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

describe("AgyProvider model selection", () => {
  test("passes --model when specific modelId is provided", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp, stateFile: join(tmp, "sessions.json") });
      const model = provider("gemini-3.6-flash");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain("--model gemini-3.6-flash");
      expect(text).not.toContain("--effort");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("parses model:effort string and passes both flags", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp, stateFile: join(tmp, "sessions.json") });
      const model = provider("gemini-3.6-flash:high");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain("--model gemini-3.6-flash");
      expect(text).toContain("--effort high");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("omits --effort for trailing colon or empty effort", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const cases: Array<{ modelId: string; effort?: string }> = [
        { modelId: "gemini-3.6-flash:" },
        { modelId: "gemini-3.6-flash", effort: "" },
      ];

      for (const c of cases) {
        const provider = createAgyProvider({
          binary: mockBinary,
          conversationsDir: tmp,
          stateFile: join(tmp, "sessions.json"),
          ...(c.effort !== undefined ? { effort: c.effort } : {}),
        });
        const model = provider(c.modelId);
        const result = await model.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        });

        const text = result.content[0].type === "text" ? result.content[0].text : "";
        expect(text).toContain("--model gemini-3.6-flash");
        expect(text).not.toContain("--effort");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("supports default model and effort in provider options", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile: join(tmp, "sessions.json"),
        model: "gemini-3.1-pro",
        effort: "low",
      });
      const model = provider("gemini-3.1-pro");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain("--model gemini-3.1-pro");
      expect(text).toContain("--effort low");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("uses options.model when callable is invoked without modelId", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile: join(tmp, "sessions.json"),
        model: "default-model",
      });
      const model = provider();
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain("--model default-model");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("explicit modelId takes precedence over options.model", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile: join(tmp, "sessions.json"),
        model: "default-model",
      });
      const model = provider("explicit-model");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain("--model explicit-model");
      expect(text).not.toContain("default-model");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("uses x-agy-effort header when provided in callOpts", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp, stateFile: join(tmp, "sessions.json") });
      const model = provider("gemini-3.6-flash");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        headers: { "x-agy-effort": "high" },
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain("--model gemini-3.6-flash");
      expect(text).toContain("--effort high");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("x-agy-variant remaps base model id and skips --effort", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp, stateFile: join(tmp, "sessions.json") });
      const model = provider("gemini-3.7-flash");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        headers: { "x-agy-variant": "high" },
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain("--model gemini-3.7-flash-high");
      expect(text).not.toContain("--effort");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("uses explicit provider cwd for --add-dir and spawn cwd", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const workspace = await mkdtemp(join(tmpdir(), "agy-workspace-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
echo "PWD=$PWD"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        cwd: workspace,
      });
      const model = provider("gemini-3.6-flash");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain(`--add-dir ${workspace}`);
      expect(text).toContain(`PWD=${realpathSync(workspace)}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("falls back to process.cwd when provider cwd is absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
echo "PWD=$PWD"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp });
      const model = provider("gemini-3.6-flash");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain(`--add-dir ${process.cwd()}`);
      expect(text).toContain(`PWD=${realpathSync(process.cwd())}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("falls back to process.cwd when provider cwd is blank", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
echo "PWD=$PWD"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      for (const cwd of ["", "   "]) {
        const provider = createAgyProvider({
          binary: mockBinary,
          conversationsDir: tmp,
          cwd,
        });
        const model = provider("gemini-3.6-flash");
        const result = await model.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        });

        const text = result.content[0].type === "text" ? result.content[0].text : "";
        expect(text).toContain(`--add-dir ${process.cwd()}`);
        expect(text).toContain(`PWD=${realpathSync(process.cwd())}`);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("AgyProvider stream-json", () => {
  test("doStream emits incremental text-delta then finish", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' '{"event":"init","conversation_id":"conv-1"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"Hel"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"lo"}'
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"Hello"}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"Hello","conversation_id":"conv-1"}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp, stateFile: join(tmp, "sessions.json") });
      const model = provider("gemini-3.6-flash");
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const reader = stream.getReader();
      const deltas: string[] = [];
      let finished = false;
      const readAll = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value.type === "text-delta") {
          deltas.push(value.delta);
        }
        if (value.type === "finish") {
          finished = true;
        }
        return readAll();
      };
      await readAll();

      expect(deltas.join("")).toBe("Hello");
      expect(finished).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("doStream handles repeated identical chunks correctly", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' '{"event":"init","conversation_id":"conv-rep"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"ha"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"ha"}'
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"haha"}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"haha","conversation_id":"conv-rep"}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp });
      const model = provider("gemini-3.6-flash");
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const reader = stream.getReader();
      const deltas: string[] = [];
      let finished = false;
      const readAll = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value.type === "text-delta") {
          deltas.push(value.delta);
        }
        if (value.type === "finish") {
          finished = true;
        }
        return readAll();
      };
      await readAll();

      expect(deltas).toEqual(["ha", "ha"]);
      expect(deltas.join("")).toBe("haha");
      expect(finished).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("doGenerate rejects and does not commit state on non-zero exit with partial stdout", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");
    const stateFile = join(tmp, "sessions.json");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' '{"event":"init","conversation_id":"conv-fail"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"Partial text before crash"}'
echo "fatal crash" >&2
exit 1
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile,
      });
      const model = provider("gemini-3.6-flash");
      const sessionId = "session-partial-fail";

      await expect(
        model.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          headers: { "x-agy-session-id": sessionId },
        }),
      ).rejects.toThrow("fatal crash");

      const { SessionStore } = await import("../src/session-store.js");
      const store = new SessionStore(stateFile);
      const entry = await store.getEntry(sessionId);
      expect(entry).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("doGenerate rejects and does not commit state when aborted", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");
    const stateFile = join(tmp, "sessions.json");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
sleep 10
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile,
      });
      const model = provider("gemini-3.6-flash");
      const sessionId = "session-abort";
      const ac = new AbortController();

      const promise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        headers: { "x-agy-session-id": sessionId },
        abortSignal: ac.signal,
      });

      setTimeout(() => ac.abort(), 50);

      let caughtErr: unknown;
      try {
        await promise;
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect((caughtErr as Error).name).toBe("AbortError");

      const { SessionStore } = await import("../src/session-store.js");
      const store = new SessionStore(stateFile);
      const entry = await store.getEntry(sessionId);
      expect(entry).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("AgyProvider bound turn prompt", () => {
  test("stable session forwards only latest user text on compacted second turn", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");
    const invocationsLog = join(tmp, "invocations.log");
    const stateFile = join(tmp, "sessions.json");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${invocationsLog}"
printf '\\n---INV---\\n' >> "${invocationsLog}"
printf '%s\\n' '{"event":"init","conversation_id":"conv-bound-1"}'
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"PRIOR_ASSISTANT_MARKER"}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"PRIOR_ASSISTANT_MARKER","conversation_id":"conv-bound-1"}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile,
      });
      const model = provider("gemini-3.6-flash");
      const sessionHeaders = { "x-agy-session-id": "sess-stable-cursor" };

      await model.doGenerate({
        prompt: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: [{ type: "text", text: "FIRST_REQUEST_MARKER" }] },
          { role: "user", content: [{ type: "text", text: "FIRST_FOLLOWUP_MARKER" }] },
        ],
        headers: sessionHeaders,
      });

      await model.doGenerate({
        prompt: [
          { role: "assistant", content: [{ type: "text", text: "PRIOR_ASSISTANT_MARKER" }] },
          { role: "user", content: [{ type: "text", text: "SECOND_REQUEST_MARKER" }] },
        ],
        headers: sessionHeaders,
      });

      const log = await readFile(invocationsLog, "utf-8");
      const invocations = log.split("---INV---").map((part) => part.trim()).filter(Boolean);
      expect(invocations.length).toBe(2);

      expect(invocations[0]).toContain("FIRST_FOLLOWUP_MARKER");
      expect(invocations[1]).toContain("SECOND_REQUEST_MARKER");
      expect(invocations[1]).toContain("--conversation");
      expect(invocations[1]).toContain("conv-bound-1");
      expect(invocations[1]).not.toContain("FIRST_REQUEST_MARKER");
      expect(invocations[1]).not.toContain("FIRST_FOLLOWUP_MARKER");
      expect(invocations[1]).not.toContain("PRIOR_ASSISTANT_MARKER");
      expect(invocations[1]).not.toContain("[Previous Conversation Context]");

      const persisted = JSON.parse(await readFile(stateFile, "utf-8"));
      expect(persisted.sessions["sess-stable-cursor"].processedMessages).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("forwards multiple current user messages after last assistant", async () => {
    const ctx = await setupBoundProvider();
    try {
      await ctx.model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "STALE_USER_MARKER" }] },
          { role: "assistant", content: [{ type: "text", text: "PRIOR_ASSISTANT_MARKER" }] },
          { role: "user", content: [{ type: "text", text: "CURRENT_USER_A" }] },
          { role: "user", content: [{ type: "text", text: "CURRENT_USER_B" }] },
        ],
        headers: ctx.headers,
      });

      const log = await readFile(ctx.invocationsLog, "utf-8");
      expect(log).toContain("CURRENT_USER_A");
      expect(log).toContain("CURRENT_USER_B");
      expect(log).not.toContain("STALE_USER_MARKER");
      expect(log).not.toContain("PRIOR_ASSISTANT_MARKER");
    } finally {
      await rm(ctx.tmp, { recursive: true, force: true });
    }
  });

  test("compacted system plus current user excludes system text", async () => {
    const ctx = await setupBoundProvider();
    try {
      await ctx.model.doGenerate({
        prompt: [
          { role: "system", content: "COMPACTED_SUMMARY_MARKER" },
          { role: "user", content: [{ type: "text", text: "CURRENT_AFTER_COMPACT" }] },
        ],
        headers: ctx.headers,
      });

      const log = await readFile(ctx.invocationsLog, "utf-8");
      expect(log).toContain("CURRENT_AFTER_COMPACT");
      expect(log).not.toContain("COMPACTED_SUMMARY_MARKER");
    } finally {
      await rm(ctx.tmp, { recursive: true, force: true });
    }
  });

  test("does not leak file warning from past messages outside newMessages", async () => {
    const ctx = await setupBoundProvider();
    try {
      const result = await ctx.model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "STALE_USER_MARKER" },
              { type: "file", data: new Uint8Array(), mediaType: "image/png" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "PRIOR_ASSISTANT_MARKER" }] },
          { role: "user", content: [{ type: "text", text: "CURRENT_USER_A" }] },
        ],
        headers: ctx.headers,
      });

      expect(result.warnings).toEqual([]);
      const log = await readFile(ctx.invocationsLog, "utf-8");
      expect(log).toContain("CURRENT_USER_A");
      expect(log).not.toContain("STALE_USER_MARKER");
    } finally {
      await rm(ctx.tmp, { recursive: true, force: true });
    }
  });

  test("fails on no-text or non-user tail without invoking agy", async () => {
    const ctx = await setupBoundProvider();
    try {
      await expect(
        ctx.model.doGenerate({
          prompt: [
            { role: "user", content: [{ type: "text", text: "STALE_USER_MARKER" }] },
            { role: "assistant", content: [{ type: "text", text: "PRIOR_ASSISTANT_MARKER" }] },
          ],
          headers: ctx.headers,
        }),
      ).rejects.toThrow("agy bound turn has no current-turn text");

      await expect(
        ctx.model.doGenerate({
          prompt: [
            { role: "user", content: [{ type: "text", text: "STALE_USER_MARKER" }] },
            { role: "assistant", content: [{ type: "text", text: "PRIOR_ASSISTANT_MARKER" }] },
            { role: "user", content: [{ type: "text", text: "   " }] },
          ],
          headers: ctx.headers,
        }),
      ).rejects.toThrow("agy bound turn has no current-turn text");

      const invoked = await readFile(ctx.invocationsLog, "utf-8").catch(() => "");
      expect(invoked).toBe("");
    } finally {
      await rm(ctx.tmp, { recursive: true, force: true });
    }
  });
});

async function setupBoundProvider() {
  const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
  const mockBinary = join(tmp, "mock-agy");
  const invocationsLog = join(tmp, "invocations.log");
  const stateFile = join(tmp, "sessions.json");

  await writeFile(
    mockBinary,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${invocationsLog}"
printf '\\n---INV---\\n' >> "${invocationsLog}"
printf '%s\\n' '{"event":"init","conversation_id":"conv-bound-1"}'
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"ok"}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"ok","conversation_id":"conv-bound-1"}'
exit 0
`,
  );
  await chmod(mockBinary, 0o755);
  await writeFile(
    stateFile,
    JSON.stringify({
      sessions: {
        "sess-stable-cursor": {
          conversationId: "conv-bound-1",
          prevOutput: "PRIOR_ASSISTANT_MARKER",
        },
      },
    }),
  );

  const provider = createAgyProvider({
    binary: mockBinary,
    conversationsDir: tmp,
    stateFile,
  });

  return {
    tmp,
    invocationsLog,
    model: provider("gemini-3.6-flash"),
    headers: { "x-agy-session-id": "sess-stable-cursor" },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, attempts = 150, intervalMs = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await fileExists(path)) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function splitInvocations(log: string): string[] {
  return log.split("---INV---").map((part) => part.trim()).filter(Boolean);
}

const userPrompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];

const FILE_WARNING = {
  type: "other" as const,
  message: "File parts are not supported by the agy provider and were ignored.",
};

const fileUserPrompt = [
  {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "Look at this:" },
      { type: "file" as const, data: new Uint8Array(), mediaType: "image/png" },
    ],
  },
];

describe("AgyProvider session binding race", () => {
  test("overlapping first binds share one conversation after lock re-read", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");
    const invocationsLog = join(tmp, "invocations.log");
    const stateFile = join(tmp, "sessions.json");
    const startMarker = join(tmp, "first-started");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${invocationsLog}"
printf '\\n---INV---\\n' >> "${invocationsLog}"
has_conv=0
prev=""
for arg in "$@"; do
  if [ "$prev" = "--conversation" ]; then
    has_conv=1
    break
  fi
  prev="$arg"
done
if [ "$has_conv" -eq 0 ]; then
  : > "${startMarker}"
  sleep 0.4
fi
printf '%s\\n' '{"event":"init","conversation_id":"conv-race"}'
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"ok"}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"ok","conversation_id":"conv-race"}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile,
      });
      const model = provider("gemini-3.6-flash");
      const sessionId = "sess-race";
      const callOpts = {
        prompt: userPrompt,
        headers: { "x-agy-session-id": sessionId },
      };

      const first = model.doGenerate(callOpts);
      await waitForFile(startMarker);
      const second = model.doGenerate(callOpts);
      await Promise.all([first, second]);

      const invocations = splitInvocations(await readFile(invocationsLog, "utf-8"));
      expect(invocations.length).toBe(2);
      expect(invocations.filter((inv) => !inv.includes("--conversation")).length).toBe(1);
      expect(
        invocations.filter((inv) => inv.includes("--conversation") && inv.includes("conv-race")).length,
      ).toBe(1);

      const persisted = JSON.parse(await readFile(stateFile, "utf-8"));
      expect(Object.keys(persisted.sessions)).toEqual([sessionId]);
      expect(persisted.sessions[sessionId].conversationId).toBe("conv-race");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 15000);
});

describe("AgyProvider helper session scope", () => {
  test("scopes title agent away from the original session binding", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");
    const invocationsLog = join(tmp, "invocations.log");
    const stateFile = join(tmp, "sessions.json");
    const counterFile = join(tmp, "counter");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${invocationsLog}"
printf '\\n---INV---\\n' >> "${invocationsLog}"
conv=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--conversation" ]; then
    conv="$arg"
    break
  fi
  prev="$arg"
done
if [ -z "$conv" ]; then
  n=0
  if [ -f "${counterFile}" ]; then
    n=$(cat "${counterFile}")
  fi
  n=$((n + 1))
  printf '%s\\n' "$n" > "${counterFile}"
  conv="conv-scope-$n"
fi
printf '{"event":"init","conversation_id":"%s"}\\n' "\${conv}"
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"ok"}'
printf '{"event":"result","status":"SUCCESS","response":"ok","conversation_id":"%s"}\\n' "\${conv}"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile,
      });
      const model = provider("gemini-3.6-flash");
      const sessionId = "sess-scope";

      const plain = await model.doGenerate({
        prompt: userPrompt,
        headers: { "x-agy-session-id": sessionId },
      });
      const titled = await model.doGenerate({
        prompt: userPrompt,
        headers: {
          "x-agy-session-id": sessionId,
          "x-agy-session-scope": "title",
        },
      });

      const persisted = JSON.parse(await readFile(stateFile, "utf-8"));
      expect(persisted.sessions[sessionId].conversationId).toBe("conv-scope-1");
      expect(persisted.sessions[`${sessionId}:title`].conversationId).toBe("conv-scope-2");
      expect((plain.providerMetadata as { agy: { sessionId: string } }).agy.sessionId).toBe(sessionId);
      expect((titled.providerMetadata as { agy: { sessionId: string } }).agy.sessionId).toBe(sessionId);

      await model.doGenerate({
        prompt: userPrompt,
        headers: { "x-agy-session-id": sessionId },
      });
      await model.doGenerate({
        prompt: userPrompt,
        headers: {
          "x-agy-session-id": sessionId,
          "x-agy-session-scope": "title",
        },
      });

      const invocations = splitInvocations(await readFile(invocationsLog, "utf-8"));
      expect(invocations.length).toBe(4);
      expect(invocations[2]).toContain("--conversation");
      expect(invocations[2]).toContain("conv-scope-1");
      expect(invocations[3]).toContain("--conversation");
      expect(invocations[3]).toContain("conv-scope-2");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("AgyProvider file part warnings", () => {
  test("doGenerate exposes file warning", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile: join(tmp, "sessions.json"),
      });
      const model = provider("gemini-3.6-flash");
      const result = await model.doGenerate({ prompt: fileUserPrompt });

      expect(result.warnings).toEqual([FILE_WARNING]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("doStream stream-start exposes file warning", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile: join(tmp, "sessions.json"),
      });
      const model = provider("gemini-3.6-flash");
      const { stream } = await model.doStream({ prompt: fileUserPrompt });
      const reader = stream.getReader();

      try {
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value).toEqual({
          type: "stream-start",
          warnings: [FILE_WARNING],
        });
      } finally {
        await reader.cancel();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("AgyProvider doStream cancellation", () => {
  test("reader.cancel stops the child before the delayed complete marker", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
    const mockBinary = join(tmp, "mock-agy");
    const startMarker = join(tmp, "stream-started");
    const completeMarker = join(tmp, "stream-complete");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
: > "${startMarker}"
sleep 0.5
printf '%s\\n' '{"event":"init","conversation_id":"conv-cancel"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"late"}'
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"late"}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"late","conversation_id":"conv-cancel"}'
: > "${completeMarker}"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const provider = createAgyProvider({
        binary: mockBinary,
        conversationsDir: tmp,
        stateFile: join(tmp, "sessions.json"),
      });
      const model = provider("gemini-3.6-flash");
      const { stream } = await model.doStream({ prompt: userPrompt });
      const reader = stream.getReader();

      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe("stream-start");

      await waitForFile(startMarker);
      await reader.cancel();
      await sleep(1200);

      expect(await fileExists(completeMarker)).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 15000);
});
