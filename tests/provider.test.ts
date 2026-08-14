import { describe, test, expect } from "bun:test";
import { createAgyProvider } from "../src/provider.js";
import { writeFile, chmod, mkdtemp, rm } from "node:fs/promises";
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

