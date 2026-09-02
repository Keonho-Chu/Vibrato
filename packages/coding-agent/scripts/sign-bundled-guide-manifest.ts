#!/usr/bin/env bun
/**
 * Re-sign the bundled advisory guide manifest after editing
 * `src/sdk/guides/bundled-manifest.ts`.
 *
 *   bun scripts/sign-bundled-guide-manifest.ts --key <pkcs8.pem> [--write]
 *
 * The private key never lives in the repository. Its public half must already
 * be pinned in `src/sdk/guides/verify.ts` (keyId = SHA-256 of the SPKI DER);
 * the script refuses to sign with any other key. Without `--write` it only
 * prints the detached Ed25519 signature hex.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import * as path from "node:path";
import { BUNDLED_GUIDE_MANIFESTS, BUNDLED_GUIDE_SIGNATURE_HEX } from "../src/sdk/guides/bundled-manifest";
import { canonicalGuideManifestBytes } from "../src/sdk/guides/manifest";
import { GUIDE_PINNED_KEYS } from "../src/sdk/guides/verify";

const args = process.argv.slice(2);
const keyIndex = args.indexOf("--key");
const keyPath = keyIndex >= 0 ? args[keyIndex + 1] : process.env.VIB_GUIDE_SIGNING_KEY;
const write = args.includes("--write");
if (!keyPath) {
	console.error("usage: sign-bundled-guide-manifest.ts --key <pkcs8.pem> [--write]");
	process.exit(2);
}

const privateKey = createPrivateKey(await Bun.file(keyPath).text());
const spkiDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const keyId = createHash("sha256").update(spkiDer).digest("hex");
const manifest = BUNDLED_GUIDE_MANIFESTS[0];
if (!manifest) throw new Error("No bundled guide manifest to sign.");
if (manifest.keyId !== keyId || !GUIDE_PINNED_KEYS.some(key => key.keyId === keyId)) {
	console.error(`Refusing to sign: key ${keyId} is not the pinned bundled key (${manifest.keyId}).`);
	console.error(`Pin it first in src/sdk/guides/verify.ts (spkiDerHex: ${spkiDer.toString("hex")}).`);
	process.exit(1);
}

const signatureHex = sign(null, canonicalGuideManifestBytes(manifest), privateKey).toString("hex");
console.log(signatureHex);
if (write) {
	const file = path.join(import.meta.dir, "..", "src", "sdk", "guides", "bundled-manifest.ts");
	const source = await Bun.file(file).text();
	if (!source.includes(BUNDLED_GUIDE_SIGNATURE_HEX))
		throw new Error("Could not locate the current signature constant.");
	await Bun.write(file, source.replace(BUNDLED_GUIDE_SIGNATURE_HEX, signatureHex));
	console.error(`Updated ${path.relative(process.cwd(), file)}`);
}
