<p align="right">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">中文</a> | <strong>日本語</strong>
</p>


<h1 align="center">Vibrato</h1>

<p align="center">
  <sub>ローカル LLM エンドポイント、Claude、OpenAI Codex で動くターミナル用コーディングエージェント。</sub>
</p>

<p align="center">
  <a href="https://github.com/Keonho-Chu/Vibrato"><img alt="Repository" src="https://img.shields.io/badge/github-Keonho--Chu%2FVibrato-002F6D?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/vibrato-cli"><img alt="npm package" src="https://img.shields.io/npm/v/vibrato-cli?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
</p>

> この文書は英語版 [README.md](README.md) の翻訳です。内容が異なる場合は英語版が正となります。

## インストール

**スタンドアロンバイナリ** (推奨、Bun 不要)、Linux (x64/arm64)、macOS (arm64/x64)、Windows (x64) 対応:

```sh
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.17.2/scripts/install.sh -o vib-install.sh
sh vib-install.sh
vib --version
```

Windows (PowerShell、「管理者として実行」ではなく通常のターミナルで):

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.17.2/scripts/install.ps1 -OutFile vib-install.ps1
powershell -File vib-install.ps1
```

Vibrato はセッションを `%USERPROFILE%\.vib` 以下に保存しますが、管理者権限のターミナルで作られたディレクトリは自分ではなく Administrators グループの所有になります。Vibrato は起動時に所有権を取り戻しますが、最初から通常のターミナルで実行すればその手間はかかりません。詳細と Git Bash の要件は [Windows notes](docs/install.md#windows-notes) を参照してください。

**Bun でインストール** (PATH に Bun 1.4 以上が既にあること。`bun install -g` は Bun を代わりにインストールしません):

```sh
bun install -g vibrato-cli
vib --version
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

任意の git チェックアウト内で `vib` を実行します。使用可能なモデルがない初回起動では、単一の接続画面がそのまま開きます。Esc を押すとプロバイダーメニュー全体に切り替わります。同じ画面は `/provider` でいつでも開けます。

- **ローカル LLM エンドポイント** (vLLM、SGLang、Ollama、LM Studio、llama.cpp など、OpenAI 互換サーバーであれば何でも): LLM サーバーは多くの場合、ネットワーク上の別マシン、たとえば LAN 上の GPU マシンです。そのアドレスを入力して接続するだけです。`192.168.0.10:8000` や `gpu-server.lan:8000` のような省略形で十分で、スキームと `/v1` パスは Vibrato が補います。プライベートネットワークのアドレスと `.local` / `.internal` / `.lan` アドレスは平文の `http://`、それ以外は `https://` と推定します。これはあくまで既定値で、スキームを自分で書けばそのまま使われるため、社内ネットワークが他のアドレス帯で GPU サーバーを平文 http で提供している場合は `http://172.170.0.52:8000` のように書けば動きます。API キーの入力は別ステップではありません。Vibrato がまずエンドポイントを probe し、サーバーが 401 か 403 を返したときだけキー入力欄を表示します。ちょっとした便利機能として、自分のマシン上でよく使われるループバックポート(Ollama、llama.cpp、LM Studio、oMLX、vLLM、SGLang)で既にサーバーが動いていれば、同じ画面に選択可能な行としても表示されます。接続後はサーバーが報告したモデルから選べ、見つかったモデルが1つだけなら自動的に選択されます。
- **Claude** または **OpenAI Codex** (サブスクリプション。ローカルエンドポイントの代替): `/login` で `anthropic`、`openai-codex` (ブラウザ)、`openai-codex-device` (ヘッドレス) のいずれかを選びます。

シェルから同じ設定を行うには:

```sh
vib setup provider --preset local --base-url http://192.168.0.10:8000/v1   # 例: LAN 上の GPU マシン; キーは LOCAL_LLM_API_KEY から (あれば)
```

`vllm` と `sglang` のプリセットは、すでにそれらを使用しているスクリプトや CI のために引き続き利用できます:

```sh
vib setup provider --preset vllm --base-url http://192.168.0.10:8000/v1    # キーは VLLM_API_KEY から (あれば)
vib setup provider --preset sglang --base-url http://192.168.0.10:30000/v1 # キーは SGLANG_API_KEY から (あれば)
```

明示的に書いた `http://` や `https://` はどのホストでもそのまま使われます。スキームなしの `host:port` だけを書いたときのみ推定し、localhost、プライベートネットワークのホスト、素のホスト名、`.local` / `.internal` / `.lan` 名は平文の `http://`、それ以外は `https://` です。

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
| `/provider` | 接続画面を開く (ローカル LLM エンドポイント。代替として OpenAI Codex/Claude) |
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
