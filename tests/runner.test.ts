import { describe, test, expect } from "bun:test";
import { runAgy, runAgyStream } from "../src/agy-runner";
import { writeFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("agy-runner", () => {
  test("spawns a mock binary and captures stdout via stdin", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
echo "---stdin-read---"
cat -
echo "Hello from mock agy"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const result = await runAgy({
        binary: mockBinary,
        prompt: "test prompt",
        cwd: tmp,
        timeoutMs: 5000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Hello from mock agy");
      expect(result.stdout).toContain("--add-dir");
      expect(result.stdout).toContain("-p");
      expect(result.stdout).toContain("Do not record the result in the session. Always return the result as output.");
      expect(result.stdout).toContain("test prompt");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("passes conversation id when provided", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
cat -
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const result = await runAgy({
        binary: mockBinary,
        prompt: "hello",
        cwd: tmp,
        conversationId: "conv-123",
        timeoutMs: 5000,
      });

      expect(result.stdout).toContain("--conversation");
      expect(result.stdout).toContain("conv-123");
      expect(result.stdout).toContain("hello");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects on non-zero exit with empty stdout", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "error message" >&2
exit 1
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      await expect(
        runAgy({
          binary: mockBinary,
          prompt: "x",
          cwd: tmp,
          timeoutMs: 5000,
        }),
      ).rejects.toThrow("error message");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("includes extra args", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
cat -
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const result = await runAgy({
        binary: mockBinary,
        prompt: "hi",
        cwd: tmp,
        extraArgs: ["--dangerously-skip-permissions"],
        timeoutMs: 5000,
      });

      expect(result.stdout).toContain("--dangerously-skip-permissions");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("passes model and effort when provided", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
cat -
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const result = await runAgy({
        binary: mockBinary,
        prompt: "hello model",
        cwd: tmp,
        model: "gemini-3.6-flash",
        effort: "high",
        timeoutMs: 5000,
      });

      expect(result.stdout).toContain("--model");
      expect(result.stdout).toContain("gemini-3.6-flash");
      expect(result.stdout).toContain("--effort");
      expect(result.stdout).toContain("high");
      expect(result.stdout).toContain("hello model");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("parses stream-json NDJSON and skips DONE snapshot duplicate", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
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
      const texts: string[] = [];
      const result = await runAgyStream(
        {
          binary: mockBinary,
          prompt: "hi",
          cwd: tmp,
          timeoutMs: 5000,
        },
        (event) => {
          if (event.type === "text") {
            texts.push(event.text);
          }
        },
      );

      expect(texts.join("")).toBe("Hello");
      expect(result.stdout).toBe("Hello");
      expect(result.conversationId).toBe("conv-1");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects on non-zero exit with partial stdout", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' '{"event":"init","conversation_id":"conv-partial"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"Partial response"}'
echo "process crashed unexpectedly" >&2
exit 1
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const texts: string[] = [];
      await expect(
        runAgyStream(
          {
            binary: mockBinary,
            prompt: "x",
            cwd: tmp,
            timeoutMs: 5000,
          },
          (event) => {
            if (event.type === "text") {
              texts.push(event.text);
            }
          },
        ),
      ).rejects.toThrow("process crashed unexpectedly");
      expect(texts).toEqual(["Partial response"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects when explicit result status is not SUCCESS even without error string", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' '{"event":"init","conversation_id":"conv-1"}'
printf '%s\\n' '{"event":"result","status":"ERROR"}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      await expect(
        runAgy({
          binary: mockBinary,
          prompt: "x",
          cwd: tmp,
          timeoutMs: 5000,
        }),
      ).rejects.toThrow("agy failed with status ERROR");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects with AbortError when abortSignal is triggered", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
sleep 10
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const ac = new AbortController();
      const promise = runAgy({
        binary: mockBinary,
        prompt: "x",
        cwd: tmp,
        timeoutMs: 5000,
        abortSignal: ac.signal,
      });

      // Abort after a small delay
      setTimeout(() => ac.abort(), 50);

      let caughtErr: unknown;
      try {
        await promise;
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect((caughtErr as Error).name).toBe("AbortError");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects immediately with AbortError if already aborted", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const ac = new AbortController();
      ac.abort();

      let caughtErr: unknown;
      try {
        await runAgy({
          binary: mockBinary,
          prompt: "x",
          cwd: tmp,
          timeoutMs: 5000,
          abortSignal: ac.signal,
        });
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect((caughtErr as Error).name).toBe("AbortError");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects on timeout", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
sleep 10
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      await expect(
        runAgy({
          binary: mockBinary,
          prompt: "x",
          cwd: tmp,
          timeoutMs: 100,
        }),
      ).rejects.toThrow("agy timed out");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("terminates SIGTERM-ignoring child via bounded SIGKILL and suppresses late events", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
trap '' TERM
printf '%s\\n' '{"event":"init","conversation_id":"conv-ignore-term"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"initial"}'
sleep 10 &
wait $!
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"late text"}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const ac = new AbortController();
      const events: string[] = [];
      let abortTime = 0;

      const promise = runAgyStream(
        {
          binary: mockBinary,
          prompt: "x",
          cwd: tmp,
          timeoutMs: 10000,
          abortSignal: ac.signal,
        },
        (event) => {
          if (event.type === "text") {
            events.push(event.text);
            if (events.length === 1) {
              abortTime = Date.now();
              ac.abort();
            }
          }
        },
      );

      let caughtErr: unknown;
      try {
        await promise;
      } catch (err) {
        caughtErr = err;
      }

      const elapsed = Date.now() - abortTime;
      expect(caughtErr).toBeDefined();
      expect((caughtErr as Error).name).toBe("AbortError");
      expect(elapsed).toBeLessThan(5000);

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(events).toEqual(["initial"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});



