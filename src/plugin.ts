import type { Plugin } from "@opencode-ai/plugin";

const plugin: Plugin = async () => ({
  config: async () => {},
  "chat.headers": async (incoming, output) => {
    if (incoming?.model?.providerID !== "agy") return;
    if (!output?.headers) return;
    output.headers["x-agy-session-id"] = incoming.sessionID;

    const modelObj = (incoming?.model as any);
    const providerObj = (incoming?.provider as any);
    const effort =
      (incoming as any)?.variant ??
      modelObj?.options?.reasoningEffort ??
      modelObj?.options?.effort ??
      modelObj?.reasoningEffort ??
      modelObj?.effort ??
      providerObj?.options?.effort ??
      providerObj?.options?.reasoningEffort;

    if (effort && typeof effort === "string") {
      output.headers["x-agy-effort"] = effort;
    }
  },
});

export default plugin;
