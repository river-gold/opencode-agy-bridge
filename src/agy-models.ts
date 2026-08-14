import { spawn } from "node:child_process";

export interface DiscoveredAgyModel {
  name: string;
}

export function parseAgyModels(output: string): Record<string, DiscoveredAgyModel> {
  const models: Record<string, DiscoveredAgyModel> = {};
  const lines = output.split("\n");

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("Fetching")) continue;

    const tab = line.indexOf("\t");
    const id = (tab >= 0 ? line.slice(0, tab) : line.split(/\s{2,}/)[0] ?? "").trim();
    const label = (tab >= 0 ? line.slice(tab + 1) : line.split(/\s{2,}/)[1] ?? id).trim();
    if (!id) continue;

    models[id] = { name: label || id };
  }

  return models;
}

export function listAgyModels(binary = "agy"): Promise<Record<string, DiscoveredAgyModel>> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["models"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const finish = (models: Record<string, DiscoveredAgyModel>) => {
      clearTimeout(timer);
      resolve(models);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({});
    }, 15_000);

    child.on("close", (code) => {
      if (code !== 0) {
        finish({});
        return;
      }
      finish(parseAgyModels(Buffer.concat(chunks).toString("utf-8")));
    });

    child.on("error", () => finish({}));
  });
}

export async function applyAgyModels(cfg: {
  provider?: Record<string, any>;
}): Promise<void> {
  const binary = cfg.provider?.agy?.options?.binary ?? "agy";
  const discovered = await listAgyModels(binary);
  if (Object.keys(discovered).length === 0) return;

  cfg.provider ??= {};
  cfg.provider.agy ??= {};
  cfg.provider.agy.npm ??= "opencode-agy-plugin";
  cfg.provider.agy.name ??= "Google Antigravity (via agy CLI)";
  cfg.provider.agy.models = {
    ...discovered,
    ...cfg.provider.agy.models,
  };
}
