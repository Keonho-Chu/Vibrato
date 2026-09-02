import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { SettingPath } from "@vib-rato/coding-agent/config/settings";
import { resetSettingsForTest, Settings, settings } from "@vib-rato/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@vib-rato/coding-agent/modes/components/settings-selector";
import { initTheme, previewTheme, restoreThemePreview, theme } from "@vib-rato/coding-agent/modes/theme/theme";

const THEMES = ["lig-blue", "lig-white"];
const ORIGINAL_COLORTERM = Bun.env.COLORTERM;

type ChangedSetting = {
	path: SettingPath;
	value: unknown;
};

type SelectorHarness = {
	component: SettingsSelectorComponent;
	previewedThemes: string[];
	restoredThemes: string[];
	changedSettings: ChangedSetting[];
	committedThemes: string[];
};

beforeAll(async () => {
	Bun.env.COLORTERM = "truecolor";
	await initTheme(false, undefined, undefined, "lig-blue", "lig-white");
});

afterAll(() => {
	if (ORIGINAL_COLORTERM === undefined) {
		delete Bun.env.COLORTERM;
	} else {
		Bun.env.COLORTERM = ORIGINAL_COLORTERM;
	}
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	settings.set("theme.dark", "lig-blue");
	settings.set("theme.light", "lig-white");
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function createSelector(): SelectorHarness {
	const previewedThemes: string[] = [];
	const restoredThemes: string[] = [];
	const changedSettings: ChangedSetting[] = [];
	const committedThemes: string[] = [];
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: THEMES,
			availableModelProfiles: [],
			cwd: process.cwd(),
		},
		{
			onChange: (path, value) => {
				changedSettings.push({ path, value });
			},
			onThemePreview: themeName => {
				previewedThemes.push(themeName);
			},
			onThemePreviewCancel: themeName => {
				restoredThemes.push(themeName);
			},
			onThemeCommit: async (path, themeName) => {
				committedThemes.push(themeName);
				settings.set(path, themeName);
				changedSettings.push({ path, value: themeName });
				return true;
			},
			onCancel: () => {},
			getStatusLinePreview: () => "status-preview",
		},
	);
	return { component, previewedThemes, restoredThemes, changedSettings, committedThemes };
}

describe("SettingsSelectorComponent theme selection", () => {
	it("previews a dark theme while browsing without persisting it", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu; lig-blue is preselected.
		component.handleInput("\x1b[B"); // Browse to lig-white.

		expect(previewedThemes).toEqual(["lig-white"]);
		expect(restoredThemes).toEqual([]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.dark")).toBe("lig-blue");
	});

	it("recolors the open Settings theme submenu while previewing", async () => {
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: THEMES,
				availableModelProfiles: [],
				cwd: process.cwd(),
			},
			{
				onChange: () => {},
				onThemePreview: themeName => previewTheme(themeName).then(() => {}),
				onThemePreviewCancel: themeName => restoreThemePreview(themeName).then(() => {}),
				onCancel: () => {},
				getStatusLinePreview: () => "status-preview",
			},
		);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		await Bun.sleep(1);

		const title = component.render(120).find(line => Bun.stripANSI(line).includes("Dark Theme"));
		expect(title).toContain(theme.getFgAnsi("accent"));
		// The previewed theme's accent, proving the preview actually took effect:
		// LIG Innovative Blue #002F6D.
		expect(theme.getFgAnsi("accent")).toBe("\u001b[38;2;0;47;109m");
		await restoreThemePreview("lig-blue");
	});

	it("restores the pre-preview rendered theme on cancel and leaves dark settings unchanged", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu; lig-blue is preselected.
		component.handleInput("\x1b[B"); // Browse to lig-white.
		component.handleInput("\x1b"); // Cancel submenu.

		expect(previewedThemes).toEqual(["lig-white"]);
		expect(restoredThemes).toEqual(["lig-blue"]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.dark")).toBe("lig-blue");
		expect(component.render(120).join("\n")).toContain("lig-blue");
	});

	it("persists and displays the selected dark theme only after confirmation", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu.
		component.handleInput("\x1b[B"); // Browse to lig-white.
		component.handleInput("\n"); // Confirm.

		expect(previewedThemes).toEqual(["lig-white"]);
		expect(restoredThemes).toEqual([]);
		expect(changedSettings).toEqual([{ path: "theme.dark", value: "lig-white" }]);
		expect(settings.get("theme.dark")).toBe("lig-white");
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("Dark Theme");
		expect(rendered).toContain("lig-white");
	});

	it("keeps the submenu and persisted mapping unchanged when theme confirmation fails", async () => {
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: THEMES,
				availableModelProfiles: [],
				cwd: process.cwd(),
			},
			{
				onChange: () => {
					throw new Error("generic change callback must not own theme persistence");
				},
				onThemePreview: () => {},
				onThemePreviewCancel: () => {},
				onThemeCommit: async () => false,
				onCancel: () => {},
			},
		);

		component.handleInput("\n");
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await Bun.sleep(1);

		expect(settings.get("theme.dark")).toBe("lig-blue");
		expect(component.render(120).join("\n")).toContain("Enter to select");
	});

	it("keeps light theme preview independent from persisted light settings", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\x1b[B"); // Move from Dark Theme to Light Theme.
		component.handleInput("\n"); // Open Light Theme submenu; lig-white is preselected.
		component.handleInput("\x1b[B"); // Wrap to lig-blue.
		component.handleInput("\x1b"); // Cancel.

		expect(previewedThemes).toEqual(["lig-blue"]);
		expect(restoredThemes).toEqual(["lig-blue"]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.light")).toBe("lig-white");

		component.handleInput("\n"); // Reopen Light Theme submenu.
		component.handleInput("\x1b[B"); // Wrap to lig-blue.
		component.handleInput("\n"); // Confirm.

		expect(previewedThemes).toEqual(["lig-blue", "lig-blue"]);
		expect(restoredThemes).toEqual(["lig-blue"]);
		expect(changedSettings).toEqual([{ path: "theme.light", value: "lig-blue" }]);
		expect(settings.get("theme.light")).toBe("lig-blue");
	});
});
