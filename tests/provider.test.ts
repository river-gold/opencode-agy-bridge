import { describe, test, expect } from "bun:test";
import { createAgyProvider } from "../src/provider.js";
import { writeFile, chmod, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp });
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
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp });
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
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp });
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

  test("remapped variant model uses full id and skips header effort", async () => {
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
      const provider = createAgyProvider({ binary: mockBinary, conversationsDir: tmp });
      const model = provider("gemini-3.7-flash");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        headers: { "x-agy-effort": "high" },
        providerOptions: {
          agy: { model: "gemini-3.7-flash-high" },
        },
      });

      const text = result.content[0].type === "text" ? result.content[0].text : "";
      expect(text).toContain("--model gemini-3.7-flash-high");
      expect(text).not.toContain("--effort");
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

      expect(deltas.join("")).toBe("Hello");
      expect(finished).toBe(true);
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
