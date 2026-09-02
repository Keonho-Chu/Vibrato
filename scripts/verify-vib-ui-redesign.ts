#!/usr/bin/env bun

import * as path from "node:path";

interface GateResult {
	name: string;
	passed: boolean;
	details: string[];
}

const repoRoot = path.join(import.meta.dir, "..");

const results: GateResult[] = [
	await verifyThemeDefaults(),
	await verifyStatusDefaults(),
	await verifyExportBranding(),
	await verifyDocsBranding(),
];

for (const result of results) {
	console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
	for (const detail of result.details) console.log(`  - ${detail}`);
}

const failed = results.filter(result => !result.passed);
if (failed.length > 0) {
	console.error(`\nVibrato UI redesign verification failed: ${failed.map(result => result.name).join(", ")}`);
	process.exit(1);
}

console.log("\nVibrato UI redesign verification passed.");

async function verifyThemeDefaults(): Promise<GateResult> {
	const settings = await readText("packages/coding-agent/src/config/settings-schema.ts");
	const themeRuntime = await readText("packages/coding-agent/src/modes/theme/theme.ts");
	const ligBlue = await readJson("packages/coding-agent/src/modes/theme/defaults/lig-blue.json");
	const ligWhite = await readJson("packages/coding-agent/src/modes/theme/defaults/lig-white.json");
	const ouroboros = await readJson("packages/coding-agent/src/modes/theme/defaults/ouroboros.json");
	const defaultIndex = await readText("packages/coding-agent/src/modes/theme/defaults/index.ts");
	const colors = isRecord(ligBlue.colors) ? ligBlue.colors : {};
	const vars = isRecord(ligBlue.vars) ? ligBlue.vars : {};
	const lightColors = isRecord(ligWhite.colors) ? ligWhite.colors : {};
	const lightVars = isRecord(ligWhite.vars) ? ligWhite.vars : {};

	const semanticPairs = [
		["accent", "error"],
		["accent", "warning"],
		["accent", "toolDiffRemoved"],
		["error", "warning"],
		["error", "toolDiffRemoved"],
	] as const;
	const semanticFindings = semanticPairs
		.filter(([left, right]) => resolveColor(colors[left], vars) === resolveColor(colors[right], vars))
		.map(([left, right]) => `${left} matches ${right}`);

	const expectedBuiltIns = ["blue-crab", "claude-code", "codex", "gruvbox-dark", "lig-blue", "lig-white", "opencode", "ouroboros", "red-claw"];
	const retainedBuiltIns =
		[...defaultIndex.matchAll(/^import /gm)].length === expectedBuiltIns.length &&
		[...defaultIndex.matchAll(/^\t/gm)].length === expectedBuiltIns.length &&
		defaultIndex.includes('"blue-crab": blue_crab') &&
		defaultIndex.includes('"claude-code": claude_code') &&
		defaultIndex.includes("\tcodex,") &&
		defaultIndex.includes('"gruvbox-dark": gruvbox_dark') &&
		defaultIndex.includes('"lig-blue": lig_blue') &&
		defaultIndex.includes('"lig-white": lig_white') &&
		defaultIndex.includes("\topencode,") &&
		defaultIndex.includes("\touroboros,") &&
		defaultIndex.includes('"red-claw": red_claw') &&
		!defaultIndex.includes("dark_") &&
		!defaultIndex.includes("light_") &&
		isRecord(ouroboros.colors);
	const ligPalette =
		vars.brandBlue === "#002F6D" &&
		vars.brandGray === "#BCBEC0" &&
		lightVars.brandBlue === "#002F6D" &&
		resolveColor(colors.statusLineBg, vars) === "#002F6D" &&
		resolveColor(lightColors.accent, lightVars) === "#002F6D" &&
		resolveColor(lightColors.borderAccent, lightVars) === "#002F6D";

	return {
		name: "lig-blue/lig-white theme defaults, LIG CI palette, and semantic token split",
		passed:
			settings.includes('default: "lig-blue"') &&
			settings.includes('default: "lig-white"') &&
			themeRuntime.includes('autoDarkTheme: string = "lig-blue"') &&
			themeRuntime.includes('autoLightTheme: string = "lig-white"') &&
			retainedBuiltIns &&
			ligPalette &&
			resolveColor(colors.accent, vars) === resolveColor(vars.accentTint, vars) &&
			resolveColor(colors.error, vars) === resolveColor(vars.dangerRed, vars) &&
			resolveColor(colors.warning, vars) === resolveColor(vars.warningAmber, vars) &&
			resolveColor(colors.toolDiffRemoved, vars) === resolveColor(vars.diffRemovalRed, vars) &&
			semanticFindings.length === 0,
		details: [
			`settings default lig-blue: ${settings.includes('default: "lig-blue"')}`,
			`settings default lig-white: ${settings.includes('default: "lig-white"')}`,
			`runtime autoDarkTheme lig-blue: ${themeRuntime.includes('autoDarkTheme: string = "lig-blue"')}`,
			`runtime autoLightTheme lig-white: ${themeRuntime.includes('autoLightTheme: string = "lig-white"')}`,
			`LIG CI palette bound (Innovative Blue #002F6D / Futuristic Gray #BCBEC0): ${ligPalette}`,
			`expected built-in themes (${expectedBuiltIns.join(", ")}): ${retainedBuiltIns}`,
			`semantic collisions: ${semanticFindings.join("; ") || "<none>"}`,
		],
	};
}

