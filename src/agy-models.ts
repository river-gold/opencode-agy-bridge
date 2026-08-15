import { spawn } from "node:child_process";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CACHE_VERSION = 5;

export interface ModelCacheFile {
  version?: number;
  binary: string;
  fetchedAt: number;
  models: Record<string, DiscoveredAgyModel>;
}

export interface DiscoveredAgyModel {
  name: string;
  options?: { effort?: string };
  variants?: Record<string, {}>;
}

function splitLastHyphen(id: string): { base: string; suffix: string } | null {
  const i = id.lastIndexOf("-");
  if (i <= 0 || i === id.length - 1) return null;
  return { base: id.slice(0, i), suffix: id.slice(i + 1) };
}

function stripSuffixLabel(label: string, suffix: string): string {
  const end = `(${suffix})`;
  if (label.toLowerCase().endsWith(end.toLowerCase())) {
    return label.slice(0, label.length - end.length).trim();
  }
  return label;
}

export function parseAgyModels(output: string): Record<string, DiscoveredAgyModel> {
  const rows: { id: string; label: string }[] = [];
  const lines = output.split("\n");

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("Fetching")) continue;

    const tab = line.indexOf("\t");
    const id = (tab >= 0 ? line.slice(0, tab) : line.split(/\s{2,}/)[0] ?? "").trim();
    const label = (tab >= 0 ? line.slice(tab + 1) : line.split(/\s{2,}/)[1] ?? id).trim();
    if (!id) continue;
    rows.push({ id, label: label || id });
  }

  const baseCount = new Map<string, number>();
  for (const row of rows) {
    const split = splitLastHyphen(row.id);
    if (!split) continue;
    baseCount.set(split.base, (baseCount.get(split.base) ?? 0) + 1);
  }

  const models: Record<string, DiscoveredAgyModel> = {};

  for (const row of rows) {
    const split = splitLastHyphen(row.id);
    if (split && (baseCount.get(split.base) ?? 0) >= 2) {
      const existing = models[split.base] ?? {
        name: stripSuffixLabel(row.label, split.suffix),
        variants: {},
      };
      existing.options ??= { effort: split.suffix };
      existing.variants ??= {};
      existing.variants[split.suffix] = {};
      models[split.base] = existing;
      continue;
    }

    const existing = models[row.id];
    if (existing?.variants) {
      existing.name = row.label;
    } else {
      models[row.id] = { name: row.label };
    }
  }

  return models;
}

function defaultModelCacheFile(): string {
  return join(homedir(), ".cache", "opencode-agy-plugin", "models.json");
}

export function isModelCacheFresh(
  cache: ModelCacheFile | null,
  now: number,
  ttlMs = MODEL_CACHE_TTL_MS,
): boolean {
  return Boolean(cache && now - cache.fetchedAt <= ttlMs);
}

async function loadModelCache(path: string): Promise<ModelCacheFile | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as ModelCacheFile;
    if (
      !parsed ||
      parsed.version !== MODEL_CACHE_VERSION ||
      typeof parsed.fetchedAt !== "number" ||
      !parsed.models
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveModelCache(path: string, cache: ModelCacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, JSON.stringify({ ...cache, version: MODEL_CACHE_VERSION }), "utf-8");
  await rename(tmpPath, path);
}

function assignModels(
  cfg: { provider?: Record<string, any> },
  discovered: Record<string, DiscoveredAgyModel>,
): void {
  if (Object.keys(discovered).length === 0) return;
  cfg.provider ??= {};
  cfg.provider.agy ??= {};
  cfg.provider.agy.npm ??= "opencode-agy-plugin";
  cfg.provider.agy.name ??= "Antigravity";
  cfg.provider.agy.models = {
    ...discovered,
    ...cfg.provider.agy.models,
  };
}

function listAgyModels(binary = "agy"): Promise<Record<string, DiscoveredAgyModel>> {
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

export async function applyAgyModels(
  cfg: { provider?: Record<string, any> },
  opts?: {
    cacheFile?: string;
    list?: (binary: string) => Promise<Record<string, DiscoveredAgyModel>>;
    now?: number;
    ttlMs?: number;
    waitRefresh?: boolean;
  },
): Promise<void> {
  const configuredModels = cfg.provider?.agy?.models;
  if (configuredModels && Object.keys(configuredModels).length > 0) return;

  const binary = cfg.provider?.agy?.options?.binary ?? "agy";
  const cacheFile = opts?.cacheFile ?? defaultModelCacheFile();
  const list = opts?.list ?? listAgyModels;
  const now = opts?.now ?? Date.now();
  const ttlMs = opts?.ttlMs ?? MODEL_CACHE_TTL_MS;
  const cache = await loadModelCache(cacheFile);
  const usable = cache && cache.binary === binary ? cache : null;

  if (usable && Object.keys(usable.models).length > 0) {
    assignModels(cfg, usable.models);
    if (isModelCacheFresh(usable, now, ttlMs)) return;

    const refresh = list(binary).then(async (models) => {
      if (Object.keys(models).length === 0) return;
      await saveModelCache(cacheFile, { binary, fetchedAt: Date.now(), models });
    }).catch(() => undefined);

    if (opts?.waitRefresh) await refresh;
    return;
  }

  const discovered = await list(binary);
  if (Object.keys(discovered).length === 0) return;
  await saveModelCache(cacheFile, { binary, fetchedAt: now, models: discovered });
  assignModels(cfg, discovered);
}
