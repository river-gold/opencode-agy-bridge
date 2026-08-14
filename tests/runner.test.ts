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

  test("emits repeated incremental chunks correctly without dropping identical text", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' '{"event":"init","conversation_id":"conv-repeat"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"ha"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"ha"}'
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"haha"}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"haha","conversation_id":"conv-repeat"}'
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

      expect(texts).toEqual(["ha", "ha"]);
      expect(texts.join("")).toBe("haha");
      expect(result.stdout).toBe("haha");
      expect(result.conversationId).toBe("conv-repeat");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("appends missing suffix from DONE snapshot", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' '{"event":"init","conversation_id":"conv-suffix"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"Hel"}'
printf '%s\\n' '{"event":"step_update","status":"ACTIVE","step_type":"agent_response","text_delta":"lo "}'
printf '%s\\n' '{"event":"step_update","status":"DONE","step_type":"agent_response","text_delta":"Hello World"}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"Hello World","conversation_id":"conv-suffix"}'
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

      expect(texts).toEqual(["Hel", "lo ", "World"]);
      expect(texts.join("")).toBe("Hello World");
      expect(result.stdout).toBe("Hello World");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("handles nested step_update shape", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-plugin-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
printf '%s\\n' '{"event":"step_update","step_update":{"status":"ACTIVE","step_type":"agent_response","text_delta":"ha","conversation_id":"conv-nested"}}'
printf '%s\\n' '{"event":"step_update","step_update":{"status":"ACTIVE","step_type":"agent_response","text_delta":"ha"}}'
printf '%s\\n' '{"event":"step_update","step_update":{"status":"DONE","step_type":"agent_response","text_delta":"haha"}}'
printf '%s\\n' '{"event":"result","status":"SUCCESS","response":"haha"}'
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

      expect(texts).toEqual(["ha", "ha"]);
      expect(texts.join("")).toBe("haha");
      expect(result.stdout).toBe("haha");
      expect(result.conversationId).toBe("conv-nested");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
