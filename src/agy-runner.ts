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
  | { type: "conversation"; id: string }
  | { type: "result"; status: string; response: string; error?: string };

export async function runAgyStream(
  input: RunAgyInput,
  onEvent: (event: AgyStreamEvent) => void,
): Promise<RunAgyResult> {
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

    const processLine = (line: string) => {
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
        onEvent({ type: "conversation", id: conversationId });
        return;
      }

      if (parsed.event === "step_update") {
        const step = (parsed.step_update ?? parsed) as Record<string, unknown>;
        if (typeof step.conversation_id === "string") {
          conversationId = step.conversation_id;
          onEvent({ type: "conversation", id: conversationId });
        }
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          const incoming = step.text_delta;
          if (!accumulatedText) {
            onEvent({ type: "text", text: incoming });
            accumulatedText = incoming;
          } else if (incoming.startsWith(accumulatedText)) {
            const extra = incoming.slice(accumulatedText.length);
            if (extra) {
              onEvent({ type: "text", text: extra });
            }
            accumulatedText = incoming;
          } else if (!accumulatedText.endsWith(incoming)) {
            accumulatedText += incoming;
            onEvent({ type: "text", text: incoming });
          }
        }
        return;
      }

      if (parsed.event === "result") {
        const result = (parsed.result ?? parsed) as Record<string, unknown>;
        if (typeof parsed.conversation_id === "string") {
          conversationId = parsed.conversation_id;
          onEvent({ type: "conversation", id: conversationId });
        } else if (typeof result.conversation_id === "string") {
          conversationId = result.conversation_id;
          onEvent({ type: "conversation", id: conversationId });
        }
        resultStatus = typeof result.status === "string" ? result.status : undefined;
        resultResponse = typeof result.response === "string" ? result.response : undefined;
        resultError = typeof result.error === "string" ? result.error : undefined;
        if (resultStatus && resultResponse !== undefined) {
          onEvent({
            type: "result",
            status: resultStatus,
            response: resultResponse,
            ...(resultError ? { error: resultError } : {}),
          });
        }
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
      stdoutChunks.push(chunk);
      stdoutBuffer += chunk.toString("utf-8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      lines.forEach(processLine);
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("agy timed out"));
    }, timeoutMs);

    const abort = () => child.kill("SIGTERM");
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    if (input.abortSignal?.aborted) {
      child.kill("SIGTERM");
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      input.abortSignal?.removeEventListener("abort", abort);
      processLine(stdoutBuffer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const exitCode = code ?? 1;

      if (resultStatus && resultStatus !== "SUCCESS" && resultError) {
        reject(new Error(resultError));
        return;
      }

      if (exitCode !== 0 && !stdout.trim()) {
        const msg = stderr.trim() || `agy exited with status ${exitCode}`;
        reject(new Error(msg));
        return;
      }

      resolve({
        stdout: accumulatedText || resultResponse || (!sawValidEvent ? stdout : ""),
        stderr,
        exitCode,
        ...(conversationId ? { conversationId } : {}),
        ...(usage ? { usage } : {}),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      input.abortSignal?.removeEventListener("abort", abort);
      reject(new Error(`failed to spawn agy: ${err.message}`));
    });
  });
}

export async function runAgy(input: RunAgyInput): Promise<RunAgyResult> {
  return runAgyStream(input, () => {});
}