async function verifyStatusDefaults(): Promise<GateResult> {
	const presets = await readText("packages/coding-agent/src/modes/components/status-line/presets.ts");
	const defaultStart = presets.indexOf("default:");
	const minimalStart = presets.indexOf("minimal:");
	const compactStart = presets.indexOf("compact:");
	const fullStart = presets.indexOf("full:");
	const defaultBlock = defaultStart >= 0 && minimalStart > defaultStart ? presets.slice(defaultStart, minimalStart) : "";
	const compactBlock = compactStart >= 0 && fullStart > compactStart ? presets.slice(compactStart, fullStart) : "";
	const leftSegmentsByPreset = parsePresetLeftSegments(presets);
	const publicPresetUsesPi = Object.entries(leftSegmentsByPreset).filter(([, segments]) => segments.includes("pi"));
	const fullUsesVibrato = leftSegmentsByPreset.full?.includes("vibrato") === true;
	const nerdUsesVibrato = leftSegmentsByPreset.nerd?.includes("vibrato") === true;
	return {
		name: "default-visible status line identity",
		passed:
			defaultBlock.includes('separator: "slash"') &&
			!defaultBlock.includes('"pi"') &&
			compactBlock.includes('separator: "slash"') &&
			presets.includes('full: {') &&
			fullUsesVibrato &&
			nerdUsesVibrato &&
			publicPresetUsesPi.length === 0,
		details: [
			`default separator slash: ${defaultBlock.includes('separator: "slash"')}`,
			`default pi segment absent: ${!defaultBlock.includes('"pi"')}`,
			`full Vibrato identity present: ${fullUsesVibrato}`,
			`nerd Vibrato identity present: ${nerdUsesVibrato}`,
			`public pi preset absent: ${publicPresetUsesPi.length === 0}${
				publicPresetUsesPi.length > 0 ? ` (${publicPresetUsesPi.map(([name]) => name).join(", ")})` : ""
			}`,
		],
	};
}

function parsePresetLeftSegments(source: string): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	const presetRegex = /\n\t([a-z_]+): \{[\s\S]*?leftSegments: \[([^\]]*)\]/g;
	for (const match of source.matchAll(presetRegex)) {
		const [, name, rawSegments] = match;
		if (!name || !rawSegments) continue;
		result[name] = [...rawSegments.matchAll(/"([^"]+)"/g)].map(segmentMatch => segmentMatch[1]).filter(Boolean);
	}
	return result;
}

