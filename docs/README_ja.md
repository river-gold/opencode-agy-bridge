# opencode-agy-plugin

`agy` CLIをOpenCodeのproviderとして接続するプラグイン。OpenCodeから`agy`が提供するモデルを選択して利用できる。

このプロジェクトは完全に vibe coding で開発されています。

## クイックスタート

### 前提条件

- `agy` CLIがインストール済みであること
- `agy`の認証が完了していること
- OpenCodeがインストール済みであること

ターミナルで一度`agy`を実行し、認証を完了する。

### npmからインストール

`~/.config/opencode/opencode.json`または`opencode.jsonc`に追加する。

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

OpenCodeを再起動し、`/model`から`agy/...`モデルを選択する。モデル一覧は起動時に`agy models`から自動取得される。

### ローカルチェックアウトを使う

ローカル開発やテストでは次のコマンドを実行する。

```bash
git clone https://github.com/river-gold/opencode-agy-plugin.git
cd opencode-agy-plugin
bun install
bun run build
bun test
```

`plugin`にはビルドしたファイルを、`npm`にはチェックアウトしたディレクトリを指定する。

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

## 権限とセキュリティ

すべての`agy`呼び出しで`--dangerously-skip-permissions`を使用する。`agy`によるファイル変更とコマンド実行は、OpenCodeの権限確認プロンプトによって仲介されない。OpenCodeのシステム指示、ツール履歴、ファイル部分は`agy`に転送されない。信頼できるワークスペースで、信頼できるリクエストに対してのみこのプラグインを使用する。これは現在のプラグインの意図した動作である。

## モデルとvariant

### モデルの自動検出

`models`を省略すると、プラグインが`agy models`を実行してモデル一覧を作成する。

- 最後の`-`より前のprefixが2つ以上のIDで共通する場合、最後の文字列をvariantとしてまとめる
- 例: `gemini-3.7-flash-high`と`gemini-3.7-flash-low`は、`gemini-3.7-flash`の`high`と`low`になる
- 対応する兄弟IDが1つしかないモデルは元のIDのまま表示される
- 自動検出した一覧は`~/.cache/opencode-agy-plugin/models.json`に24時間保存される
- 手動の`models`項目が1つでもある場合、自動検出とキャッシュの利用は行わない

利用できるモデルは、アカウント、地域、`agy`のバージョンによって異なる場合がある。

### モデルを手動設定する

モデル一覧を固定したり、variant名を明示的に設定したりする場合は`models`を指定する。

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

variantに`model`を指定すると、その元のIDを`agy --model`に渡す。`--effort`は追加しない。

`model`を指定しないvariantは、variant名を`agy --effort`として渡す。

```jsonc
"variants": {
  "high": {},
  "low": {}
}
```

## トラブルシューティング

モデルが表示されない場合は、次を確認する。

1. `agy models`がモデルを返すことを確認する。
2. 手動で`models`を設定している場合、各IDが`agy`で利用可能か確認する。
3. 自動検出キャッシュを削除してOpenCodeを再起動する。

```bash
rm ~/.cache/opencode-agy-plugin/models.json
```

認証の有効期限が切れている場合や`agy models`が失敗した場合、自動一覧は更新されない。
