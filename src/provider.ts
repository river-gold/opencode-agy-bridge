import type {
  ProviderV2,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
  EmbeddingModelV2,
  ImageModelV2,
} from "@ai-sdk/provider";
import { runAgyStream } from "./agy-runner.js";
import { snapshot, findNewConversation, defaultConversationsDir } from "./conversation-tracker.js";
import { SessionStore } from "./session-store.js";
import { mapPrompt } from "./prompt-mapper.js";
import { randomUUID } from "node:crypto";

export interface AgyProviderOptions {
  binary?: string;
  conversationsDir?: string;
  stateFile?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  model?: string;
  effort?: string;
  cwd?: string;
}

function boundTurnPrompt(prompt: LanguageModelV2CallOptions["prompt"]) {
  const lastAssistantIdx = prompt.reduce(
    (last, msg, i) => (msg.role === "assistant" ? i : last),
    -1,
  );
  if (lastAssistantIdx === -1) {
    return prompt.filter((msg) => msg.role !== "system");
  }
  return prompt.slice(lastAssistantIdx + 1);
}

function parseModelAndEffort(rawModel?: string, existingEffort?: string): { model?: string; effort?: string } {
  let model: string | undefined = rawModel;
  let effort: string | undefined = existingEffort?.trim() ? existingEffort : undefined;

  if (rawModel?.includes(":")) {
    const [m, e] = rawModel.split(":");
    model = m;
    effort = effort ?? (e?.trim() ? e : undefined);
  }

  return { model, effort };
}

const prevOutputs = new Map<string, string>();

export function extractDelta(
  prevOutput: string,
  fullText: string,
  conversationBound: boolean,
): string {
  if (!conversationBound || !prevOutput) {
    return fullText;
  }

  const normalize = (str: string) => str.replace(/\r\n/g, "\n");
  const normPrev = normalize(prevOutput);
  const normFull = normalize(fullText);

  const output = normFull.replace(
    /^(?:(?:[ \t]*\n+)|(?:WARNING:|Update available:|\.\.\.TRUNCATED\.\.\.)[^\n]*(?:\n|$))+/, "",
  );

  const hasBoundary = (text: string, start: number) =>
    text.endsWith("\n") || start + text.length === output.length ||
    /\s/.test(output[start + text.length]);

  if (output.startsWith(normPrev) && hasBoundary(normPrev, 0)) {
    return output.slice(normPrev.length).replace(/^\n+/, "");
  }

  const normPrevTrimmed = normPrev.trimEnd();
  if (output.startsWith(normPrevTrimmed) && hasBoundary(normPrevTrimmed, 0)) {
    return output.slice(normPrevTrimmed.length).replace(/^\s+/, "");
  }

  const lines = normPrevTrimmed.split("\n").filter((l) => l.trim());
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1].trimEnd();
    if (lastLine.length >= 10 && output.startsWith(lastLine) && hasBoundary(lastLine, 0)) {
      return output.slice(lastLine.length).replace(/^\s+/, "");
    }
  }

  const tail = normPrevTrimmed.length > 150 ? normPrevTrimmed.slice(-150) : normPrevTrimmed;
  const firstTokenMatch = output.match(/\S+/);
  if (tail.length >= 20) {
    let tailStart: number | undefined;
    if (output.startsWith(tail)) {
      tailStart = 0;
    } else if (firstTokenMatch) {
      const firstTokenStart = firstTokenMatch.index ?? 0;
      const firstToken = firstTokenMatch[0];
      if (firstToken.endsWith(tail)) {
        tailStart = firstTokenStart + firstToken.length - tail.length;
      }
    }
    if (tailStart !== undefined && hasBoundary(tail, tailStart)) {
      return output.slice(tailStart + tail.length).replace(/^\s+/, "");
    }
  }

  return fullText;
}

