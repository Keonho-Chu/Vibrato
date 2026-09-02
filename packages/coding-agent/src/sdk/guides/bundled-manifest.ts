/**
 * Bundled advisory guide manifest data. This module deliberately contains no
 * self-verification so `scripts/sign-bundled-guide-manifest.ts` can import it
 * to (re)sign the canonical bytes after any edit; `catalog.ts` performs the
 * signature check at module load and refuses to start on a mismatch.
 *
 * Any semantic change here (manifest id, guide ids/titles, advisory texts)
 * changes the canonical manifest bytes and therefore REQUIRES re-signing with
 * the private key that pairs with the pinned key in `verify.ts`.
 */
import type { GuideEntryV1, GuideManifestV1 } from "./manifest";
import { GUIDE_PINNED_KEYS, guideAdvisoryDigest } from "./verify";

export const BUNDLED_GUIDE_MANIFEST_ID = "vib-rato-advisory-bundled";
export const BUNDLED_GUIDE_SIGNATURE_HEX =
	"7502a6ca742338b4cfd605f3bb78c76c01eafc41df0c0940a6821ac08a711c1c9552d2c82fe675af174e998aa731e6409f3c2e6a30dd0e44dc57f66d5bebe30d";

export const bundledGuideAdvisoryTexts: Readonly<Record<string, string>> = {
	"getting-started":
		"Vibrato ships a small set of signed advisory guides with the client so `vib sdk guides list` and `vib sdk guides show <guideId>` work offline on a fresh install. Guides are advisory text only: they are rendered for reading and never executed or applied as configuration. To receive newer guides, run `vib sdk guides refresh --url <https manifest url>`. The manifest must come from the allowlisted HTTPS host and must be signed by a pinned Ed25519 key; a rejected refresh falls back to the last verified cache, then to the bundled seed, and any rejection is reported in the warnings list.",
	"sdk/session-cli":
		"`vib sdk session` is the broker-bound command family for operating live Vibrato SDK sessions from the terminal: `list` enumerates managed sessions, `inspect` shows session details, `send` submits a prompt turn, `status` reports session health, and `tail` follows the event stream. The explicit `raw` hatch dispatches one SDK operation as `control`, `query`, or `global`. Authority resolves through the local broker and endpoint credentials are never rendered by the CLI.",
	"troubleshooting/sdk-connection":
		"When an SDK connection fails, first check that the session host is alive and healthy: `vib sdk session status` reports readiness and liveness. If the broker is gone, restart it and re-list sessions; detached hosts are reaped after a bounded absence grace. Fetch-boundary failures (offline host, allowlisted URL violations, signature rejections) are reported as typed errors with exit code 1 so scripts can fail closed instead of silently serving unverified content.",
};

function bundledGuideSeedEntry(id: string, title: string): GuideEntryV1 {
	const text = bundledGuideAdvisoryTexts[id];
	if (text === undefined) throw new Error(`Bundled guide ${id} has no advisory text.`);
	return { id, title, sha256: guideAdvisoryDigest(new TextEncoder().encode(text)) };
}

/**
 * Trusted-by-compilation bundled manifests. The seed manifest is signed by the
 * bundled pinned key (`verify.ts`), and every bundled advisory ships its text
 * so fresh-install `list`/`show` work offline with no cache. The seed is
 * selected only when no valid online or cached manifest exists; because the
 * bundled manifest is itself signature-verified at module load, bundling the
 * signature here preserves the normal verify path for bundled content.
 */
export const BUNDLED_GUIDE_MANIFESTS: readonly GuideManifestV1[] = [
	{
		version: 1,
		manifestId: BUNDLED_GUIDE_MANIFEST_ID,
		keyId: GUIDE_PINNED_KEYS[0].keyId,
		sequence: 1,
		issuedAt: Date.UTC(2026, 0, 1),
		expiresAt: Date.UTC(2036, 0, 1),
		minimumSdkVersion: 1,
		guides: [
			bundledGuideSeedEntry("getting-started", "Getting started with the SDK advisory catalog"),
			bundledGuideSeedEntry("sdk/session-cli", "Using the SDK session CLI"),
			bundledGuideSeedEntry("troubleshooting/sdk-connection", "Troubleshooting SDK connection failures"),
		],
	},
];
for (const manifest of BUNDLED_GUIDE_MANIFESTS) {
	for (const entry of manifest.guides) Object.freeze(entry);
	Object.freeze(manifest.guides);
	Object.freeze(manifest);
}
Object.freeze(BUNDLED_GUIDE_MANIFESTS);
