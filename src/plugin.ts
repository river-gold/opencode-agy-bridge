import type { Plugin } from "@opencode-ai/plugin";
import { applyAgyModels } from "./agy-models.js";

const plugin: Plugin = async ({ directory }) => ({
  config: async (cfg) => {
    if (typeof directory === "string" && directory.trim() !== "") {
      const options = ((cfg.provider ??= {}).agy ??= {}).options ??= {};
      if (options.cwd == null) options.cwd = directory;
    }
    await applyAgyModels(cfg);
  },
  "chat.headers": async (incoming, output) => {
    if (incoming?.model?.providerID !== "agy") return;
    if (!output?.headers) return;
    output.headers["x-agy-session-id"] = incoming.sessionID;
    if (["title", "summary", "compaction"].includes(incoming?.agent)) {
      output.headers["x-agy-session-scope"] = incoming.agent;
    }

    const modelObj = (incoming?.model as any);
    const providerObj = (incoming?.provider as any);
    const effort =
      (incoming as any)?.variant ??
      (incoming as any)?.message?.model?.variant ??
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
