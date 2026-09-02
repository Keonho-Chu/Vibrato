# Vibrato Rebranding Plan — 2026-09-02

## Status

Executed. This document records the second rebrand of the project, from gajae-code / GJC to **Vibrato**, and the naming contract that gates now enforce.

Repository: https://github.com/Keonho-Chu/Vibrato

## Decision

Full rename with a clean break. Unlike the 2026-05-26 visual rebrand (`docs/REBRANDING_PLAN_260525.md`), which deliberately kept the `gjc` / `@gajae-code/*` surfaces, this rebrand renames every public and internal identifier and provides **no** compatibility aliases, shims, environment fallbacks, or config-root migrations for the retired names.

## Naming contract

| Surface | Before | After |
| --- | --- | --- |
| Product name | Gajae-Code / GJC | Vibrato |
| CLI command | `gjc`, `gjc-stats`, `가재씨` | `vib`, `vib-stats` (Korean alias removed) |
| npm scope | `@gajae-code/*` | `@vib-rato/*` |
| Unscoped npm alias package | `gajae-code` | `vib-rato` (`vibrato` and `vib` are taken on npm) |
| Config root | `~/.gjc`, project `.gjc` | `~/.vib`, project `.vib` |
| Environment prefix | `GJC_*` | `VIB_*` |
| Rust SDK crate | `gjc-sdk` | `vib-sdk` |
| Plugin kind | `gajae-code-plugin` | `vib-rato-plugin` |
| Stream Deck bundle id | `dev.gajae.streamdeck` | `dev.vibrato.streamdeck` |
| Harness identifier | `gajae-code` | `vib-rato` |
| GitHub repository | `Yeachan-Heo/gajae-code` | `Keonho-Chu/Vibrato` |

Identifier casing follows the token: `GJC_X` → `VIB_X`, `GjcFoo` → `VibFoo`, `gjcFoo` → `vibFoo`, prose `GJC` → `Vibrato`, `Gajae` → `Vibrato`.

## Retained on purpose

- Upstream `pi` names (`pi-natives`, `pi-utils`, `pi-shell`, `PI_*` env aliases) are unrelated to this rebrand and stay as documented in the 2026-05-26 plan.
- Upstream attribution links that the earlier rebrand had rewritten to `can1357/gajae-code` now point back at `can1357/oh-my-pi`.
- `"author"` fields keep the original author; only the "Contributors" brand phrase changed.
- Released `CHANGELOG.md` sections, `LICENSE`, `NOTICE`, `issues/`, `.plans/`, and `docs/prompt-architect-reports/` are immutable history and keep the names in use at the time.
- Theme names (`red-claw`, `blue-crab`) and the pet widget are visual identity, not naming, and were left for a separate design decision. That decision was taken the same day: the LIG System corporate identity is now the default visual system (`docs/design-system.md`).

## Gates

`bun scripts/rebrand-inventory.ts --strict` now treats `gajae` and `gjc` as forbidden legacy tokens outside the allowlisted history paths, alongside the existing `oh-my-pi` / `omp` checks. `scripts/verify-g002-gates.ts` and `scripts/check-visible-definitions.ts` encode the new package, bin, and definition names.

## Signed bundled guide manifest

The rename changed the canonical bytes of the bundled advisory guide manifest (`packages/coding-agent/src/sdk/guides/bundled-manifest.ts`), which is verified against a pinned Ed25519 key at module load. The upstream private key was never in the repository, so the trust root was rotated on 2026-09-02: a new key pair was generated, its public half is pinned in `src/sdk/guides/verify.ts` (keyId `d3c91f0eac1143a9d8b3be6d4317c38cda7b884e2b6b2d71bf52387ebe86a0a6`), and the manifest was re-signed with `bun scripts/sign-bundled-guide-manifest.ts --key <pem> --write`. The private key lives outside the repository at `~/.vib/keys/guide-manifest-signing.pem` on the maintainer's machine; back it up, because online guide manifests for `guides.vib-rato.com` must be signed with the same key. Any edit to the bundled manifest requires re-signing.

Hash-domain strings that carry the product name (managed session scope digest, secret-obfuscation placeholders, machine identity, model-discovery provenance) also changed. Pinned test vectors were recomputed; persisted values produced under the old names are not recognised, which is consistent with the clean-break decision.

## Operator follow-ups (outside the repo)

1. Create the `vib-rato` npm organisation and publish `@vib-rato/*` plus `vib-rato`; deprecate the `@gajae-code/*` and `gajae-code` packages.
2. Push this branch to `Keonho-Chu/Vibrato` and update the `origin` remote; rotate any CI secrets bound to the old repository.
3. Re-run `bun run dev:link` so the local `vib` symlink replaces `gjc`; delete stale `~/.gjc` and project `.gjc` directories by hand (no migration is performed).
4. Publish a release note pointing users at the table above.
