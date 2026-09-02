# vib-rato

One-line npm package for the Vibrato `vib` CLI.

```sh
bun install -g vib-rato
```

Nightly builds use the separate npm `nightly` dist-tag and never move `latest`:

```sh
bun install -g vib-rato@nightly
```

Once installed, `vib update --channel nightly` / `vib update --channel stable` switch channels in place; the **Update Channel** settings entry (`startup.updateChannel`) picks the default channel for `vib update` and the startup update check.

This package is a thin public wrapper around `@vib-rato/coding-agent` so users can install the CLI without typing the npm organization scope.
