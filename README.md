# opencode-agy-plugin

[[한국어]](docs/README_ko.md) [[日本語]](docs/README_ja.md) [[中文]](docs/README_zh.md)

An OpenCode plugin and provider that connects the `agy` CLI to OpenCode. Select and use models exposed by `agy` directly from OpenCode.

This project is developed entirely through vibe coding.

This project is forked from `raultov/opencode-agy-bridge:main`.

## Quick Start

### Prerequisites

- Latest `agy` CLI installed (compatibility verified with `1.1.13`)
- `agy` authenticated
- OpenCode installed

Run `agy` once in a terminal to complete authentication.

### Install From npm

Install the package from npm:

```bash
npm install opencode-agy-plugin
```

Then add `opencode-agy-plugin` to the `plugin` list in `~/.config/opencode/opencode.json` or `opencode.jsonc` as shown below:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agy-plugin"],
  "provider": {
    "agy": {
      "npm": "opencode-agy-plugin",
      "name": "Antigravity",
      "options": {
        "binary": "agy",
        "timeoutMs": 300000
      }
    }
  }
}
```

Restart OpenCode, then run `/model` and select an `agy/...` model. The model list is loaded automatically from `agy models` at startup.

### Update the Plugin

OpenCode caches npm plugins. To refresh the global installation to the latest version:

```bash
opencode plugin opencode-agy-plugin --global --force
```

For a project-local plugin configuration, omit `--global`. Quit and restart OpenCode after updating.

### Use a Local Checkout

For local development or testing:

```bash
git clone https://github.com/river-gold/opencode-agy-plugin.git
cd opencode-agy-plugin
bun install
bun run build
bun test
```

Point `plugin` to the built file and `npm` to the checkout directory:

```jsonc
{
  "plugin": ["/home/USER/workspace/opencode-agy-plugin/dist/plugin.js"],
  "provider": {
    "agy": {
      "npm": "/home/USER/workspace/opencode-agy-plugin",
      "name": "Antigravity"
    }
  }
}
```

## Permissions and Security

Every `agy` invocation uses `--dangerously-skip-permissions`. Changes made by `agy` and commands it executes are not mediated by OpenCode permission prompts. OpenCode system instructions, tool history, and file parts are not forwarded to `agy`. Use this plugin only in trusted workspaces and with trusted requests. This is intentional current plugin behavior.

## Models and Variants

### Automatic Model Discovery

If `models` is omitted, the plugin runs `agy models` and populates the model list.

- When two or more IDs share the same prefix before the final `-`, the final tokens become variants.
- Example: `gemini-3.7-flash-high` and `gemini-3.7-flash-low` become `gemini-3.7-flash` with `high` and `low` variants.
- Automatically grouped base models use the first returned variant as effort when no variant is selected.
- The discovered list is cached for 24 hours in `~/.cache/opencode-agy-plugin/models.json`.
- If at least one manual `models` entry exists, automatic discovery and cache access are skipped.

The available models can vary by account, region, and `agy` version.

### Manual Model Configuration

Set `models` to pin the model list or define variant names explicitly:

```jsonc
{
  "provider": {
    "agy": {
      "npm": "opencode-agy-plugin",
      "models": {
        "gemini-3.7-flash": {
          "name": "Gemini 3.7 Flash",
          "variants": {
            "high": {},
            "low": {}
          }
        }
      }
    }
  }
}
```

A variant appends its name to the base model ID and passes the result to `agy --model` without adding `--effort`.

An automatically grouped base model uses the first returned variant as `--effort` when no variant is selected.

## Troubleshooting

If a model does not appear:

1. Confirm that `agy models` returns the model.
2. If using manual `models`, confirm that each ID is accepted by `agy`.
3. Delete the discovery cache and restart OpenCode.

```bash
rm ~/.cache/opencode-agy-plugin/models.json
```

If authentication has expired or `agy models` fails, the automatic list cannot be refreshed.
