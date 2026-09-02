import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@vib-rato/utils";
import { BUNDLED_VIB_SKILL_CATALOG, type BundledVibSkillCatalogEntry } from "./vib-skills.generated";

export const DEFAULT_VIB_DEFINITION_NAMES = ["autoresearch", "deep-interview", "ralplan", "ultragoal"] as const;
export type DefaultVibDefinitionName = (typeof DEFAULT_VIB_DEFINITION_NAMES)[number];
export type DefaultVibDefinitionKind = "skill" | "skill-fragment";
export type EmbeddedDefaultVibSkill = {
	name: DefaultVibDefinitionName;
	description: string;
	filePath: string;
	baseDir: string;
	source: "bundled:default";
	hide?: boolean;
	/** Content is loaded on demand to keep startup free of bundled Markdown bodies. */
	content: string;
	loadContent: () => Promise<string>;
};
export type DefaultVibInstallStatus = "different" | "matching" | "missing" | "skipped" | "written";

export interface DefaultVibSkillDefinition {
	kind: "skill";
	name: DefaultVibDefinitionName;
	relativePath: string;
	content: string;
	loadContent: () => Promise<string>;
}

export interface DefaultVibSkillFragmentDefinition {
	kind: "skill-fragment";
	parentSkillName: DefaultVibDefinitionName;
	relativePath: string;
	content: string;
	loadContent: () => Promise<string>;
}

export type DefaultVibDefinition = DefaultVibSkillDefinition | DefaultVibSkillFragmentDefinition;

export interface InstallDefaultVibDefinitionsOptions {
	check?: boolean;
	force?: boolean;
	/**
	 * Only rewrite default definition files that already exist on disk but whose
	 * content differs from the embedded defaults. Files that are absent are left
	 * absent (status "missing"). Used by `vib update` to refresh opted-in copies
	 * without materializing new on-disk copies for users who never installed them.
	 */
	refreshOnly?: boolean;
	targetRoot?: string;
}

export type DefaultVibDefinitionInstallFile =
	| {
			kind: "skill";
			name: DefaultVibDefinitionName;
			path: string;
			status: DefaultVibInstallStatus;
	  }
	| {
			kind: "skill-fragment";
			parentSkillName: DefaultVibDefinitionName;
			path: string;
			status: DefaultVibInstallStatus;
	  };

/**
 * Bundled workflow definitions that Vibrato used to ship and no longer does.
 *
 * Installing defaults only ever wrote the CURRENT set, so a definition dropped
 * from the bundle stayed on disk under the agent dir forever — where
 * filesystem skill discovery still found it and `/skill:<name>` still resolved.
 * `team` was the first removal, so it was the first to expose that gap.
 *
 * Retirement QUARANTINES rather than deletes: the directory is moved aside to
 * `<targetRoot>/retired/<name>.<timestamp>/`. A user who customized the skill
 * keeps their content, and nothing is destroyed to satisfy a rename.
 */
export const RETIRED_VIB_DEFINITION_NAMES = ["team"] as const;
export type RetiredVibDefinitionName = (typeof RETIRED_VIB_DEFINITION_NAMES)[number];

export type RetiredVibDefinitionStatus = "absent" | "quarantined";

export interface RetiredVibDefinitionFile {
	name: RetiredVibDefinitionName;
	/** Directory that held the retired definition. */
	path: string;
	/** Where it was moved, when quarantined. */
	quarantinedTo?: string;
	status: RetiredVibDefinitionStatus;
}

