<p align="right">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">中文</a> | <strong>日本語</strong>
</p>


<h1 align="center">Vibrato</h1>

<p align="center">
  <sub>Claude、OpenAI Codex、セルフホストの vLLM / SGLang エンドポイントで動くターミナル用コーディングエージェント。</sub>
</p>

<p align="center">
  <a href="https://github.com/Keonho-Chu/Vibrato"><img alt="Repository" src="https://img.shields.io/badge/github-Keonho--Chu%2FVibrato-002F6D?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/vibrato-cli"><img alt="npm package" src="https://img.shields.io/npm/v/vibrato-cli?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
</p>

> この文書は英語版 [README.md](README.md) の翻訳です。内容が異なる場合は英語版が正となります。

## インストール

**Bun でインストール** (PATH に Bun 1.4 以上が必要):

```sh
bun install -g vibrato-cli
vib --version
```

**スタンドアロンバイナリ** (Bun 不要)、Linux (x64/arm64)、macOS (arm64/x64)、Windows (x64) 対応:

```sh
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.16.0/scripts/install.sh -o vib-install.sh
sh vib-install.sh
vib --version
```

Windows (PowerShell):

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.16.0/scripts/install.ps1 -OutFile vib-install.ps1
powershell -File vib-install.ps1
```

その他のインストール方法:

```sh
# 常に最新のインストーラー (main ブランチの可変スクリプトを実行)
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/main/scripts/install.sh | sh

# 既存インストールをその場で更新
vib update
```

対応プラットフォーム一覧、nightly チャンネル、シェル補完、ソースビルド: [docs/install.md](docs/install.md)。

## 初回起動

任意の git チェックアウト内で `vib` を実行します。プロバイダー未設定の初回起動ではプロバイダーメニューが自動で開きます。同じメニューは `/provider` でいつでも開けます。

- **vLLM / SGLang** (セルフホスト、OpenAI 互換): *Connect a vLLM endpoint* または *Connect an SGLang endpoint* を選び、サーバー URL と任意の API キーを入力すると、サーバーからモデル一覧を取得します。認証なしのローカルサーバーならキーは空のままで構いません。
- **Claude** または **OpenAI Codex** (サブスクリプション): `/login` で `anthropic`、`openai-codex` (ブラウザ)、`openai-codex-device` (ヘッドレス) のいずれかを選びます。

シェルから同じ設定を行うには:

```sh
vib setup provider --preset vllm --base-url http://HOST:8000/v1      # キーは VLLM_API_KEY から (あれば)
vib setup provider --preset sglang --base-url http://HOST:30000/v1   # キーは SGLANG_API_KEY から (あれば)
```

localhost、プライベートネットワークのホスト、`.local` / `.internal` / `.lan` 名では平文の `http://` を許可します。公開ホストには `https://` が必要です。

## 使い方

```sh
vib                                        # 現在のチェックアウトで対話セッション
vib "src/ の .ts ファイルを一覧して"          # 最初のプロンプト付きで対話セッション
vib @prompt.md @screenshot.png "説明して"    # @ でファイルや画像を添付
vib -p "このリポジトリを要約して"             # 非対話: 回答を出力して終了
vib --continue                             # 前回のセッションを続ける
vib --resume                               # 過去のセッションを選ぶ
vib --worktree my-task                     # 分離した git ワークツリーで作業
vib --tmux                                 # tmux ベースのセッションで実行
vib --model opus "このモジュールをリファクタして" # モデルをあいまい名で指定
vib --list-models                          # 使用可能なモデルを表示
```

セッション内:

| コマンド | 内容 |
| :--- | :--- |
| `/provider` | vLLM または SGLang エンドポイントを接続 |
| `/login` | Claude または OpenAI Codex にサインイン |
| `/model` | 使用モデルを切り替え |
| `/theme` | TUI テーマを切り替え |
| `/skill:deep-interview` | 計画の前にあいまいな要求を明確化 |
| `/skill:ralplan` | ファイルを変更する前に計画を作成・批評 |
| `/help` | すべてのスラッシュコマンドを表示 |

よく使う CLI コマンド:

```sh
vib --help                  # すべてのフラグ
vib setup --help            # プロバイダーと認証情報の設定
vib customize doctor        # ツール・スキル・フック・MCP サーバーが読み込まれない理由を診断
vib config set <key> <val>  # シェルから設定を変更
vib update                  # 最新リリースに更新
```

ダークターミナルの既定 TUI テーマは LIG System CI を適用した `lig-blue`、ライトターミナルは同梱の `lig-white` です。明示的なテーマ設定が常に優先されます。

## ドキュメント

- [インストール、更新チャンネル、プラットフォーム別の注意](docs/install.md)
- [モデル、プロバイダー、認証](docs/models.md)
- [カスタムプロバイダーと複数アカウントのルーティング](docs/custom-providers-and-multi-account.md)
- [スキル](docs/skills.md)
- [デザインシステム](docs/design-system.md)
- [外部コントローラー / ボット連携](docs/bot-integration.md): Telegram、Discord、Slack、または自作ボットから Vibrato を操作
- [外部制御の準備状況](docs/external-control-readiness.md)
- [Aside 検索/コンテキストサイドカー](docs/aside-integration.md)
- [コードベース概要](docs/codebase-overview.md) と [docs/](docs/) のその他の文書

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。過去の帰属表示は [NOTICE.md](NOTICE.md) にあります。
