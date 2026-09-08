import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { getBundledModel, type Model } from "@vib-rato/ai";
import type { ModelProfileDefinition } from "@vib-rato/coding-agent/config/model-profiles";
import type { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import { Settings } from "@vib-rato/coding-agent/config/settings";
import { ModelSelectorComponent } from "@vib-rato/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@vib-rato/coding-agent/modes/theme/theme";
import type { TUI } from "@vib-rato/tui";

/**
 * A model held back by the registry has to say so in `/model`.
 *
 * Before this, the reason recorded for a token-limit hold was written and never
 * read outside tests: the held model looked exactly like every other row, the
 * user picked it, and the turn failed against the same spent allowance. These
 * tests pin the row annotation, the header marker, and the two properties that
 * make the wording usable behind the usage gateway — it counts down from the
 * recorded instant instead of repeating the wait the hold started with, and it
 * never names a day or a midnight the gateway's configurable window may not
 * have.
 */

const HOUR_MS = 3_600_000;

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/[ \t]+/g, " ")
		.trim();
}

const heldModel = getBundledModel("anthropic", "claude-sonnet-4-5");
const otherModel = getBundledModel("anthropic", "claude-haiku-4-5");
if (!heldModel || !otherModel) throw new Error("Expected bundled Anthropic test models");

const profile: ModelProfileDefinition = {
	name: "gateway-default",
	requiredProviders: ["anthropic"],
	modelMapping: { default: `anthropic/${heldModel.id}` },
	source: "builtin",
};

interface HoldFixture {
	/** Selectors the registry currently holds, with the instant each hold lifts. */
	holds: Map<string, { untilMs: number; reason?: string }>;
}

function createRegistry(fixture: HoldFixture, catalog: readonly Model[]): ModelRegistry {
	const profiles = new Map([[profile.name, profile]]);
	return {
		refresh: vi.fn(async () => {}),
		getError: () => undefined,
		getAll: () => [...catalog],
		getAvailable: () => [...catalog],
		hasConfiguredProviderAuth: () => true,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		getCanonicalModelSelections: () => [],
		resolveCanonicalModel: () => undefined,
		getModelProfiles: () => new Map(profiles),
		getModelProfile: (name: string) => profiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		getApiKeyForProvider: async () => "key",
		getApiKey: async () => "key",
		// The two read-only accessors the annotation is built from. Both report
		// nothing once the window has passed, which is what "expired renders
		// nothing" relies on.
		getSelectorSuppressionUntil: (selector: string) => {
			const hold = fixture.holds.get(selector);
			return hold && hold.untilMs > Date.now() ? hold.untilMs : undefined;
		},
		getSelectorSuppressionReason: (selector: string) => {
			const hold = fixture.holds.get(selector);
			return hold && hold.untilMs > Date.now() ? hold.reason : undefined;
		},
	} as unknown as ModelRegistry;
}

function createSelector(
	fixture: HoldFixture,
	options: { currentModel?: Model; presetLanding?: boolean; catalog?: readonly Model[] } = {},
): ModelSelectorComponent {
	installTestTheme();
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const catalog = options.catalog ?? [heldModel, otherModel];
	return new ModelSelectorComponent(
		ui,
		options.currentModel,
		Settings.isolated(),
		createRegistry(fixture, catalog),
		// A non-empty scoped list opens the model list; an empty one opens the
		// preset landing, which is where the "what am I running" header lives.
		options.presetLanding ? [] : catalog.map(model => ({ model })),
		() => {},
		() => {},
		{},
	);
}

let testTheme = await getThemeByName("lig-blue");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load the LIG theme for model selector tests");
	setThemeInstance(testTheme);
}

async function rendered(selector: ModelSelectorComponent): Promise<string> {
	await Bun.sleep(10);
	installTestTheme();
	return normalizeRenderedText(selector.render(80).join("\n"));
}

