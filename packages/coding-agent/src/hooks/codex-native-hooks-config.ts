import * as os from "node:os";
import * as path from "node:path";

export const VIB_MANAGED_CODEX_HOOK_EVENTS = ["UserPromptSubmit", "Stop"] as const;

export type VibManagedCodexHookEvent = (typeof VIB_MANAGED_CODEX_HOOK_EVENTS)[number];

type JsonObject = Record<string, unknown>;

export interface CodexCommandHook {
	type: "command";
	command: string;
	statusMessage?: string;
	timeout?: number;
}

export interface CodexHookEntry {
	hooks: CodexCommandHook[];
}

export interface VibManagedCodexHooksConfig {
	hooks: Record<VibManagedCodexHookEvent, CodexHookEntry[]>;
}

export interface MergeVibManagedCodexHooksResult {
	content: string;
	changed: boolean;
	managedHookCount: number;
}

export interface VibCodexHooksStatus {
	hooksPath: string;
	installed: boolean;
	missingEvents: VibManagedCodexHookEvent[];
	managedHookCount: number;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHooksRoot(parsed: unknown): JsonObject {
	if (!isJsonObject(parsed)) return {};
	return structuredClone(parsed);
}

function normalizeHooksMap(root: JsonObject): Record<string, unknown> {
	if (isJsonObject(root.hooks)) return root.hooks;
	const hooks: Record<string, unknown> = {};
	root.hooks = hooks;
	return hooks;
}

function commandIsVibManaged(value: unknown): boolean {
	if (typeof value !== "string") return false;
	return /\bvib(?:\.exe)?\b/.test(value) && /\bcodex-native-hook\b/.test(value);
}

function entryContainsVibManagedHook(value: unknown): boolean {
	if (!isJsonObject(value) || !Array.isArray(value.hooks)) return false;
	return value.hooks.some(hook => isJsonObject(hook) && commandIsVibManaged(hook.command));
}

function managedCommand(): string {
	return "vib codex-native-hook";
}

function managedEntry(event: VibManagedCodexHookEvent): CodexHookEntry {
	const hook: CodexCommandHook = {
		type: "command",
		command: managedCommand(),
		statusMessage: "Vibrato skill state",
		...(event === "Stop" ? { timeout: 30 } : {}),
	};
	return { hooks: [hook] };
}

export function buildVibManagedCodexHooksConfig(): VibManagedCodexHooksConfig {
	return {
		hooks: {
			UserPromptSubmit: [managedEntry("UserPromptSubmit")],
			Stop: [managedEntry("Stop")],
		},
	};
}

export function getDefaultCodexHooksPath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".codex", "hooks.json");
}

export function mergeVibManagedCodexHooksConfig(existingContent: string | null): MergeVibManagedCodexHooksResult {
	let root = normalizeHooksRoot(null);
	if (existingContent?.trim()) {
		try {
			root = normalizeHooksRoot(JSON.parse(existingContent) as unknown);
		} catch {
			root = normalizeHooksRoot(null);
		}
	}

	const hooks = normalizeHooksMap(root);
	const managed = buildVibManagedCodexHooksConfig();
	let managedHookCount = 0;

	for (const event of VIB_MANAGED_CODEX_HOOK_EVENTS) {
		const existingEntries = Array.isArray(hooks[event]) ? hooks[event] : [];
		const userEntries = existingEntries.filter(entry => !entryContainsVibManagedHook(entry));
		const nextEntries = [...managed.hooks[event], ...userEntries];
		managedHookCount += managed.hooks[event].length;
		hooks[event] = nextEntries;
	}

	const content = `${JSON.stringify(root, null, 2)}\n`;
	return { content, changed: content !== (existingContent ?? ""), managedHookCount };
}

export function readVibManagedCodexHooksStatus(content: string | null, hooksPath: string): VibCodexHooksStatus {
	const missingEvents: VibManagedCodexHookEvent[] = [];
	let managedHookCount = 0;
	let hooks: Record<string, unknown> = {};
	if (content?.trim()) {
		try {
			const root = normalizeHooksRoot(JSON.parse(content) as unknown);
			hooks = isJsonObject(root.hooks) ? root.hooks : {};
		} catch {
			hooks = {};
		}
	}

	for (const event of VIB_MANAGED_CODEX_HOOK_EVENTS) {
		const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
		const eventManagedCount = entries.filter(entryContainsVibManagedHook).length;
		managedHookCount += eventManagedCount;
		if (eventManagedCount === 0) missingEvents.push(event);
	}

	return {
		hooksPath,
		installed: missingEvents.length === 0,
		missingEvents,
		managedHookCount,
	};
}
