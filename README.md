# opencode-agy-plugin

Maintained fork of [raultov/opencode-agy-bridge](https://github.com/raultov/opencode-agy-bridge). The original repository is no longer receiving updates.

OpenCode plugin + provider that routes LLM prompts to `agy` (Google Antigravity CLI).

## How it works

```
opencode TUI
  └─ /model → select agy/<model-id>
      └─ you type a prompt
          └─ provider spawns:
             agy --add-dir <cwd> --dangerously-skip-permissions
                 [--model <id>] [--effort <low|medium|high>]
                 [--conversation <id>] -p <prompt>
               └─ agy → Google Antigravity backend
                   └─ stdout NDJSON (stream-json text_delta)
               └─ provider emits text-delta as fragments arrive
           └─ text-delta + finish → opencode renders the response
```

The prompt is passed as a CLI argument, not stdin. `--dangerously-skip-permissions` is always set so headless `agy` does not block on tool-permission prompts.

## Prerequisites

1. **`agy` installed and authenticated** — run `agy` standalone at least once to complete OAuth.
2. **Node.js ≥ 18** or **Bun ≥ 1.0**.
3. **OpenCode** `>= 1.15.x` (uses Vercel AI SDK v3).

## Installation

Add the plugin and provider to `~/.config/opencode/opencode.json`. OpenCode installs the npm package on startup.

```jsonc
{
  "plugin": ["opencode-agy-plugin"],
  "provider": {
    "agy": {
      "npm": "opencode-agy-plugin",
      "name": "Google Antigravity (via agy CLI)",
      "options": {
        "binary": "agy",
        "timeoutMs": 300000
      }
    }
  }
}
```

Restart OpenCode and run `/model` → select an `agy/...` model. The model list comes from `agy models` automatically.

The original npm package `opencode-agy-bridge@0.2.8` is unmaintained and does not include the fixes in this fork.

> `"npm"` is a **package** (npm name or directory), not a `.js` file. Pointing it at a `.js` file causes `ProviderInitError` because OpenCode appends `/provider`.

### Build from this repository

```bash
git clone https://github.com/river-gold/opencode-agy-plugin.git
cd opencode-agy-plugin
bun install && bun run build && bun test
```

Then set `"plugin"` to the local `dist/plugin.js` path and `"npm"` to the checkout directory.

## Configuration

Models are filled automatically from `agy models` on startup when `provider.agy.models` is omitted or empty. You do not need a `models` block for `/model` to list `agy/...` entries.

If two or more ids share a prefix before the last `-`, they become one model with those last tokens as variants. A lone id is left as-is. If `models` contains at least one manual entry, automatic discovery and cache access are skipped entirely.

```jsonc
{
  "provider": {
    "agy": {
      "npm": "opencode-agy-plugin",
      "models": {
        "gemini-3.7-flash": {
          "name": "Gemini 3.7 Flash",
          "variants": {
            "high": { "model": "gemini-3.7-flash-high" },
            "low": { "model": "gemini-3.7-flash-low" }
          }
        }
      }
    }
  }
}
```

The example above is fully manual, so only the configured model is shown. Empty variant objects (`"high": {}`) send `--effort high` with the OpenCode model id. A `model` field on the variant sends that full id as `--model` and skips `--effort`.

Model discovery is cached in `~/.cache/opencode-agy-plugin/models.json` for 24 hours. A later start uses the cache immediately. If the cache is stale, the old list is still used and `agy models` refreshes the file in the background for the next restart. The first start with no cache waits on `agy models`.

Model IDs are forwarded to `agy --model`. A cosmetic id such as `antigravity` is sent to `agy` as-is and will fail if that id is not a real model.

### Options

| Option | Default | Meaning |
|---|---|---|
| `binary` | `"agy"` | CLI path or command name |
| `timeoutMs` | `300000` | Kill the process with `SIGTERM` after this many ms |
| `extraArgs` | `[]` | Extra argv inserted after `--dangerously-skip-permissions` |
| `model` | — | Fallback model id. Also accepts `model:effort` (e.g. `gemini-3.6-flash:high`) |
| `effort` | — | Reasoning effort (`low` \| `medium` \| `high`). Omitted unless set. |
| `conversationsDir` | `~/.gemini/antigravity-cli/conversations` | Directory of `agy` `.pb` conversation files |
| `stateFile` | `~/.opencode-agy-plugin/sessions.json` | Session → conversation binding store |

### Model and effort

Resolution order:

- **model:** `providerOptions.agy.model` → model factory option → OpenCode `/model` id → `options.model`. Auto-grouped variants set `providerOptions.agy.model` to the original full id.
- **effort:** `providerOptions.agy.effort` → `x-agy-effort` header → model factory option → `options.effort`. Not sent if a remapped full model id is used, or if unset.

The plugin copies OpenCode session id and effort into headers (`x-agy-session-id`, `x-agy-effort`). Effort is taken from, in order: chat **variant**, then `model.options.reasoningEffort` / `effort`, then the same fields on the provider.

If the selected model id contains `:`, it is split into `--model` and `--effort` (`gemini-3.6-flash:high` → `--model gemini-3.6-flash --effort high`).

## Features

- **Unified plugin + provider** — one package, auto-detected as both plugin and provider.
- **Headless `agy` spawn** — prompt via `-p <text>`, `--dangerously-skip-permissions` always on.
- **Model / effort forwarding** — OpenCode model id and variant are passed to `agy --model` / `--effort`.
- **Robust delta extraction** — normalizes `\r\n` / `\n`, tolerates trailing whitespace, suffix alignment after context-window truncation.
- **Session persistence** — conversation state survives OpenCode restarts via `~/.opencode-agy-plugin/sessions.json`.
- **Conversation binding** — infers `conversation_id` by diffing `agy` `.pb` files so multi-turn chat works.
- **Global binding lock** — serializes first-turn `.pb` discovery across concurrent OpenCode instances.
- **stream-json** — `agy --output-format stream-json` fragments are forwarded as OpenCode `text-delta`.
- **Auto models** — when `models` is omitted or empty, `agy models` ids are grouped by the last `-` token when that prefix appears more than once. The list is cached for 24h in `~/.cache/opencode-agy-plugin/models.json`. Any manual model entry disables discovery and cache access.

## Known limitations

| Limitation | Detail |
|---|---|
| **Streaming depends on `agy --output-format stream-json`** | Incremental `text-delta` comes from `agent_response.text_delta` events. Short replies may still arrive as a single `DONE` event. |
| **`--dangerously-skip-permissions` always on** | There is no option to disable it. Tool permission prompts would otherwise block headless runs. |
| **Requires authenticated `agy`** | You must run `agy` standalone at least once to authenticate via OAuth. |
| **No tool-call passthrough** | `agy` CLI does not return structured tool calls to the caller. Tool use happens inside agy's own process. |
| **Per-turn subprocess** | Each prompt spawns a fresh `agy` process. Context is preserved via `--conversation <id>` after binding succeeds. |
| **Images/file parts omitted** | Non-text content parts are dropped. `agy` CLI does not support them. |
| **Prompt via argv** | Very long prompts can hit the OS argument-length limit. |
| **Conversation binding heuristic** | The plugin infers `conversation_id` by diffing `~/.gemini/antigravity-cli/conversations/*.pb` before/after each turn. If multiple `.pb` files appear simultaneously, binding is refused and each turn runs in single-turn mode. |

## Installation issues in corporate environments

If you get `ProviderInitError` after configuring the plugin from an npm package, it may be caused by an **OpenCode bug** where the provider package download fails silently (no error logged) instead of surfacing the underlying problem. This is commonly triggered by:

- **Corporate npm registry proxies** (Nexus, Artifactory, Verdaccio, JFrog — any `registry` configured in `~/.npmrc`) that enforce allowlists, security scans, or maturity policies on newly published packages.
- **Newly published versions** that haven't been cached or approved by the corporate proxy yet.

**Diagnostic:** check `~/.cache/opencode/packages/opencode-agy-plugin@<version>/`. If the directory is empty or missing files despite a successful OpenCode startup, the proxy silently blocked the download.

**Workaround:** use the local checkout configuration above, or temporarily comment out the `registry` line in `~/.npmrc`, restart OpenCode so it downloads the package from the public npm registry, then restore the corporate registry setting. The cached package in `~/.cache/opencode/packages/` will continue to work.

## Roadmap

### Current

- **Unified plugin + provider entry point** — single package that OpenCode auto-detects as both plugin and provider.
- **Headless-safe spawn** — `-p <prompt>` and `--dangerously-skip-permissions` (fixes ignored-prompt / welcome-message and blocked tool-permission prompts).
- **Model and effort flags** — forwarded to `agy --model` / `--effort`.
- **Robust delta extraction** — end-of-line normalization (`\r\n` ↔ `\n`), whitespace-tolerant alignment, suffix fallback for context window truncation recovery.
- **Session persistence across restarts** — conversation state survives OpenCode restarts via `~/.opencode-agy-plugin/sessions.json`.
- **Conversation binding via `.pb` file diffing** — automatically discovers the `conversation_id` created by `agy` so multi-turn conversations work.
- **Global binding lock** — prevents race conditions when multiple OpenCode instances run concurrently.
- **stream-json** — `agy --output-format stream-json` `text_delta` events are forwarded as OpenCode `text-delta`.

## Project structure

```
src/
├── index.ts                # unified plugin + provider entry
├── plugin.ts               # OpenCode plugin hooks
├── provider.ts             # LanguageModelV2 implementation
├── agy-runner.ts           # spawn agy, capture stdout/stderr
├── agy-models.ts           # parse/cache `agy models` into provider.models
├── conversation-tracker.ts # snapshot .pb files, infer conversation_id
├── session-store.ts        # persist session→conversation_id mapping
└── prompt-mapper.ts        # Vercel AI SDK prompt → plain text
```

## Development

```bash
bun run build   # compile TypeScript
bun test        # run test suite
```
