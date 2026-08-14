# opencode-agy-plugin

将 `agy` CLI 接入 OpenCode 的插件和 provider。你可以直接在 OpenCode 中选择并使用 `agy` 提供的模型。

## 快速开始

### 前置条件

- 已安装 `agy` CLI
- 已完成 `agy` 身份验证
- 已安装 OpenCode

先在终端中运行一次 `agy`，完成身份验证。

### 从 npm 安装

将以下内容添加到 `~/.config/opencode/opencode.json` 或 `opencode.jsonc`：

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

重启 OpenCode，然后运行 `/model`，选择 `agy/...` 模型。模型列表会在启动时从 `agy models` 自动加载。

### 使用本地代码

如果要进行本地开发或测试：

```bash
git clone https://github.com/river-gold/opencode-agy-plugin.git
cd opencode-agy-plugin
bun install
bun run build
bun test
```

将 `plugin` 指向构建后的文件，将 `npm` 指向本地代码目录：

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

## 模型和 variant

### 自动发现模型

省略 `models` 时，插件会运行 `agy models` 并生成模型列表。

- 如果两个或更多 ID 在最后一个 `-` 之前拥有相同前缀，最后的字符串会被作为 variant 合并
- 例如：`gemini-3.7-flash-high` 和 `gemini-3.7-flash-low` 会合并为 `gemini-3.7-flash` 的 `high` 和 `low`
- 没有同前缀模型的 ID 会保持不变
- 自动发现的列表会缓存 24 小时，路径为 `~/.cache/opencode-agy-plugin/models.json`
- 只要存在一个手动 `models` 条目，就会跳过自动发现和缓存读取

可用模型可能因账号、地区和 `agy` 版本而不同。

### 手动配置模型

如果要固定模型列表或自定义 variant 名称，请设置 `models`：

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

如果 variant 中指定了 `model`，插件会将该原始 ID 传递给 `agy --model`，不会额外添加 `--effort`。

如果 variant 没有指定 `model`，插件会将 variant 名称作为 `agy --effort` 传递：

```jsonc
"variants": {
  "high": {},
  "low": {}
}
```

## 故障排查

如果模型没有显示，请检查：

1. `agy models` 是否返回模型。
2. 使用手动 `models` 时，每个 ID 是否都是 `agy` 支持的模型 ID。
3. 删除自动发现缓存，然后重启 OpenCode。

```bash
rm ~/.cache/opencode-agy-plugin/models.json
```

如果认证已过期，或 `agy models` 执行失败，自动模型列表将无法更新。
