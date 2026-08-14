import { spawn } from "node:child_process";

export interface RunAgyInput {
  prompt: string;
  cwd: string;
  conversationId?: string;
  model?: string;
  effort?: string;
  binary?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface RunAgyResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  conversationId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export type AgyStreamEvent =
  | { type: "text"; text: string }
  | { type: "conversation"; id: string };

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === "AbortError") {
      return reason;
    }
    const err = new Error(reason.message);
    err.name = "AbortError";
    err.stack = reason.stack;
    return err;
  }
  if (typeof DOMException !== "undefined") {
    return new DOMException(
      typeof reason === "string" ? reason : "The operation was aborted",
      "AbortError",
    );
  }
  const err = new Error(
    typeof reason === "string" ? reason : "The operation was aborted",
  );
  err.name = "AbortError";
  return err;
}

export async function runAgyStream(
  input: RunAgyInput,
  onEvent: (event: AgyStreamEvent) => void,
): Promise<RunAgyResult> {
  if (input.abortSignal?.aborted) {
    return Promise.reject(createAbortError(input.abortSignal.reason));
  }

  const binary = input.binary ?? "agy";
  const timeoutMs = input.timeoutMs ?? 300_000;
  const extraArgs = input.extraArgs ?? [];

  const args: string[] = [
    "--add-dir",
    input.cwd,
    "--dangerously-skip-permissions",
    ...extraArgs,
  ];

  if (input.model) {
    args.push("--model", input.model);
  }

  if (input.effort) {
    args.push("--effort", input.effort);
  }

  if (input.conversationId) {
    args.push("--conversation", input.conversationId);
  }

  args.push(
    "--output-format",
    "stream-json",
    "-p",
    `Do not record the result in the session. Always return the result as output.\n\n${input.prompt}`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBuffer = "";
    let accumulatedText = "";
    let resultResponse: string | undefined;
    let resultStatus: string | undefined;
    let resultError: string | undefined;
    let conversationId: string | undefined;
    let usage: RunAgyResult["usage"];
    let sawValidEvent = false;

    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killFallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const emitEvent = (event: AgyStreamEvent) => {
      if (!settled) {
        onEvent(event);
      }
    };

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (killFallbackTimer) {
        clearTimeout(killFallbackTimer);
        killFallbackTimer = undefined;
      }
      if (input.abortSignal && onAbort) {
        input.abortSignal.removeEventListener("abort", onAbort);
      }
    };

    const settleResolve = (value: RunAgyResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (input.abortSignal && onAbort) {
        input.abortSignal.removeEventListener("abort", onAbort);
      }
      reject(err);
    };

    const killChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      if (!killFallbackTimer) {
        killFallbackTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, 1000);
        killFallbackTimer.unref?.();
      }
    };

    const onAbort = () => {
      killChild();
      settleReject(createAbortError(input.abortSignal?.reason));
    };

    const processLine = (line: string) => {
      if (settled) {
        return;
      }
      line = line.trim();
      if (!line.startsWith("{")) {
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (typeof parsed.event !== "string") {
        return;
      }
      sawValidEvent = true;

      if (parsed.event === "init" && typeof parsed.conversation_id === "string") {
        conversationId = parsed.conversation_id;
        emitEvent({ type: "conversation", id: conversationId });
        return;
      }

      if (parsed.event === "step_update") {
        const step = (parsed.step_update ?? parsed) as Record<string, unknown>;
        if (typeof step.conversation_id === "string") {
          conversationId = step.conversation_id;
          emitEvent({ type: "conversation", id: conversationId });
        }
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          const incoming = step.text_delta;
          if (!accumulatedText) {
            emitEvent({ type: "text", text: incoming });
            accumulatedText = incoming;
          } else if (incoming.startsWith(accumulatedText)) {
            const extra = incoming.slice(accumulatedText.length);
            if (extra) {
              emitEvent({ type: "text", text: extra });
            }
            accumulatedText = incoming;
          } else if (!accumulatedText.endsWith(incoming)) {
            accumulatedText += incoming;
            emitEvent({ type: "text", text: incoming });
          }
        }
        return;
      }

      if (parsed.event === "result") {
        const result = (parsed.result ?? parsed) as Record<string, unknown>;
        if (typeof parsed.conversation_id === "string") {
          conversationId = parsed.conversation_id;
          emitEvent({ type: "conversation", id: conversationId });
        } else if (typeof result.conversation_id === "string") {
          conversationId = result.conversation_id;
          emitEvent({ type: "conversation", id: conversationId });
        }
        resultStatus = typeof result.status === "string" ? result.status : undefined;
        resultResponse = typeof result.response === "string" ? result.response : undefined;
        resultError = typeof result.error === "string" ? result.error : undefined;
        const resultUsage = result.usage as Record<string, unknown> | undefined;
        if (
          resultUsage &&
          typeof resultUsage.input_tokens === "number" &&
          typeof resultUsage.output_tokens === "number" &&
          typeof resultUsage.total_tokens === "number"
        ) {
          usage = {
            inputTokens: resultUsage.input_tokens,
            outputTokens: resultUsage.output_tokens,
            totalTokens: resultUsage.total_tokens,
          };
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutChunks.push(chunk);
      stdoutBuffer += chunk.toString("utf-8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      lines.forEach(processLine);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrChunks.push(chunk);
    });

    timeoutTimer = setTimeout(() => {
      killChild();
      settleReject(new Error("agy timed out"));
    }, timeoutMs);

    input.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code) => {
      cleanup();
      if (settled) return;
      processLine(stdoutBuffer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const exitCode = code ?? 1;

      if (exitCode !== 0) {
        const msg = resultError?.trim() || stderr.trim() || `agy exited with status ${exitCode}`;
        settleReject(new Error(msg));
        return;
      }

      if (resultStatus && resultStatus !== "SUCCESS") {
        const msg = resultError?.trim() || `agy failed with status ${resultStatus}`;
        settleReject(new Error(msg));
        return;
      }

      settleResolve({
        stdout: accumulatedText || resultResponse || (!sawValidEvent ? stdout : ""),
        stderr,
        exitCode,
        ...(conversationId ? { conversationId } : {}),
        ...(usage ? { usage } : {}),
      });
    });

    child.on("error", (err) => {
      cleanup();
      settleReject(new Error(`failed to spawn agy: ${err.message}`));
    });
  });
}

export async function runAgy(input: RunAgyInput): Promise<RunAgyResult> {
  return runAgyStream(input, () => {});
}