async function verifyExportBranding(): Promise<GateResult> {
	const templateHtml = await readText("packages/coding-agent/src/export/html/template.html");
	const templateJs = await readText("packages/coding-agent/src/export/html/template.js");
	const generated = await readText("packages/coding-agent/src/export/html/template.generated.ts");
	return {
		name: "HTML export Vibrato branding",
		passed:
			templateHtml.includes("Vibrato Session Export") &&
			templateHtml.includes('content="vib-rato"') &&
			templateJs.includes("LIG System · Vibrato transcript") &&
			templateJs.includes('class="brand-logo" alt="LIG System"') &&
			templateJs.includes("Vibrato / vib-rato") &&
			templateJs.includes('meta[name="vib-url-params"]') &&
			templateJs.includes('meta[name="vib-share-base-url"]') &&
			templateJs.includes("vib-share:v1:sidebar-width") &&
			templateJs.includes('meta[name="pi-url-params"]') &&
			templateJs.includes('meta[name="pi-share-base-url"]') &&
			templateJs.includes("pi-share:v1:sidebar-width") &&
			generated.includes("Vibrato Session Export") &&
			generated.includes("tool-output"),
		details: [
			`title/meta branded: ${templateHtml.includes("Vibrato Session Export") && templateHtml.includes('content="vib-rato"')}`,
			`header product branded: ${templateJs.includes("Vibrato / vib-rato")}`,
			`header LIG System identity: ${templateJs.includes("LIG System · Vibrato transcript")}`,
			`Vibrato metadata/storage keys present: ${templateJs.includes('meta[name="vib-url-params"]') && templateJs.includes('meta[name="vib-share-base-url"]') && templateJs.includes("vib-share:v1:sidebar-width")}`,
			`legacy metadata/storage fallback retained: ${templateJs.includes('meta[name="pi-url-params"]') && templateJs.includes('meta[name="pi-share-base-url"]') && templateJs.includes("pi-share:v1:sidebar-width")}`,
			`generated template refreshed: ${generated.includes("Vibrato Session Export")}`,
			`transcript tool content still present: ${generated.includes("tool-output")}`,
		],
	};
}

async function verifyDocsBranding(): Promise<GateResult> {
	const rootReadme = await readText("README.md");
	const packageReadme = await readText("packages/coding-agent/README.md");
	const themeDoc = await readText("docs/theme.md");
	return {
		name: "public docs current LIG CI theme direction",
		passed:
			rootReadme.includes("default dark TUI identity is the lig-blue theme") &&
			rootReadme.includes("light-appearance terminals default to the bundled lig-white theme") &&
			packageReadme.includes("defaults to the bundled `lig-blue`") &&
			packageReadme.includes("bundled `lig-white` theme") &&
			themeDoc.includes('theme.dark = "lig-blue"') &&
			themeDoc.includes('theme.light = "lig-white"'),
		details: [
			`README lig-blue default: ${rootReadme.includes("default dark TUI identity is the lig-blue theme")}`,
			`README lig-white light default: ${rootReadme.includes("light-appearance terminals default to the bundled lig-white theme")}`,
			`package README default lig-blue: ${packageReadme.includes("defaults to the bundled `lig-blue`")}`,
			`package README default lig-white: ${packageReadme.includes("bundled `lig-white` theme")}`,
			`theme docs default lig-blue: ${themeDoc.includes('theme.dark = "lig-blue"')}`,
			`theme docs default lig-white: ${themeDoc.includes('theme.light = "lig-white"')}`,
		],
	};
}

async function readText(relativePath: string): Promise<string> {
	return await Bun.file(path.join(repoRoot, relativePath)).text();
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
	const value = await Bun.file(path.join(repoRoot, relativePath)).json();
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveColor(value: unknown, vars: Record<string, unknown>): unknown {
	if (typeof value !== "string") return value;
	const key = value.startsWith("$") ? value.slice(1) : value;
	return key in vars ? vars[key] : value;
}