function buildLanguageModel(
  modelId: string,
  opts: AgyProviderOptions,
  modelOpts?: { effort?: string; model?: string },
): LanguageModelV2 {
  const store = new SessionStore(opts.stateFile);
  const conversationsDir = opts.conversationsDir ?? defaultConversationsDir();

  const runTurn = async (
    callOpts: LanguageModelV2CallOptions,
    onText?: (text: string) => void,
    onWarnings?: (warnings: LanguageModelV2CallWarning[]) => void,
  ) => {
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    const remainingTimeout = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("agy timed out");
      }
      return remaining;
    };

    const sessionId =
      (callOpts.headers?.["x-agy-session-id"] as string) ??
      (callOpts.providerOptions?.agy as Record<string, unknown> | undefined)
        ?.sessionId as string ??
      randomUUID();
    const scope = callOpts.headers?.["x-agy-session-scope"] as string | undefined;
    const sessionKey = typeof scope === "string" && scope.length > 0
      ? `${sessionId}:${scope}`
      : sessionId;

    let entry: Awaited<ReturnType<SessionStore["getEntry"]>>;
    let conversationId: string | null = null;
    let releaseBindingLock: (() => Promise<void>) | null = null;
    let before: Set<string> | null = null;
    try {
      entry = await store.getEntry(sessionKey);
      remainingTimeout();
      conversationId = entry?.conversationId ?? null;

      if (!conversationId) {
        try {
          releaseBindingLock = await SessionStore.acquireBindingLock({
            abortSignal: callOpts.abortSignal,
            timeoutMs: remainingTimeout(),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new Error("agy timed out");
          }
          throw error;
        }
      }

      if (!conversationId) {
        entry = await store.getEntry(sessionKey);
        remainingTimeout();
        conversationId = entry?.conversationId ?? null;
      }
      before = conversationId ? null : await snapshot(conversationsDir);
      remainingTimeout();

      const newMessages = conversationId
        ? boundTurnPrompt(callOpts.prompt)
        : callOpts.prompt;

      const mapped = mapPrompt(newMessages);
      const prompt = mapped.prompt;
      onWarnings?.(mapped.warnings);
      remainingTimeout();
      if (conversationId && !prompt.trim()) {
        throw new Error("agy bound turn has no current-turn text");
      }

      const providerAgyOpts = callOpts.providerOptions?.agy as Record<string, unknown> | undefined;

      const headerEffort = callOpts.headers?.["x-agy-effort"] as string | undefined;
      const remappedModel =
        typeof providerAgyOpts?.model === "string" ? providerAgyOpts.model : undefined;
      const usedRemap = Boolean(remappedModel && remappedModel !== modelId);

      const rawModel = remappedModel ??
        modelOpts?.model ??
        modelId;
      const rawEffort = usedRemap
        ? (typeof providerAgyOpts?.effort === "string" ? providerAgyOpts.effort : undefined)
        : (providerAgyOpts?.effort as string) ??
          headerEffort ??
          modelOpts?.effort ??
          opts.effort;

      const { model, effort } = parseModelAndEffort(rawModel, rawEffort);

      let streamed = false;
      const result = await runAgyStream(
        {
          prompt,
          cwd: opts.cwd?.trim() || process.cwd(),
          conversationId: conversationId ?? undefined,
          model,
          effort,
          binary: opts.binary,
          extraArgs: opts.extraArgs,
          timeoutMs: remainingTimeout(),
          abortSignal: callOpts.abortSignal,
        },
        (event) => {
          if (event.type === "conversation" && !conversationId) {
            conversationId = event.id;
          }
          if (event.type === "text" && event.text) {
            streamed = true;
            onText?.(event.text);
          }
        },
      );

      if (!conversationId && result.conversationId) {
        conversationId = result.conversationId;
      }

      if (!conversationId && before) {
        const newId = await findNewConversation(before, conversationsDir);
        if (newId) {
          conversationId = newId;
        }
      }

      let prevOutput = prevOutputs.get(sessionKey) ?? "";
      if (!prevOutput && entry?.prevOutput) {
        prevOutput = entry.prevOutput;
        prevOutputs.set(sessionKey, prevOutput);
      }

      const delta = extractDelta(prevOutput, result.stdout, !!conversationId);

      if (!streamed && delta) {
        onText?.(delta);
      }

      if (conversationId) {
        prevOutputs.set(sessionKey, result.stdout);
      } else {
        prevOutputs.delete(sessionKey);
      }

      await store.set(
        sessionKey,
        conversationId,
        conversationId ? result.stdout : "",
      );

      return {
        content: [{ type: "text" as const, text: delta }],
        finishReason: "stop" as const,
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
        },
        providerMetadata: {
          agy: {
            modelId,
            sessionId,
            conversationId: conversationId ?? null,
          },
        },
        response: {
          id: randomUUID(),
          timestamp: new Date(),
          modelId,
        },
        warnings: mapped.warnings,
      };
    } finally {
      if (releaseBindingLock) {
        await releaseBindingLock();
      }
    }
  };

  const doGenerate = async (callOpts: LanguageModelV2CallOptions) => {
    return runTurn(callOpts);
  };

  const doStream = async (callOpts: LanguageModelV2CallOptions) => {
    const local = new AbortController();
    let cancelled = false;
    const onAbort = () => local.abort(callOpts.abortSignal?.reason);
    if (callOpts.abortSignal?.aborted) {
      local.abort(callOpts.abortSignal.reason);
    } else {
      callOpts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      cancel(reason) {
        cancelled = true;
        local.abort(reason);
      },
      async start(controller) {
        let textStarted = false;
        let streamStarted = false;
        const enqueue = (part: LanguageModelV2StreamPart) => {
          if (!cancelled) controller.enqueue(part);
        };
        const close = () => {
          if (!cancelled) controller.close();
        };
        try {
          const result = await runTurn(
            { ...callOpts, abortSignal: local.signal },
            (text) => {
              if (!textStarted) {
                enqueue({
                  type: "text-start",
                  id: "agy-1",
                });
                textStarted = true;
              }
              enqueue({
                type: "text-delta",
                id: "agy-1",
                delta: text,
              });
            },
            (warnings) => {
              if (!streamStarted) {
                enqueue({
                  type: "stream-start",
                  warnings,
                });
                streamStarted = true;
              }
            },
          );

          if (textStarted) {
            enqueue({
              type: "text-end",
              id: "agy-1",
            });
          }

          enqueue({
            type: "finish",
            finishReason: result.finishReason,
            usage: result.usage,
          });

          close();
        } catch (err) {
          if (!cancelled) {
            if (!streamStarted) {
              enqueue({
                type: "stream-start",
                warnings: [],
              });
              streamStarted = true;
            }
            enqueue({ type: "error", error: String(err) });
            close();
          }
        } finally {
          callOpts.abortSignal?.removeEventListener("abort", onAbort);
        }
      },
    });

    return { stream };
  };

  return {
    specificationVersion: "v2",
    provider: "agy",
    modelId,
    supportedUrls: {},
    doGenerate,
    doStream,
  };
}

