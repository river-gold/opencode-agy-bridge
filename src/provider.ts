import type {
  ProviderV2,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
  EmbeddingModelV2,
  ImageModelV2,
} from "@ai-sdk/provider";
import { runAgy } from "./agy-runner.js";
import { snapshot, findNewConversation, defaultConversationsDir } from "./conversation-tracker.js";
import { SessionStore } from "./session-store.js";
import { flattenPrompt } from "./prompt-mapper.js";
import { randomUUID } from "node:crypto";

export interface AgyProviderOptions {
  binary?: string;
  conversationsDir?: string;
  stateFile?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  model?: string;
  effort?: string;
}

function parseModelAndEffort(rawModel?: string, existingEffort?: string): { model?: string; effort?: string } {
  let model: string | undefined = rawModel;
  let effort: string | undefined = existingEffort;

  if (rawModel?.includes(":")) {
    const [m, e] = rawModel.split(":");
    model = m;
    effort = effort ?? e;
  }

  if (model && !effort) {
    effort = "high";
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

  if (normFull.startsWith(normPrev)) {
    return normFull.slice(normPrev.length).replace(/^\n+/, "");
  }

  const normPrevTrimmed = normPrev.trimEnd();
  if (normFull.startsWith(normPrevTrimmed)) {
    return normFull.slice(normPrevTrimmed.length).replace(/^\s+/, "");
  }

  const idx = normFull.indexOf(normPrevTrimmed);
  if (idx !== -1) {
    return normFull.slice(idx + normPrevTrimmed.length).replace(/^\s+/, "");
  }

  const lines = normPrevTrimmed.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    if (lastLine.length >= 10) {
      const lastLineIdx = normFull.indexOf(lastLine);
      if (lastLineIdx !== -1) {
        return normFull.slice(lastLineIdx + lastLine.length).replace(/^\s+/, "");
      }
    }
  }

  const tailLength = 150;
  const tail = normPrevTrimmed.length > tailLength
    ? normPrevTrimmed.slice(-tailLength)
    : normPrevTrimmed;

  if (tail.length >= 20) {
    const tailIdx = normFull.lastIndexOf(tail);
    if (tailIdx !== -1) {
      return normFull.slice(tailIdx + tail.length).replace(/^\s+/, "");
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

  const doGenerate = async (callOpts: LanguageModelV2CallOptions) => {
    const sessionId =
      (callOpts.headers?.["x-agy-session-id"] as string) ??
      (callOpts.providerOptions?.agy as Record<string, unknown> | undefined)
        ?.sessionId as string ??
      randomUUID();

    const entry = await store.getEntry(sessionId);
    let conversationId = entry?.conversationId ?? null;
    const processedMessages = entry?.processedMessages ?? 0;

    // On first turn (no conversation yet), acquire a global lock before
    // spawning agy so we can safely diff *.pb files without races from
    // another concurrent OpenCode instance.
    let releaseBindingLock: (() => Promise<void>) | null = null;
    if (!conversationId) {
      releaseBindingLock = await SessionStore.acquireBindingLock();
    }

    let before: Set<string> | null = null;
    try {
      before = conversationId ? null : await snapshot(conversationsDir);

      const newMessages = conversationId
        ? callOpts.prompt.slice(processedMessages)
        : callOpts.prompt;

      const prompt = flattenPrompt(newMessages);

      const providerAgyOpts = callOpts.providerOptions?.agy as Record<string, unknown> | undefined;

      const headerEffort = callOpts.headers?.["x-agy-effort"] as string | undefined;

      const rawModel = (providerAgyOpts?.model as string) ??
        modelOpts?.model ??
        modelId ??
        opts.model;
      const rawEffort =
        (providerAgyOpts?.effort as string) ??
        headerEffort ??
        modelOpts?.effort ??
        opts.effort;

      const { model, effort } = parseModelAndEffort(rawModel, rawEffort);

      const result = await runAgy({
        prompt,
        cwd: process.cwd(),
        conversationId: conversationId ?? undefined,
        model,
        effort,
        binary: opts.binary,
        extraArgs: opts.extraArgs,
        timeoutMs: opts.timeoutMs,
      });

      if (!conversationId && before) {
        const newId = await findNewConversation(before, conversationsDir);
        if (newId) {
          conversationId = newId;
        }
      }

      // Restore prevOutput from persisted store (survives restarts).
      // In-memory cache takes priority (faster, has latest turn data).
      let prevOutput = prevOutputs.get(sessionId) ?? "";
      if (!prevOutput && entry?.prevOutput) {
        prevOutput = entry.prevOutput;
        prevOutputs.set(sessionId, prevOutput);
      }

      const delta = extractDelta(prevOutput, result.stdout, !!conversationId);

      if (conversationId) {
        prevOutputs.set(sessionId, result.stdout);
      } else {
        prevOutputs.delete(sessionId);
      }

      // Persist state so it survives process restarts.
      await store.set(
        sessionId,
        conversationId,
        conversationId ? callOpts.prompt.length : 0,
        conversationId ? result.stdout : "",
      );

      return {
        content: [{ type: "text" as const, text: delta }],
        finishReason: "stop" as const,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        providerMetadata: {
          agy: {
            sessionId,
            conversationId: conversationId ?? null,
          },
        },
        response: {
          id: randomUUID(),
          timestamp: new Date(),
          modelId,
        },
        warnings: [] as LanguageModelV2CallWarning[],
      };
    } finally {
      if (releaseBindingLock) {
        await releaseBindingLock();
      }
    }
  };

  const doStream = async (callOpts: LanguageModelV2CallOptions) => {
    const generatePromise = doGenerate(callOpts);

    let aborted = false;

    callOpts.abortSignal?.addEventListener("abort", () => {
      aborted = true;
    });

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        try {
          controller.enqueue({
            type: "stream-start",
            warnings: [],
          });

          const result = await generatePromise;

          if (aborted) {
            controller.close();
            return;
          }

          const textContent = result.content.find(
            (c) => c.type === "text",
          );
          const text = textContent && "text" in textContent ? textContent.text : "";

          if (text) {
            controller.enqueue({
              type: "text-start",
              id: "agy-1",
            });
            controller.enqueue({
              type: "text-delta",
              id: "agy-1",
              delta: text,
            });
            controller.enqueue({
              type: "text-end",
              id: "agy-1",
            });
          }

          controller.enqueue({
            type: "finish",
            finishReason: result.finishReason,
            usage: result.usage,
          });

          controller.close();
        } catch (err) {
          controller.enqueue({ type: "error", error: String(err) });
          controller.close();
        }
      },
      cancel() {
        // agy is one-shot; no real cancellation possible here
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
      throw new Error("agy bridge does not support text embeddings");
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
      throw new Error("agy bridge does not support image generation");
    },
  };
}

export function createAgyProvider(
  opts?: AgyProviderOptions,
): ProviderV2 & { (modelId: string): LanguageModelV2; provider: string } {
  const resolvedOpts = opts ?? {};

  const factory = (
    modelId: string,
    modelOpts?: { effort?: string; model?: string },
  ): LanguageModelV2 => {
    return buildLanguageModel(modelId, resolvedOpts, modelOpts);
  };

  factory.provider = "agy";
  factory.specificationVersion = "v2" as const;
  factory.languageModel = factory;
  factory.textEmbeddingModel = (modelId: string) => unsupportedEmbeddingModel(modelId);
  factory.imageModel = (modelId: string) => unsupportedImageModel(modelId);

  return factory as ProviderV2 & { (modelId: string): LanguageModelV2; provider: string };
}

export default function defaultFactory(
  opts?: AgyProviderOptions,
): ProviderV2 {
  return createAgyProvider(opts) as ProviderV2;
}
