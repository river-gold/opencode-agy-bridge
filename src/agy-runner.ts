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
    let streamError: Error | undefined;

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
        const stepConvId =
          (typeof step.conversation_id === "string" ? step.conversation_id : undefined) ??
          (typeof parsed.conversation_id === "string" ? parsed.conversation_id : undefined);
        if (stepConvId) {
          conversationId = stepConvId;
          onEvent({ type: "conversation", id: conversationId });
        }

        const stepType =
          (typeof step.step_type === "string" ? step.step_type : undefined) ??
          (typeof parsed.step_type === "string" ? parsed.step_type : undefined);
        const textDelta =
          (typeof step.text_delta === "string" ? step.text_delta : undefined) ??
          (typeof parsed.text_delta === "string" ? parsed.text_delta : undefined);
        const status =
          (typeof step.status === "string" ? step.status : undefined) ??
          (typeof parsed.status === "string" ? parsed.status : undefined);

        if (stepType === "agent_response" && typeof textDelta === "string") {
          if (status === "DONE") {
            if (textDelta.startsWith(accumulatedText)) {
              const missingSuffix = textDelta.slice(accumulatedText.length);
              if (missingSuffix) {
                accumulatedText = textDelta;
                onEvent({ type: "text", text: missingSuffix });
              }
            } else if (!streamError) {
              streamError = new Error(
                "Inconsistent stream: DONE snapshot does not match accumulated text",
              );
            }
          } else if (textDelta) {
            accumulatedText += textDelta;
            onEvent({ type: "text", text: textDelta });
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

      if (streamError) {
        reject(streamError);
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