export interface DefaultVibDefinitionInstallResult {
	targetRoot: string;
	total: number;
	written: number;
	skipped: number;
	matching: number;
	missing: number;
	different: number;
	files: DefaultVibDefinitionInstallFile[];
	/** Retired bundled definitions found under `targetRoot`, and what happened to them. */
	retired: RetiredVibDefinitionFile[];
}
function sourcePathForBundledEntry(entry: BundledVibSkillCatalogEntry): string {
	const relative = entry.kind === "skill" ? entry.relativePath : entry.relativePath.replace(/^skill-fragments\//, "");
	return entry.kind === "skill"
		? path.join(import.meta.dir, "vib", relative)
		: path.join(import.meta.dir, "vib", "skills", relative);
}

export class BundledDefaultContentError extends Error {
	readonly code = "BUNDLED_DEFAULT_CONTENT_UNREADABLE";
	constructor(
		message: string,
		readonly sourcePath: string,
		readonly cause: unknown,
	) {
		super(message, { cause });
		this.name = "BundledDefaultContentError";
	}
}

export function readBundledContentSync(entry: BundledVibSkillCatalogEntry): string {
	const sourcePath = sourcePathForBundledEntry(entry);
	try {
		return readFileSync(sourcePath, "utf8");
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new BundledDefaultContentError(
			`Unable to read bundled Vibrato definition ${sourcePath}: ${detail}`,
			sourcePath,
			cause,
		);
	}
}

function withLazyBundledContent<T extends object>(
	value: T,
	entry: BundledVibSkillCatalogEntry,
): T & { content: string } {
	Object.defineProperty(value, "content", {
		enumerable: true,
		configurable: false,
		get: () => readBundledContentSync(entry),
	});
	return value as T & { content: string };
}

function asDefaultDefinition(entry: BundledVibSkillCatalogEntry): DefaultVibDefinition {
	if (entry.kind === "skill") {
		if (!entry.name) throw new Error(`Bundled skill catalog entry is missing name: ${entry.relativePath}`);
		return withLazyBundledContent(
			{
				kind: "skill",
				name: entry.name as DefaultVibDefinitionName,
				relativePath: entry.relativePath,
				loadContent: entry.loadContent,
			},
			entry,
		);
	}
	if (!entry.parentSkillName)
		throw new Error(`Bundled skill fragment catalog entry is missing parent: ${entry.relativePath}`);
	return withLazyBundledContent(
		{
			kind: "skill-fragment",
			parentSkillName: entry.parentSkillName as DefaultVibDefinitionName,
			relativePath: entry.relativePath,
			loadContent: entry.loadContent,
		},
		entry,
	);
}

const DEFAULT_VIB_DEFINITIONS: readonly DefaultVibDefinition[] = BUNDLED_VIB_SKILL_CATALOG.map(asDefaultDefinition);

export function getDefaultVibDefinitions(): readonly DefaultVibDefinition[] {
	return DEFAULT_VIB_DEFINITIONS;
}

export function getDefaultVibAgentDefinitions(): readonly DefaultVibDefinition[] {
	return [];
}

export function getEmbeddedDefaultVibSkillFragments(
	parentSkillName: DefaultVibDefinitionName,
): DefaultVibSkillFragmentDefinition[] {
	return DEFAULT_VIB_DEFINITIONS.filter(
		(definition): definition is DefaultVibSkillFragmentDefinition =>
			definition.kind === "skill-fragment" && definition.parentSkillName === parentSkillName,
	);
}

export function getEmbeddedDefaultVibSkills(): EmbeddedDefaultVibSkill[] {
	return DEFAULT_VIB_DEFINITIONS.filter(
		(definition): definition is DefaultVibSkillDefinition => definition.kind === "skill",
	).map(definition => {
		const catalogEntry = BUNDLED_VIB_SKILL_CATALOG.find(
			entry => entry.kind === "skill" && entry.name === definition.name,
		);
		if (!catalogEntry) {
			throw new Error(`Bundled Vibrato skill catalog invariant violated for "${definition.name}"`);
		}
		const description = catalogEntry.description ?? `Vibrato ${definition.name} workflow`;
		return withLazyBundledContent(
			{
				name: definition.name,
				description,
				filePath: `embedded:vib/${definition.relativePath}`,
				baseDir: `embedded:vib/skills/${definition.name}`,
				source: "bundled:default",
				loadContent: definition.loadContent,
			},
			catalogEntry,
		);
	});
}

export async function installDefaultVibDefinitions(
	options: InstallDefaultVibDefinitionsOptions = {},
): Promise<DefaultVibDefinitionInstallResult> {
	const targetRoot = options.targetRoot ?? getAgentDir();
	const files: DefaultVibDefinitionInstallFile[] = [];

	for (const definition of DEFAULT_VIB_DEFINITIONS) {
		const content = await definition.loadContent();
		const destination = path.join(targetRoot, definition.relativePath);
		const existing = await readExistingText(destination);
		let status: DefaultVibInstallStatus;

		if (options.check) {
			status = existing === undefined ? "missing" : existing === content ? "matching" : "different";
		} else if (options.refreshOnly) {
			if (existing === undefined) {
				status = "missing";
			} else if (existing === content) {
				status = "matching";
			} else {
				await Bun.write(destination, content);
				status = "written";
			}
		} else if (existing !== undefined && !options.force) {
			status = "skipped";
		} else {
			await Bun.write(destination, content);
			status = "written";
		}

		if (definition.kind === "skill") {
			files.push({
				kind: definition.kind,
				name: definition.name,
				path: destination,
				status,
			});
		} else {
			files.push({
				kind: definition.kind,
				parentSkillName: definition.parentSkillName,
				path: destination,
				status,
			});
		}
	}

	const retired = await retireRemovedVibDefinitions(targetRoot, { check: options.check === true });
	return summarizeInstallResult(targetRoot, files, retired);
}

/**
 * Quarantine any retired bundled definition still present under `targetRoot`.
 *
 * `check` reports what WOULD move without touching the filesystem, so
 * `--check` callers stay read-only.
 */
export async function retireRemovedVibDefinitions(
	targetRoot: string,
	options: { check?: boolean } = {},
): Promise<RetiredVibDefinitionFile[]> {
	const results: RetiredVibDefinitionFile[] = [];
	for (const name of RETIRED_VIB_DEFINITION_NAMES) {
		const directory = path.join(targetRoot, "skills", name);
		if (!(await directoryExists(directory))) {
			results.push({ name, path: directory, status: "absent" });
			continue;
		}
		if (options.check) {
			results.push({ name, path: directory, status: "quarantined" });
			continue;
		}
		const quarantinedTo = await reserveQuarantinePath(path.join(targetRoot, "retired"), name);
		await fs.rename(directory, quarantinedTo);
		results.push({ name, path: directory, quarantinedTo, status: "quarantined" });
	}
	return results;
}

/**
 * Reserve a unique quarantine directory.
 *
 * A timestamp alone is not enough: two retirements inside the same millisecond
 * resolve to the same path, which would silently overwrite the earlier
 * quarantine. Disambiguate with a counter until an unused path is found.
 */
async function reserveQuarantinePath(retiredRoot: string, name: string): Promise<string> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	await fs.mkdir(retiredRoot, { recursive: true });
	const base = path.join(retiredRoot, `${name}.${stamp}`);
	if (!(await directoryExists(base))) return base;
	for (let attempt = 2; ; attempt += 1) {
		const candidate = `${base}-${attempt}`;
		if (!(await directoryExists(candidate))) return candidate;
	}
}

async function directoryExists(candidate: string): Promise<boolean> {
	try {
		return (await fs.stat(candidate)).isDirectory();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readExistingText(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function summarizeInstallResult(
	targetRoot: string,
	files: DefaultVibDefinitionInstallFile[],
	retired: RetiredVibDefinitionFile[],
): DefaultVibDefinitionInstallResult {
	return {
		targetRoot,
		total: files.length,
		written: countStatus(files, "written"),
		skipped: countStatus(files, "skipped"),
		matching: countStatus(files, "matching"),
		missing: countStatus(files, "missing"),
		different: countStatus(files, "different"),
		files,
		retired,
	};
}

function countStatus(files: readonly DefaultVibDefinitionInstallFile[], status: DefaultVibInstallStatus): number {
	return files.filter(file => file.status === status).length;
}
