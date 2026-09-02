# Install, update channels, and platform setup

## Standard install

Prebuilt standalone binaries are the supported end-user install. Bun is not required.

```sh
# Tagged installer (recommended): pin the ref, then run locally.
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.15.3/scripts/install.sh -o vib-install.sh
sh vib-install.sh
vib --version
vib --smoke-test
```

Piping the `main` branch script executes mutable content:

```sh
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/main/scripts/install.sh | sh
```

Windows (PowerShell), tagged:

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.15.3/scripts/install.ps1 -OutFile vib-install.ps1
powershell -File vib-install.ps1
```

The installer downloads the current platform's GitHub release asset, verifies HTTP success, non-empty bytes, and published SHA-256 checksums, then runs `--version` and `--smoke-test`. A failed download or verification never replaces a working existing `vib`. Version discovery uses GitHub only (`https://api.github.com` and `https://github.com/<repo>/releases/download`); firewalled or mirrored registries are not used. Offline/source workflows use `--source` with an existing Bun.

Unix default location: `~/.local/bin/vib` (`VIB_INSTALL_DIR` overrides).
Windows default location: `%LOCALAPPDATA%\vib\vib.exe`.

## Supported platforms

Prebuilt standalone release binaries are published for:

- **Linux** — x64 and arm64, **glibc only** (musl/Alpine is not supported; use `--source` with existing Bun)
- **Windows** — x64
- **macOS** — Apple Silicon (arm64) and Intel (x64)

## Nightly channel

A verified nightly prerelease is published from `main` at 04:23 UTC and can also be started manually with the **nightly-release** CI dispatch. Nightly runs execute the complete main verification graph, build every supported native addon and standalone binary, and create a matching GitHub prerelease. They do not rewrite `main` or consume the `[Unreleased]` changelog sections.

```sh
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/main/scripts/install.sh | sh -s -- --channel nightly
vib --version
vib --smoke-test
```

Windows: pass `-Channel nightly` to `install.ps1`.

Already on Vibrato? Switch channels without reinstalling: `vib update --channel nightly` moves to the latest nightly, and `vib update --channel stable` switches a nightly install back to the latest stable (the command detects the channel switch and installs even though stable is semver-lower than the nightly). To make a channel the default for both `vib update` and the startup update check, set **Settings → Interaction → Update Channel** (the `startup.updateChannel` setting). In the brief window where a nightly shares the stable core version, add `--force` to move onto it.

Pin an exact release tag (binary assets required):

```sh
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/main/scripts/install.sh | sh -s -- --ref v0.15.0
```

## Development / source install

Bun is required only to build Vibrato from source. The installer never downloads Bun.

```sh
# Requires an existing Bun 1.3.14+ on PATH
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/main/scripts/install.sh | sh -s -- --source
```

From a checkout: `bun run install:dev`, then `bun run dev` / `bun run dev:link`. See the repository `AGENTS.md` for the development workflow.

## Windows notes

Vibrato's shell tool requires a bash-compatible shell on Windows. After a binary install, the PowerShell installer records Git Bash if it finds it. Options:

1. Install Git for Windows: https://git-scm.com/download/win
2. Use WSL, Cygwin, or MSYS2

Native Windows `vib --tmux` needs a tmux-compatible executable on `PATH`. For Vibrato-managed session guarantees, use WSL with real tmux. See [`environment-variables.md`](./environment-variables.md#interactive---tmux-startup-and-scrollmouse-profile).

## Shell completion

Vibrato can generate a Fig/withfig-compatible spec for [Microsoft inshellisense](https://github.com/microsoft/inshellisense):

```sh
vib completion inshellisense --install
```

The installer writes `vib.js` plus a minimal `index.js` into inshellisense's default local spec directory (`~/.fig/autocomplete/build`). If that directory already has an unrelated `index.js`, Vibrato refuses to clobber it unless `--force` is explicit; use `--dir <path>` for a separate Vibrato-only spec directory.

## Launch-time updates

Interactive startup checks GitHub releases for a newer Vibrato version in the background by default. This check is notify-only and non-mutating: Vibrato never installs or replaces itself during launch.

- Standalone binary or former Bun/npm install on a supported platform → `vib update` downloads and atomically replaces the matching GitHub release binary (package-manager shims are not overwritten; a user binary path is used and PATH migration is printed).
- Source checkout or `dev:link` executable → update, pull, build, and link through that checkout's original workflow. `vib update` refuses to self-overwrite it.
- Unsupported platform or unknown target → rerun the documented platform installer.

Run `vib config set startup.checkUpdate false` to disable the launch-time check. Network failures are ignored so they do not block startup.

`vib update` resolves `stable` from GitHub `/releases/latest` and `nightly` from the newest published GitHub prerelease. Optional `GITHUB_TOKEN` / `GH_TOKEN` raises API rate limits. `--check`, `--force`, and channel switch-back semantics are unchanged.

## Retry configuration

Provider retry budgets live in `~/.vib/config.yml`:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries` applies before a stream is established. `streamMaxRetries` applies only to replay-safe transient stream failures. Invalid auth, unsupported models/providers, malformed requests, context overflow, user aborts, and permanent quota failures remain fail-fast.
