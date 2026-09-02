# Design system — LIG System corporate identity

Vibrato's visual identity follows the LIG Corporate Identity Design Guidelines (2026.03 edition, Basic System BS 01–12 and Application System AS 19/20). This page records the tokens the product derives from that guide and where they are bound. The guide itself is managed by the CI department and is not vendored here; consult it for print, signage, and any use not covered below.

## Palette

| Token | Guide name | PANTONE | CMYK | HEX | Bound to |
| --- | --- | --- | --- | --- | --- |
| `brandBlue` | LIG Innovative Blue (main) | 294 C | C100 M86 Y30 K23 | `#002F6D` | Status-line background in both themes; accents, headings, links, and borders in `lig-white`; export header band; stats primary accent. |
| `brandGray` | LIG Futuristic Gray (sub) | CoolGray 4 C | K30 | `#BCBEC0` | Secondary/muted type in `lig-blue`; kicker and labels on the export header; welcome-mark sweep on dark terminals. |
| `brandWhite` | White | — | — | `#FFFFFF` | Primary type on LIG-blue and dark grounds. |
| `brandBlack` | Black | Black C | K100 | `#000000` | Reserved; not used as a UI colour. |

Two more values are derived from the guide's graphic-motif gradient (BS 12), which is specified only in CMYK. They are converted with the same scale the guide uses for the main colour and are used only for gradients, never as text:

| Token | Source | HEX |
| --- | --- | --- |
| `motifLight` | C100 M86 Y20 (K0) | `#003D96` |
| `motifDark` | C100 M80 Y30 K35 | `#002D5C` |

Motif gradient: `linear-gradient(120deg, #003D96 0%, #002F6D 55%, #002D5C 100%)`, the guide's 30° "L" cut expressed as a CSS angle.

One readability tint exists for the dark TUI only: `accentTint #7FA6E6` (and `skyTint #A9C4F0`) for links, headings, and keywords, because `#002F6D` text is unreadable on a dark terminal (contrast below 2:1). These tints are UI colours, never brand marks, and never appear in the export header or on the logotype.

## Background rules (BS 08)

- On white grounds the brand is carried by LIG Innovative Blue type and rules.
- On LIG-blue, black, or ≥ 40 % black grounds the wordmark and brand type are white or LIG Futuristic Gray. A lighter blue is never used for the mark.
- Forbidden everywhere (BS 09): recolouring, outlining, shadowing, tilting, or redrawing the wordmark; placing it on busy patterns or on similar-hue blue grounds.

This is why the welcome mark spells `vib` in block letters rather than drawing "LIG", and why its sweep is white ⇄ gray on dark terminals and navy ⇄ blue on light ones.

## Semantic tokens stay semantic

Error (`dangerRed`), warning (`warningAmber`), success (`successGreen`), and diff-removal (`diffRemovalRed`) keep their own hues in both themes and are asserted distinct from the accent by `scripts/verify-vib-ui-redesign.ts` and `packages/coding-agent/test/vib-ui-redesign.test.ts`.

## Typography (BS 10 / BS 11)

| Role | Guide typeface | Web stack (no bundling; system fallback) |
| --- | --- | --- |
| Titles | NanumSquare Light / Regular / Bold / ExtraBold | `"NanumSquare", "NanumSquareRound", "Nanum Gothic", -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif` |
| Body | KoPubDotum_Pro Light / Medium / Bold (serif alternative KoPubBatang_Pro) | `"KoPubDotum", "KoPub Dotum", "KoPubWorldDotum", "Nanum Gothic", -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif` |

Terminal surfaces use the user's terminal font. HTML exports keep monospace for transcript content and use the stacks above only for the header; the stats dashboard uses them for headings and body.

## Logotype

`assets/lig-system.png` (blue) and `assets/lig-system-w.png` (white) are the "LIG System" logotype from the guide's logo data, scaled and cropped so the transparent margin equals the guide's minimum clear space (one logotype height on every side, BS 03). The white variant is embedded in HTML exports as a data URI. Do not add other variants; the guide's minimum size rule (7 mm) is why no favicon or 16 px icon is generated from it.

## Where the tokens live

| Surface | File(s) |
| --- | --- |
| TUI themes | `packages/coding-agent/src/modes/theme/defaults/lig-blue.json`, `lig-white.json` |
| Default theme selection | `packages/coding-agent/src/modes/theme/theme.ts`, `src/config/settings-schema.ts`, `schemas/config.schema.json` |
| Welcome mark and gradient | `packages/coding-agent/src/modes/components/welcome.ts` |
| Status-line identity symbol | theme `symbols.overrides["icon.pi"]` (`◆`), rendered by `status-line/segments.ts` |
| HTML export header | `packages/coding-agent/src/export/html/template.css` / `template.js` (regenerate with `bun run generate-template`) |
| Stats dashboard | `packages/stats/src/client/styles.css`, `tailwind.config.js` |
| Gates | `bun run check:vib-ui` |

Legacy `red-claw` and `blue-crab` themes remain bundled for users who prefer them; they are not part of the corporate identity and are not defaults.
