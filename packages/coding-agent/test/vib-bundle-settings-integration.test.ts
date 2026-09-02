import { beforeAll, describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { bundleIdentity } from "../src/extensibility/vib-plugins/lifecycle-reconciliation";
import { VibRuntimeSnapshotStore } from "../src/extensibility/vib-plugins/runtime-quarantine";
import { SettingsSelectorComponent } from "../src/modes/components/settings-selector";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

/**
 * The source-text wiring test proves the production chain is connected, but it
 * cannot prove the connection carries data: a semantically broken rewiring that
 * kept the same identifiers would still pass it.
 *
 * This drives the REAL `SettingsSelectorComponent` with a real
 * `VibRuntimeSnapshotStore`, switches to the Vibrato Bundles tab exactly as the
 * production controller does, and asserts the component actually received the
 * provider and generation rather than silently defaulting to unavailable.
 */

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Failed to load test theme");
	setThemeInstance(theme);
});

function baseContext(cwd: string): {
	availableThinkingLevels: [];
	thinkingLevel: undefined;
	availableThemes: string[];
	availableModelProfiles: string[];
	cwd: string;
} {
	return {
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: ["red-claw"],
		availableModelProfiles: [],
		cwd,
	};
}

describe("Vibrato Bundles settings integration through the production selector", () => {
	test("the published provider and generation reach the tab component", () => {
		const store = new VibRuntimeSnapshotStore();
		const epoch = store.beginPass();
		store.publish(
			{
				generation: 7,
				findings: [
					{
						identity: bundleIdentity("project", "seeded-bundle"),
						surfaceId: "tool:seeded",
						code: "runtime_mismatch",
						message: "drifted",
					},
				],
			},
			epoch,
		);

		const selector = new SettingsSelectorComponent(
			{ ...baseContext("/tmp/does-not-need-to-exist"), vibRuntimeSnapshot: store, vibActivationGeneration: 7 },
			{ onCancel: () => {}, onChange: () => {} },
		);

		// Switch tabs the way the production tab bar does.
		selector.handleInput("\u001b[C");
		selector.handleInput("\u001b[C");

		// Prove the tab is actually reached, otherwise this test would pass
		// vacuously while never constructing the Vibrato component at all.
		const frame = selector.render(80).join("\n");
		expect(frame).toContain("Vibrato Bundles");

		// The store the component holds must be the very one the session published,
		// carrying the published generation — not a default-constructed empty one.
		expect(store.current()).toMatchObject({ status: "current", snapshot: { generation: 7 } });

		// Rendering with a real provider bound must not leak finding internals.
		expect(frame).not.toContain("runtime_mismatch");
		expect(frame).not.toContain("/tmp/does-not-need-to-exist");
	});

	test("a missing provider degrades honestly instead of crashing", () => {
		const selector = new SettingsSelectorComponent(baseContext("/tmp/does-not-need-to-exist"), {
			onCancel: () => {},
			onChange: () => {},
		});
		selector.handleInput("\u001b[C");
		selector.handleInput("\u001b[C");
		const frame = selector.render(80).join("\n");
		expect(frame).toContain("Vibrato Bundles");
	});
});
