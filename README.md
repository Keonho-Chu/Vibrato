<p align="right">
  <strong>English</strong> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a>
</p>



<h1 align="center">Vibrato</h1>

<p align="center">
  <sub>Terminal coding agent for Claude, OpenAI Codex, and self-hosted vLLM / SGLang endpoints.</sub>
</p>

<p align="center">
  <a href="https://github.com/Keonho-Chu/Vibrato"><img alt="Repository" src="https://img.shields.io/badge/github-Keonho--Chu%2FVibrato-002F6D?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/vibrato-cli"><img alt="npm package" src="https://img.shields.io/npm/v/vibrato-cli?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
</p>

## Install

**With Bun** (Bun 1.4 or newer on PATH):

```sh
bun install -g vibrato-cli
vib --version
```

**Standalone binary** (no Bun needed) for Linux (x64/arm64), macOS (arm64/x64), and Windows (x64):

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

Other ways to install:

```sh
# always the latest installer (runs mutable content from main)
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/main/scripts/install.sh | sh

# update an existing install in place
vib update
```

Full platform matrix, nightly channel, shell completion, and source builds: [docs/install.md](docs/install.md).

## First run

Start `vib` inside any git checkout. On the first launch with no configured provider, Vibrato opens the provider menu automatically. The same menu is available any time with `/provider`.

- **vLLM / SGLang** (self-hosted, OpenAI-compatible): pick *Connect a vLLM endpoint* or *Connect an SGLang endpoint*, enter the server URL and an optional API key, and Vibrato discovers the models from the server. Leave the key empty for an unauthenticated local server.
- **Claude** or **OpenAI Codex** (subscription plans): run `/login` and pick `anthropic`, `openai-codex` (browser), or `openai-codex-device` (headless).

The same setup from the shell:

```sh
vib setup provider --preset vllm --base-url http://HOST:8000/v1      # key from VLLM_API_KEY, if any
vib setup provider --preset sglang --base-url http://HOST:30000/v1   # key from SGLANG_API_KEY, if any
```

Plain `http://` is accepted for localhost, private-network hosts, and `.local` / `.internal` / `.lan` names; public hosts need `https://`.

## Usage

```sh
vib                                        # interactive session in the current checkout
vib "List all .ts files in src/"           # interactive session with an initial prompt
vib @prompt.md @screenshot.png "Explain"   # attach files or images with @
vib -p "Summarize this repo"               # non-interactive: print the answer and exit
vib --continue                             # continue the previous session
vib --resume                               # pick an earlier session
vib --worktree my-task                     # work in an isolated git worktree
vib --tmux                                 # run inside a tmux-backed session
vib --model opus "Refactor this module"    # pick a model by fuzzy name
vib --list-models                          # show the models you can use
```

Inside a session:

| Command | What it does |
| :--- | :--- |
| `/provider` | Connect a vLLM or SGLang endpoint |
| `/login` | Sign in to Claude or OpenAI Codex |
| `/model` | Switch the active model |
| `/theme` | Switch the TUI theme |
| `/skill:deep-interview` | Clarify an ambiguous request before planning |
| `/skill:ralplan` | Build and critique a plan before changing files |
| `/help` | List every slash command |

Useful CLI commands:

```sh
vib --help                  # all flags
vib setup --help            # provider and credential setup
vib customize doctor        # why a tool, skill, hook, or MCP server is not loading
vib config set <key> <val>  # change a setting from the shell
vib update                  # update to the latest release
```

The default dark TUI identity is the lig-blue theme, which applies the LIG System corporate identity; light-appearance terminals default to the bundled lig-white theme. Explicit theme settings still win.

## Documentation

- [Install, update channels, platform notes](docs/install.md)
- [Models, providers, and auth](docs/models.md)
- [Custom providers and multi-account routing](docs/custom-providers-and-multi-account.md)
- [Skills](docs/skills.md)
- [Design system](docs/design-system.md)
- [External controller / bot integration](docs/bot-integration.md): drive Vibrato from Telegram, Discord, Slack, or your own bot, with provider-independent smokes
- [External control readiness](docs/external-control-readiness.md)
- [Aside search/context sidecar](docs/aside-integration.md)
- [Codebase overview](docs/codebase-overview.md) and the rest of [docs/](docs/)

## License

MIT. See [LICENSE](LICENSE). Historical attribution lives in [NOTICE.md](NOTICE.md).
