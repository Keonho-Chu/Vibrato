---
name: vib-sdk-guides
description: Index of trusted Vibrato SDK reference guides (broker, session CLI, embedding, app development). Advisory only: read these documents for background; there is no guide to execute and no workflow skill to run.
---

# Vibrato SDK guides (advisory)

Advisory index of trusted Vibrato SDK reference documents. These guides are
reading material for background understanding; nothing in this skill is
executable and no workflow skill is invoked.

- `docs/sdk.md` — SDK overview: endpoint discovery, protocol, query and
  control surfaces, broker launch isolation, managed notification adapters.
- `docs/sdk-session-cli.md` — the `vib sdk session` command family: semantic
  verbs, raw hatch, lossless statuses, broker authority, and checkpoint gaps.
- `docs/sdk-embedding.md` — embedding Vibrato in-process.
- `docs/sdk-app-guide.md` — building applications on the SDK.

## Advisory boundary

The references above are consulted as background, never executed. The plugin
bundle keeps the four default workflow skills unchanged; this skill adds no
workflow and performs no configuration or state mutation.
