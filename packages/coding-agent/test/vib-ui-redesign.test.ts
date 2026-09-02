import { afterEach, describe, expect, it, vi } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { TEMPLATE } from "../src/export/html/template.generated";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
import { defaultThemes } from "../src/modes/theme/defaults";
import ligBlueTheme from "../src/modes/theme/defaults/lig-blue.json" with { type: "json" };
import ligWhiteTheme from "../src/modes/theme/defaults/lig-white.json" with { type: "json" };
import * as themeModule from "../src/modes/theme/theme";
import { ACP_BUILTIN_SLASH_COMMANDS } from "../src/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

describe("Vibrato LIG CI theme defaults", () => {
	afterEach(() => {
		themeModule.stopThemeWatcher();
		vi.restoreAllMocks();
	});

	it("uses lig-blue as the default dark theme and lig-white as the default light theme", async () => {
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false);

		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("lig-blue");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("lig-white");
		expect(themeModule.getCurrentThemeName()).toBe("lig-blue");

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false);
		expect(themeModule.getCurrentThemeName()).toBe("lig-white");
	});

	it("binds lig-blue to the LIG CI palette and keeps semantic tokens distinct", async () => {
		const colors = await themeModule.getResolvedThemeColors("lig-blue");
		const vars = ligBlueTheme.vars;

		expect(vars.brandBlue).toBe("#002F6D");
		expect(vars.brandGray).toBe("#BCBEC0");
		expect(vars.motifLight).toBe("#003D96");
		expect(vars.motifDark).toBe("#002D5C");
		expect(vars.dangerRed).toBeDefined();
		expect(vars.warningAmber).toBeDefined();
		expect(vars.diffRemovalRed).toBeDefined();

		expect(colors.accent).toBe(vars.accentTint);
		expect(colors.statusLineBg).toBe(vars.brandBlue);
		expect(colors.statusLineModel).toBe(vars.brandWhite);
		expect(colors.error).toBe(vars.dangerRed);
		expect(colors.warning).toBe(vars.warningAmber);
		expect(colors.toolDiffRemoved).toBe(vars.diffRemovalRed);
		expect(new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size).toBe(4);
		expect(ligBlueTheme.symbols.overrides["icon.pi"]).toBe("◆");
	});

	it("binds lig-white to LIG Innovative Blue on a white ground", async () => {
		const colors = await themeModule.getResolvedThemeColors("lig-white");
		const vars = ligWhiteTheme.vars;

		expect(themeModule.isLightTheme("lig-white")).toBe(true);
		expect(themeModule.isLightTheme("lig-blue")).toBe(false);
		expect(colors.accent).toBe(vars.brandBlue);
		expect(colors.borderAccent).toBe(vars.brandBlue);
		expect(colors.statusLineBg).toBe(vars.brandBlue);
		expect(colors.error).toBe(vars.dangerRed);
		expect(colors.warning).toBe(vars.warningAmber);
		expect(colors.toolDiffRemoved).toBe(vars.diffRemovalRed);
		expect(new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size).toBe(4);
	});

	it("exposes bundled selectable themes while preserving lig-blue and lig-white defaults", async () => {
		const themes = await themeModule.getAvailableThemes();

		// The pre-rebrand crab and ouroboros skins are gone; what ships is the LIG
		// pair plus the neutral third-party-flavoured themes.
		expect(themes).toEqual(["claude-code", "codex", "gruvbox-dark", "lig-blue", "lig-white", "opencode"]);
		expect(Object.keys(defaultThemes).sort()).toEqual([
			"claude-code",
			"codex",
			"gruvbox-dark",
			"lig-blue",
			"lig-white",
			"opencode",
		]);
		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("lig-blue");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("lig-white");
	});

	it("validates every bundled built-in theme against the schema-required token set", async () => {
		for (const [key, themeJson] of Object.entries(defaultThemes)) {
			// Registered map key must equal the theme's declared name.
			expect((themeJson as { name: string }).name, key).toBe(key);

			const colorKeys = Object.keys((themeJson as { colors: Record<string, unknown> }).colors);
			for (const token of themeModule.THEME_COLOR_KEYS) {
				expect(colorKeys, `${key} missing required token ${token}`).toContain(token);
			}

			// Var references resolve without missing/circular errors.
			const resolved = await themeModule.getResolvedThemeColors(key);
			expect(Object.keys(resolved).length, key).toBeGreaterThan(0);
		}
	});

	it("keeps migration themes dark-classified with distinct semantic tokens and no dead link token", async () => {
		for (const name of ["claude-code", "codex", "opencode"] as const) {
			const themeJson = defaultThemes[name] as {
				colors: Record<string, unknown>;
				symbols?: { overrides?: Record<string, unknown> };
			};
			// Do not carry the legacy non-schema `link` token into migration themes.
			expect(Object.keys(themeJson.colors), `${name} has dead link token`).not.toContain("link");

			// Migration themes keep Vibrato's symbol identity: preset only, no crab/source-tool overrides.
			expect(themeJson.symbols?.overrides, `${name} must not override Vibrato symbols`).toBeUndefined();

			expect(themeModule.isLightTheme(name), `${name} should classify as dark`).toBe(false);

			const colors = await themeModule.getResolvedThemeColors(name);
			expect(
				new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size,
				`${name} semantic tokens must be distinct`,
			).toBe(4);
		}
	});

	it("uses concrete hex for codex semantic, background, status, and diff tokens", async () => {
		const colors = await themeModule.getResolvedThemeColors("codex");
		const hex = /^#[0-9a-fA-F]{6}$/;
		for (const token of [
			"accent",
			"error",
			"warning",
			"toolDiffRemoved",
			"toolDiffAdded",
			"userMessageBg",
			"selectedBg",
			"customMessageBg",
			"toolPendingBg",
			"toolSuccessBg",
			"toolErrorBg",
			"statusLineBg",
		]) {
			expect(colors[token], `codex ${token} must be concrete hex`).toMatch(hex);
		}
	});

	it("exposes /theme only for TUI selection, not ACP text clients", () => {
		const command = lookupBuiltinSlashCommand("theme");

		expect(command?.handleTui).toBeDefined();
		expect(command?.handle).toBeUndefined();
		expect(ACP_BUILTIN_SLASH_COMMANDS.map(item => item.name)).not.toContain("theme");
	});

	it("keeps public status presets on the Vibrato identity", () => {
		expect(SETTINGS_SCHEMA["statusLine.separator"].default).toBe("slash");
		expect(STATUS_LINE_PRESETS.default.leftSegments).not.toContain("pi");
		expect(STATUS_LINE_PRESETS.default.separator).toBe("slash");
		expect(STATUS_LINE_PRESETS.full.leftSegments).toContain("vibrato");
		expect(STATUS_LINE_PRESETS.nerd.leftSegments).toContain("vibrato");
		for (const [name, preset] of Object.entries(STATUS_LINE_PRESETS)) {
			expect(preset.leftSegments, name).not.toContain("pi");
		}
	});

	it("brands HTML session exports as Vibrato without changing transcript role support", () => {
		expect(TEMPLATE).toContain("<title>Vibrato Session Export</title>");
		expect(TEMPLATE).toContain('content="vib-rato"');
		expect(TEMPLATE).toContain("Vibrato Session Export:");
		expect(TEMPLATE).toContain("Vibrato / vib-rato");
		expect(TEMPLATE).toContain("LIG System · Vibrato transcript");
		expect(TEMPLATE).toContain('class="brand-logo" alt="LIG System"');
		expect(TEMPLATE).toContain("--brand-blue:#002F6D");
		expect(TEMPLATE).toContain('meta[name="vib-url-params"]');
		expect(TEMPLATE).toContain('meta[name="vib-share-base-url"]');
		expect(TEMPLATE).toContain("vib-share:v1:sidebar-width");
		expect(TEMPLATE).toContain('meta[name="pi-url-params"]');
		expect(TEMPLATE).toContain('meta[name="pi-share-base-url"]');
		expect(TEMPLATE).toContain("pi-share:v1:sidebar-width");
		expect(TEMPLATE).toContain("developer-message");
		expect(TEMPLATE).toContain("tool-output");
	});
});
