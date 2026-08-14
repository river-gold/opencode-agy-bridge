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
  let effort: string | undefined = existingEffort;

  if (rawModel?.includes(":")) {
    const [m, e] = rawModel.split(":");
    model = m;
    effort = effort ?? e;
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

  const runTurn = async (
    callOpts: LanguageModelV2CallOptions,
    onText?: (text: string) => void,
  ) => {
    const sessionId =
      (callOpts.headers?.["x-agy-session-id"] as string) ??
      (callOpts.providerOptions?.agy as Record<string, unknown> | undefined)
        ?.sessionId as string ??
      randomUUID();

    const entry = await store.getEntry(sessionId);
    let conversationId = entry?.conversationId ?? null;

    let releaseBindingLock: (() => Promise<void>) | null = null;
    if (!conversationId) {
      releaseBindingLock = await SessionStore.acquireBindingLock();
    }

    let before: Set<string> | null = null;
    try {
      before = conversationId ? null : await snapshot(conversationsDir);

      const newMessages = conversationId
        ? boundTurnPrompt(callOpts.prompt)
        : callOpts.prompt;

      const prompt = flattenPrompt(newMessages);
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
        modelId ??
        opts.model;
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
          timeoutMs: opts.timeoutMs,
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

      let prevOutput = prevOutputs.get(sessionId) ?? "";
      if (!prevOutput && entry?.prevOutput) {
        prevOutput = entry.prevOutput;
        prevOutputs.set(sessionId, prevOutput);
      }

      const delta = extractDelta(prevOutput, result.stdout, !!conversationId);

      if (!streamed && delta) {
        onText?.(delta);
      }

      if (conversationId) {
        prevOutputs.set(sessionId, result.stdout);
      } else {
        prevOutputs.delete(sessionId);
      }

      await store.set(
        sessionId,
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

  const doGenerate = async (callOpts: LanguageModelV2CallOptions) => {
    return runTurn(callOpts);
  };

  const doStream = async (callOpts: LanguageModelV2CallOptions) => {
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        let textStarted = false;
        try {
          controller.enqueue({
            type: "stream-start",
            warnings: [],
          });

          const result = await runTurn(callOpts, (text) => {
            if (!textStarted) {
              controller.enqueue({
                type: "text-start",
                id: "agy-1",
              });
              textStarted = true;
            }
            controller.enqueue({
              type: "text-delta",
              id: "agy-1",
              delta: text,
            });
          });

          if (textStarted) {
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