describe("ModelSelector quota-hold annotation", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("lig-blue");
		if (!testTheme) throw new Error("Failed to load the LIG theme for model selector tests");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("annotates a held model with its condition and the remaining wait", async () => {
		const fixture: HoldFixture = {
			holds: new Map([
				[`anthropic/${heldModel.id}`, { untilMs: Date.now() + 2.5 * HOUR_MS, reason: "token limit reached" }],
			]),
		};

		const output = await rendered(createSelector(fixture));

		expect(output).toContain("held · token limit reached · resets in 2h 30m");
		// The hold explains the row; it never removes it. A user binding a held
		// model to another role, or simply looking at what they picked yesterday,
		// must still find it in the list.
		expect(output).toContain(heldModel.id);
		expect(output).toContain(otherModel.id);
	});

	test("annotates only the held row, leaving the rest of the list alone", async () => {
		const fixture: HoldFixture = {
			holds: new Map([
				[`anthropic/${heldModel.id}`, { untilMs: Date.now() + 45 * 60_000, reason: "token limit reached" }],
			]),
		};

		const lines = (await rendered(createSelector(fixture))).split("\n");
		const annotated = lines.filter(line => line.includes("held ·"));

		expect(annotated).toHaveLength(1);
		expect(annotated[0]).toContain("resets in 45m");
		expect(lines.some(line => line.includes(otherModel.id) && line.includes("held"))).toBe(false);
	});

	test("renders nothing once the suppression window has passed", async () => {
		const fixture: HoldFixture = {
			holds: new Map([[`anthropic/${heldModel.id}`, { untilMs: Date.now() - 1, reason: "token limit reached" }]]),
		};

		const output = await rendered(createSelector(fixture));

		expect(output).not.toContain("held");
		expect(output).not.toContain("resets in");
		expect(output).toContain(heldModel.id);
	});

	test("renders nothing when no selector is held", async () => {
		const output = await rendered(createSelector({ holds: new Map() }));

		expect(output).not.toContain("held");
		expect(output).not.toContain("resets in");
	});

	test("stays window-neutral, naming no day and no midnight", async () => {
		// The gateway's quota window is operator-configured and its length is
		// never sent, so wording that implies a calendar day would be a guess.
		const fixture: HoldFixture = {
			holds: new Map([
				[`anthropic/${heldModel.id}`, { untilMs: Date.now() + 11 * HOUR_MS, reason: "token limit reached" }],
			]),
		};

		const selector = createSelector(fixture);
		const output = await rendered(selector);
		const annotation = output.split("\n").find(line => line.includes("held ·"));
		if (!annotation) throw new Error("Expected a hold annotation");

		expect(annotation).toContain("resets in 11h");
		expect(annotation).not.toMatch(/daily|today|tomorrow|midnight/i);
		// No machine timestamp on a row a person is reading.
		expect(annotation).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

		// Indent plus annotation has to survive the 80-column terminal the LIG
		// machines actually get, so measure the raw line rather than the
		// whitespace-collapsed one the other assertions read.
		installTestTheme();
		const rawAnnotation = selector
			.render(80)
			.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
			.find(line => line.includes("held ·"));
		if (!rawAnnotation) throw new Error("Expected a hold annotation in the raw render");
		expect(rawAnnotation.trimEnd().length).toBeLessThanOrEqual(80);
		expect(rawAnnotation.startsWith("    held")).toBe(true);
	});

	test("counts down instead of repeating the wait the hold started with", async () => {
		const base = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(base);
		const fixture: HoldFixture = {
			holds: new Map([
				[`anthropic/${heldModel.id}`, { untilMs: base + 2.5 * HOUR_MS, reason: "token limit reached" }],
			]),
		};

		const selector = createSelector(fixture);
		expect(await rendered(selector)).toContain("resets in 2h 30m");

		// An hour of work later, the same hold is redrawn by a keystroke in the
		// search box. The reason is stored once; the wait is not.
		clock.mockReturnValue(base + HOUR_MS);
		selector.handleInput("c");
		installTestTheme();
		const later = normalizeRenderedText(selector.render(80).join("\n"));

		expect(later).toContain("resets in 1h 30m");
		expect(later).not.toContain("2h 30m");
	});

	test("annotates a hold that carries no reason with just the wait", async () => {
		// Rate-limit suppression has always been reasonless. It still has an
		// instant, so the row can say when it comes back.
		const fixture: HoldFixture = {
			holds: new Map([[`anthropic/${heldModel.id}`, { untilMs: Date.now() + 5 * 60_000 }]]),
		};

		const output = await rendered(createSelector(fixture));

		expect(output).toContain("held · resets in 5m");
		expect(output).not.toContain("token limit");
	});

	test("marks the session's own model on the preset landing header", async () => {
		const fixture: HoldFixture = {
			holds: new Map([
				[`anthropic/${heldModel.id}`, { untilMs: Date.now() + 3 * HOUR_MS, reason: "token limit reached" }],
			]),
		};

		const output = await rendered(createSelector(fixture, { currentModel: heldModel, presetLanding: true }));
		const currentLine = output.split("\n").find(line => line.includes("Current:"));
		if (!currentLine) throw new Error("Expected the preset landing to state the current model");

		expect(currentLine).toContain("held · token limit reached · resets in 3h");
	});

	test("leaves the preset landing header unmarked when the model is free", async () => {
		const output = await rendered(
			createSelector({ holds: new Map() }, { currentModel: heldModel, presetLanding: true }),
		);
		const currentLine = output.split("\n").find(line => line.includes("Current:"));
		if (!currentLine) throw new Error("Expected the preset landing to state the current model");

		expect(currentLine).not.toContain("held");
	});
});
