<p align="right">
  <strong>English</strong> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a>
</p>



<h1 align="center">Vibrato</h1>

<p align="center">
  <sub>Terminal coding agent for local LLM endpoints, Claude, and OpenAI Codex.</sub>
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

Start `vib` inside any git checkout. On the first launch with no usable model, Vibrato opens a single connect screen; press Esc to fall through to the full provider menu. The same screen opens any time with `/provider`.

- **Local LLM endpoint** (vLLM, SGLang, Ollama, LM Studio, llama.cpp, or any other OpenAI-compatible server): your LLM server is usually another machine on the network — a GPU box on your LAN — so just type its address and connect. Shorthand like `192.168.0.10:8000` or `gpu-server.lan:8000` is enough; Vibrato fills in the scheme and `/v1` path for you. Plain `http://` works for private-network and `.local` / `.internal` / `.lan` addresses; a public host needs `https://`. There's no separate API key step: Vibrato probes the endpoint first and only asks for a key if the server answers 401 or 403. As a minor convenience, a compatible server already running on your own machine on a well-known loopback port (Ollama, llama.cpp, LM Studio, oMLX, vLLM, SGLang) also shows up as a selectable row on the same screen. Once connected, pick a model from what the server reports; a single discovered model is selected automatically.
- **Claude** or **OpenAI Codex** (subscription plans, as an alternative to a local endpoint): run `/login` and pick `anthropic`, `openai-codex` (browser), or `openai-codex-device` (headless).

The same setup from the shell:

```sh
vib setup provider --preset local --base-url http://192.168.0.10:8000/v1   # e.g. a LAN GPU box; key from LOCAL_LLM_API_KEY, if any
```

The `vllm` and `sglang` presets are still available for scripts and CI that already target them:

```sh
vib setup provider --preset vllm --base-url http://192.168.0.10:8000/v1    # key from VLLM_API_KEY, if any
vib setup provider --preset sglang --base-url http://192.168.0.10:30000/v1 # key from SGLANG_API_KEY, if any
```

Plain `http://` is accepted for localhost, private-network hosts, bare hostnames, and `.local` / `.internal` / `.lan` names; public hosts need `https://`.

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
| `/provider` | Open the connect screen (local LLM endpoint, with OpenAI Codex/Claude as alternatives) |
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
