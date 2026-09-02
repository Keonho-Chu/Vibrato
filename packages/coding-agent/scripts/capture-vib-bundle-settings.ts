import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VibLifecycleContext } from "../src/extensibility/vib-plugins/lifecycle";
import type { VibRuntimeSnapshotProvider } from "../src/extensibility/vib-plugins/runtime-quarantine";
import type {
	VibBundleIdentity,
	VibBundleSummary,
	VibLifecycleResult,
	VibToggleResult,
	VibUpdateApplyResult,
	VibUpdatePreview,
} from "../src/extensibility/vib-plugins/types";
import { type VibBundleLifecyclePort, VibBundleSettingsComponent } from "../src/modes/components/vib-bundle-settings";
import { setTheme } from "../src/modes/theme/theme";
import {
	VIB_BUNDLE_SETTINGS_ENTRIES,
	VIB_BUNDLE_SETTINGS_STATES,
	VIB_BUNDLE_SETTINGS_VIEWPORTS,
	type VibBundleSettingsFixture,
} from "../test/fixtures/vib-bundles-settings-cases";

export const VIB_BUNDLE_SETTINGS_CAPTURE_FILES = [
	"terminal.txt",
	"terminal-ansi.txt",
	"terminal.html",
	"metadata.json",
] as const;

type CaptureFileName = (typeof VIB_BUNDLE_SETTINGS_CAPTURE_FILES)[number];

type FixtureEntry = (typeof VIB_BUNDLE_SETTINGS_ENTRIES)[number];

type CapturePlanItem = {
	entryId: string;
	fileName: CaptureFileName;
};

type CaptureMetadata = {
	entryId: string;
	stateId: string;
	viewport: { id: string; cols: number; rows: number };
	variant: { renderMode: string };
	sha256: Record<Exclude<CaptureFileName, "metadata.json">, string>;
};

/**
 * Locator-shaped content that must never reach a capture. Applied to the
 * rendered terminal text, which is the only surface that can carry a leaked
 * locator; generated HTML/CSS legitimately contains `#rrggbb` colors and
 * escaped entities, so it is checked against the same rules via its source
 * text rather than its markup.
 */
const FORBIDDEN_CAPTURE_CONTENT = /:\/\/user:|@[^\s/]+|\?[^\s]*=|token|\/Users\/|\/home\//i;

