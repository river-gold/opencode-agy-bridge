# opencode-agy-plugin

[[한국어]](docs/README_ko.md) [[日本語]](docs/README_ja.md) [[中文]](docs/README_zh.md)

An OpenCode plugin and provider that connects the `agy` CLI to OpenCode. Select and use models exposed by `agy` directly from OpenCode.

## Quick Start

### Prerequisites

- `agy` CLI installed
- `agy` authenticated
- OpenCode installed

Run `agy` once in a terminal to complete authentication.

### Install From npm

Add this to `~/.config/opencode/opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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

Restart OpenCode, then run `/model` and select an `agy/...` model. The model list is loaded automatically from `agy models` at startup.

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
      "name": "Google Antigravity (via agy CLI)"
    }
  }
}
```

## Models and Variants

### Automatic Model Discovery

If `models` is omitted, the plugin runs `agy models` and populates the model list.

- When two or more IDs share the same prefix before the final `-`, the final tokens become variants.
- Example: `gemini-3.7-flash-high` and `gemini-3.7-flash-low` become `gemini-3.7-flash` with `high` and `low` variants.
- A model ID with no matching sibling remains unchanged.
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
            "high": { "model": "gemini-3.7-flash-high" },
            "low": { "model": "gemini-3.7-flash-low" }
          }
        }
      }
    }
  }
}
```

A variant with `model` passes that original ID to `agy --model` without adding `--effort`.

A variant without `model` passes the variant name as `agy --effort`:

```jsonc
"variants": {
  "high": {},
  "low": {}
}
```

## Troubleshooting

If a model does not appear:

1. Confirm that `agy models` returns the model.
2. If using manual `models`, confirm that each ID is accepted by `agy`.
3. Delete the discovery cache and restart OpenCode.

```bash
rm ~/.cache/opencode-agy-plugin/models.json
```

If authentication has expired or `agy models` fails, the automatic list cannot be refreshed.