function unsupportedEmbeddingModel(modelId: string): EmbeddingModelV2<string> {
  return {
    specificationVersion: "v2",
    provider: "agy",
    modelId,
    maxEmbeddingsPerCall: 0,
    supportsParallelCalls: false,
    doEmbed: async () => {
      throw new Error("agy plugin does not support text embeddings");
    },
  };
}

function unsupportedImageModel(modelId: string): ImageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "agy",
    modelId,
    maxImagesPerCall: 0,
    doGenerate: async () => {
      throw new Error("agy plugin does not support image generation");
    },
  };
}

export function createAgyProvider(
  opts?: AgyProviderOptions,
): ProviderV2 & {
  (modelId?: string, modelOpts?: { effort?: string; model?: string }): LanguageModelV2;
  provider: string;
} {
  const resolvedOpts = opts ?? {};

  const factory = (
    modelId?: string,
    modelOpts?: { effort?: string; model?: string },
  ): LanguageModelV2 => {
    const resolvedModelId = modelId?.trim() ? modelId : resolvedOpts.model;
    if (!resolvedModelId?.trim()) {
      throw new Error("agy model id is required");
    }
    return buildLanguageModel(resolvedModelId, resolvedOpts, modelOpts);
  };

  factory.provider = "agy";
  factory.specificationVersion = "v2" as const;
  factory.languageModel = factory;
  factory.textEmbeddingModel = (modelId: string) => unsupportedEmbeddingModel(modelId);
  factory.imageModel = (modelId: string) => unsupportedImageModel(modelId);

  return factory as ProviderV2 & {
    (modelId?: string, modelOpts?: { effort?: string; model?: string }): LanguageModelV2;
    provider: string;
  };
}

export default function defaultFactory(
  opts?: AgyProviderOptions,
): ProviderV2 {
  return createAgyProvider(opts) as ProviderV2;
}