function sha256(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ansiToHtml(ansi: string): string {
	const sgr = /\x1b\[([0-9;]*)m/g;
	let html = "";
	let offset = 0;
	let style = "";
	for (const match of ansi.matchAll(sgr)) {
		html += `<span style="${style}">${escapeHtml(ansi.slice(offset, match.index))}</span>`;
		offset = (match.index ?? 0) + match[0].length;
		const codes = (match[1] || "0").split(";").map(Number);
		for (let index = 0; index < codes.length; index += 1) {
			const code = codes[index];
			if (code === 0) style = "";
			else if (code === 1) style = `${style}font-weight:700;`;
			else if (code === 2) style = `${style}opacity:.65;`;
			else if (code === 22) style = style.replace("font-weight:700;", "").replace("opacity:.65;", "");
			else if (code === 38 && codes[index + 1] === 2) {
				const [red, green, blue] = codes.slice(index + 2, index + 5);
				if ([red, green, blue].every(Number.isInteger)) style = `${style}color:rgb(${red},${green},${blue});`;
				index += 4;
			} else if (code === 39) style = style.replace(/color:[^;]+;/g, "");
		}
	}
	html += `<span style="${style}">${escapeHtml(ansi.slice(offset))}</span>`;
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Vibrato Bundles settings</title><style>body{margin:0;background:#111;color:#eee}pre{margin:0;padding:1em;white-space:pre-wrap;font-family:ui-monospace,monospace;line-height:1.2}</style></head>
<body><pre>${html}</pre></body>
</html>
`;
}

function asciiText(text: string): string {
	return text
		.replaceAll("─", "-")
		.replaceAll("…", "...")
		.replaceAll("·", ".")
		.replaceAll("→", "->")
		.replaceAll("−", "-");
}

function cloneSummary(summary: VibBundleSummary): VibBundleSummary {
	return {
		...summary,
		identity: { ...summary.identity },
		source: { ...summary.source },
		surfaces: summary.surfaces.map(surface => ({ ...surface })),
	};
}

class FixtureLifecyclePort implements VibBundleLifecyclePort {
	constructor(private readonly fixture: VibBundleSettingsFixture) {}

	async listVibBundles(_ctx: VibLifecycleContext): Promise<VibBundleSummary[]> {
		return this.fixture.bundles.map(cloneSummary);
	}

	async getVibBundle(
		_ctx: VibLifecycleContext,
		identity: VibBundleIdentity,
	): Promise<VibLifecycleResult<VibBundleSummary>> {
		const summary = this.fixture.bundles.find(
			bundle =>
				bundle.identity.kind === identity.kind &&
				bundle.identity.scope === identity.scope &&
				bundle.identity.name === identity.name,
		);
		return summary
			? { ok: true, value: cloneSummary(summary) }
			: { ok: false, error: { code: "not_installed", message: "Bundle is not installed." } };
	}

	async previewVibBundleUpdate(
		_ctx: VibLifecycleContext,
		_identity: VibBundleIdentity,
	): Promise<VibLifecycleResult<VibUpdatePreview>> {
		return this.fixture.updatePreview
			? { ok: true, value: this.fixture.updatePreview }
			: { ok: false, error: { code: "source_unsupported", message: "Update is unavailable." } };
	}

	async applyVibBundleUpdate(
		_ctx: VibLifecycleContext,
		_token: VibUpdatePreview["token"],
	): Promise<VibLifecycleResult<VibUpdateApplyResult>> {
		return { ok: false, error: { code: "stale_candidate", message: "Capture fixtures do not apply updates." } };
	}

	async setVibBundleEnabled(
		_ctx: VibLifecycleContext,
		_identity: VibBundleIdentity,
		_enabled: boolean,
	): Promise<VibLifecycleResult<VibToggleResult>> {
		return { ok: false, error: { code: "invalid_target", message: "Capture fixtures do not mutate bundles." } };
	}

	async setVibBundleSurfaceEnabled(
		_ctx: VibLifecycleContext,
		_identity: VibBundleIdentity,
		_surfaceId: string,
		_enabled: boolean,
	): Promise<VibLifecycleResult<VibToggleResult>> {
		return { ok: false, error: { code: "invalid_target", message: "Capture fixtures do not mutate surfaces." } };
	}
}

function fixtureFor(stateId: string): VibBundleSettingsFixture {
	const state = VIB_BUNDLE_SETTINGS_STATES.find(candidate => candidate.id === stateId);
	if (!state) throw new Error(`Unknown Vibrato Bundle settings state: ${stateId}`);
	return state.fixture;
}

function viewportFor(viewportId: string): { id: string; cols: number; rows: number } {
	const viewport = VIB_BUNDLE_SETTINGS_VIEWPORTS.find(candidate => candidate.id === viewportId);
	if (viewport) return viewport;
	if (viewportId === "48x36") return { id: "48x36", cols: 48, rows: 36 };
	throw new Error(`Unknown Vibrato Bundle settings viewport: ${viewportId}`);
}

async function settle(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

export async function renderVibBundleSettingsEntry(
	entry: FixtureEntry,
): Promise<{ terminalText: string; terminalAnsiText: string; viewport: { id: string; cols: number; rows: number } }> {
	const fixture = fixtureFor(entry.stateId);
	const viewport = viewportFor(entry.viewportId);
	const runtime: VibRuntimeSnapshotProvider = { current: () => fixture.runtime };
	await setTheme("red-claw");
	const component = new VibBundleSettingsComponent(
		"/fixture/project",
		{ onClose: () => {} },
		{
			lifecycle: new FixtureLifecyclePort(fixture),
			runtimeSnapshotProvider: runtime,
			activationGeneration: 7,
		},
	);
	await settle();
	const rendered = component.render(viewport.cols).join("\n");
	component.dispose();
	const terminalAnsiText = entry.renderMode === "ascii-no-color" ? asciiText(Bun.stripANSI(rendered)) : rendered;
	const terminalText = Bun.stripANSI(terminalAnsiText);
	return { terminalText, terminalAnsiText, viewport };
}

export function vibBundleSettingsCapturePlan(
	entries: readonly FixtureEntry[] = VIB_BUNDLE_SETTINGS_ENTRIES,
): CapturePlanItem[] {
	return entries.flatMap(entry =>
		VIB_BUNDLE_SETTINGS_CAPTURE_FILES.map(fileName => ({ entryId: entry.entryId, fileName })),
	);
}

function assertSafeContent(label: string, content: string): void {
	if (FORBIDDEN_CAPTURE_CONTENT.test(content)) throw new Error(`Unsafe locator content in ${label}`);
}

async function artifactContents(entry: FixtureEntry): Promise<Record<CaptureFileName, string>> {
	const rendered = await renderVibBundleSettingsEntry(entry);
	const terminalHtml = ansiToHtml(rendered.terminalAnsiText);
	const metadata: CaptureMetadata = {
		entryId: entry.entryId,
		stateId: entry.stateId,
		viewport: rendered.viewport,
		variant: { renderMode: entry.renderMode },
		sha256: {
			"terminal.txt": sha256(rendered.terminalText),
			"terminal-ansi.txt": sha256(rendered.terminalAnsiText),
			"terminal.html": sha256(terminalHtml),
		},
	};
	return {
		"terminal.txt": rendered.terminalText,
		"terminal-ansi.txt": rendered.terminalAnsiText,
		"terminal.html": terminalHtml,
		"metadata.json": json(metadata),
	};
}

async function writeEntry(entry: FixtureEntry, outputRoot: string): Promise<void> {
	const artifacts = await artifactContents(entry);
	// The HTML artifact is a pure rendering of the ANSI text, so proving the two
	// text surfaces and the metadata are clean proves the whole entry is clean.
	for (const name of ["terminal.txt", "terminal-ansi.txt", "metadata.json"] as const) {
		assertSafeContent(`${entry.entryId}/${name}`, artifacts[name]);
	}
	const directory = path.join(outputRoot, entry.entryId);
	await fs.mkdir(directory, { recursive: true });
	await Promise.all(
		VIB_BUNDLE_SETTINGS_CAPTURE_FILES.map(fileName => Bun.write(path.join(directory, fileName), artifacts[fileName])),
	);
}

export async function verifyVibBundleSettingsCapture(outputRoot: string): Promise<void> {
	for (const entry of VIB_BUNDLE_SETTINGS_ENTRIES) {
		const directory = path.join(outputRoot, entry.entryId);
		const names = (await fs.readdir(directory)).sort();
		if (
			names.length !== VIB_BUNDLE_SETTINGS_CAPTURE_FILES.length ||
			names.some((name, index) => name !== VIB_BUNDLE_SETTINGS_CAPTURE_FILES.slice().sort()[index])
		) {
			throw new Error(`Expected exactly four capture files for ${entry.entryId}`);
		}
		const artifacts = await artifactContents(entry);
		for (const fileName of VIB_BUNDLE_SETTINGS_CAPTURE_FILES) {
			const content = await Bun.file(path.join(directory, fileName)).text();
			assertSafeContent(`${entry.entryId}/${fileName}`, content);
			if (content !== artifacts[fileName])
				throw new Error(`Capture does not match deterministic fixture render for ${entry.entryId}/${fileName}`);
		}
		const metadata = JSON.parse(artifacts["metadata.json"]) as CaptureMetadata;
		for (const fileName of ["terminal.txt", "terminal-ansi.txt", "terminal.html"] as const) {
			if (metadata.sha256[fileName] !== sha256(artifacts[fileName]))
				throw new Error(`SHA-256 mismatch for ${entry.entryId}/${fileName}`);
		}
	}
}

function parseArgs(args: string[]): { mode: "capture" | "verify"; outputRoot: string } {
	if (args.length === 2 && args[0] === "--output" && args[1]) return { mode: "capture", outputRoot: args[1] };
	if (args.length === 2 && args[0] === "--verify" && args[1]) return { mode: "verify", outputRoot: args[1] };
	throw new Error("Usage: bun scripts/capture-vib-bundle-settings.ts --output <directory> | --verify <directory>");
}

async function main(): Promise<void> {
	const { mode, outputRoot } = parseArgs(process.argv.slice(2));
	const resolvedOutputRoot = path.resolve(outputRoot);
	if (mode === "verify") {
		await verifyVibBundleSettingsCapture(resolvedOutputRoot);
		process.stdout.write(
			`Verified ${VIB_BUNDLE_SETTINGS_ENTRIES.length} deterministic Vibrato Bundle settings entries.\n`,
		);
		return;
	}
	for (const entry of VIB_BUNDLE_SETTINGS_ENTRIES) await writeEntry(entry, resolvedOutputRoot);
	process.stdout.write(
		`Captured ${VIB_BUNDLE_SETTINGS_ENTRIES.length} deterministic Vibrato Bundle settings entries.\n`,
	);
}

if (import.meta.main) await main();
