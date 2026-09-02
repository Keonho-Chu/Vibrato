import type { CanonicalVibWorkflowSkill } from "../../skill-state/active-state";
import { CANONICAL_VIB_WORKFLOW_SKILLS } from "../../skill-state/active-state";

export const VIB_PLUGIN_MANIFEST_FILENAME = "vibrato-plugin.json";
export const VIB_PLUGIN_KIND = "vib-rato-plugin";

export const VIB_SUBSKILL_PARENT_SKILLS = CANONICAL_VIB_WORKFLOW_SKILLS;
export type VibSubskillParentSkill = CanonicalVibWorkflowSkill;

export const VIB_SUBSKILL_PARENT_AGENTS = ["executor", "architect", "planner", "critic"] as const;
export type VibSubskillParentAgent = (typeof VIB_SUBSKILL_PARENT_AGENTS)[number];

export type VibSubskillParent = VibSubskillParentSkill | VibSubskillParentAgent;

export const VIB_AGENT_SUBSKILL_PHASES: Record<VibSubskillParentAgent, string[]> = {
	executor: ["prompt"],
	architect: ["prompt"],
	planner: ["prompt"],
	critic: ["prompt"],
};

export interface VibPluginToolManifestEntry {
	name: string;
	path: string;
	description?: string;
	sha256?: string;
	/** Optional JSON Schema declaration for registry-v2 metadata. */
	schema?: unknown;
	/** Aliases accepted when migrating older manifests. */
	inputSchema?: unknown;
	input_schema?: unknown;
	parameters?: unknown;
	/** Optional sidecar JSON Schema file, resolved within the plugin root. */
	schemaPath?: string;
	schema_path?: string;
	/**
	 * "always-on" object entries are activated for the whole session; legacy
	 * string shorthand stays "subskill"-scoped and is only attached to subskill
	 * bindings (never registered as an always-on tool surface).
	 */
	surface: "subskill" | "always-on";
}

export interface VibPluginHookManifestEntry {
	name: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	path: string;
	sha256?: string;
}

export type VibPluginMcpTransport = "stdio" | "http" | "sse";

export interface VibPluginMcpManifestEntry {
	name: string;
	transport: VibPluginMcpTransport;
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	sha256?: string;
}

export interface VibPluginAppendixManifestEntry {
	name: string;
	path?: string;
	content?: string;
	sha256?: string;
}

export interface VibPluginAgentAppendixManifestEntry extends VibPluginAppendixManifestEntry {
	agent: VibSubskillParentAgent;
}

export interface VibPluginManifest {
	name: string;
	version: string;
	kind: "vib-rato-plugin";
	subskills: string[];
	tools: VibPluginToolManifestEntry[];
	hooks: VibPluginHookManifestEntry[];
	mcps: VibPluginMcpManifestEntry[];
	systemAppendix: VibPluginAppendixManifestEntry[];
	agentAppendix: VibPluginAgentAppendixManifestEntry[];
}

export interface SubskillFrontmatter {
	name: string;
	binds_to: string;
	phase: string;
	activation_arg: string;
	description: string;
}

export interface LoadedSubskillBinding {
	plugin: string;
	subskillName: string;
	parent: string;
	bindsTo: string;
	phase: string;
	activationArg: string;
	description: string;
	filePath: string;
	body: string;
	toolPaths: string[];
}

export interface NormalizedSubskillToolSurface {
	extensionId: string;
	relativePath: string;
	implementationHash: string;
}

export interface LoadedSubskillToolReference {
	extensionId: string;
	relativePath: string;
	expectedDigest: string;
}

export interface LoadedSubskillActivation {
	activationArg: string;
	plugin: string;
	subskillName: string;
	parent: string;
	bindsTo: string;
	phase: string;
	/** Registry identity for v2-only activation. */
	scope?: VibPluginScope;
	extensionId?: string;
	expectedDigest?: string;
	filePath: string;
	toolPaths: string[];
	toolRefs?: LoadedSubskillToolReference[];
}

export interface PhaseScopedToolBinding {
	plugin: string;
	parent: string;
	phase: string;
	toolPath: string;
}

export interface LoadedVibPlugin {
	name: string;
	version: string;
	root: string;
	manifestPath: string;
	bindings: LoadedSubskillBinding[];
	toolBindings: PhaseScopedToolBinding[];
}

export type VibPluginLoadErrorCode =
	// Parse-time
	| "forbidden_surface"
	| "invalid_manifest"
	| "invalid_kind"
	| "unsupported_surface"
	// Compile-time
	| "invalid_frontmatter"
	| "invalid_parent"
	| "invalid_phase"
	| "missing_file"
	| "hash_mismatch"
	| "invalid_schema"
	| "missing_surface"
	| "invalid_appendix"
	| "invalid_hook"
	| "invalid_mcp"
	// Install-time
	| "duplicate_arg"
	| "duplicate_parent_phase"
	| "duplicate_tool"
	| "duplicate_hook"
	| "duplicate_mcp"
	| "duplicate_appendix"
	| "security_policy"
	| "install_conflict"
	// Session-start / runtime
	| "session_collision"
	| "runtime_mismatch"
	| "quarantined_surface"
	| "migration_required";

export class VibPluginLoadError extends Error {
	readonly code: VibPluginLoadErrorCode;

	constructor(code: VibPluginLoadErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "VibPluginLoadError";
		this.code = code;
	}
}

/** Typed refusal raised when an implementation changed after v2 metadata was recorded. */
export class PluginImplementationHashMismatchError extends VibPluginLoadError {
	readonly expected: string;
	readonly actual: string;
	readonly path: string;

	constructor(path: string, expected: string, actual: string) {
		super("hash_mismatch", `Vibrato plugin implementation hash mismatch for ${path}`);
		this.name = "PluginImplementationHashMismatchError";
		this.path = path;
		this.expected = expected;
		this.actual = actual;
	}
}

/** Typed refusal for a registry entry that could not be migrated to v2 metadata. */
export class PluginMigrationRequiredError extends VibPluginLoadError {
	constructor(plugin: string, surface: string, cause: string) {
		super("migration_required", `Vibrato plugin "${plugin}" surface "${surface}" requires migration: ${cause}`);
		this.name = "PluginMigrationRequiredError";
	}
}

export type VibPluginScope = "user" | "project";

export type VibPluginSourceKind = "path" | "git" | "tarball";

export interface VibPluginCopiedFile {
	relativePath: string;
	sha256: string;
	bytes: number;
}

export interface NormalizedSubskillSurface {
	extensionId: string;
	name: string;
	description: string;
	parent: string;
	phase: string;
	activationArg: string;
	relativePath: string;
	sha256: string;
	toolRefs?: NormalizedSubskillToolSurface[];
}

export interface NormalizedToolSurface {
	extensionId: string;
	name: string;
	relativePath: string;
	sha256: string;
	description?: string;
	/** v2 metadata fields; optional only for in-memory legacy fixtures. */
	schema?: JsonSchema202012;
	schemaHash?: string;
	implementationHash?: string;
	presentationHash?: string;
	metadataVersion?: 2;
}

/** JSON Schema 2020-12 documents are kept as JSON values so migration never needs an implementation import. */
export type JsonSchema202012 = boolean | Record<string, unknown>;

/**
 * Registry-v2 tool metadata. The implementation and presentation hashes are
 * content digests, not executable metadata. `schema` is canonicalized before
 * `schemaHash` is computed.
 */
export interface NormalizedToolSurfaceV2 extends NormalizedToolSurface {
	schema: JsonSchema202012;
	schemaHash: string;
	implementationHash: string;
	presentationHash?: string;
	metadataVersion: 2;
}

export interface VibPluginMigrationFailure {
	code: VibPluginLoadErrorCode;
	surface: string;
	cause: string;
}

export interface VibPluginMigrationState {
	status: "migrated" | "failed";
	metadataVersion: 2;
	migratedAt?: string;
	failure?: VibPluginMigrationFailure;
}

export interface NormalizedHookSurface {
	extensionId: string;
	name: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	relativePath: string;
	sha256: string;
	implementationHash?: string;
}

export interface NormalizedMcpSurface {
	extensionId: string;
	name: string;
	transport: VibPluginMcpTransport;
	configHash: string;
	config: VibPluginMcpManifestEntry;
}

export interface NormalizedAppendixSurface {
	extensionId: string;
	name: string;
	relativePath?: string;
	/** Inline appendix body (when the manifest used `content` instead of `path`). */
	content?: string;
	contentHash: string;
	bytes: number;
}

export interface NormalizedAgentAppendixSurface extends NormalizedAppendixSurface {
	agent: VibSubskillParentAgent;
}

export interface NormalizedVibPluginSurfaces {
	subskills: NormalizedSubskillSurface[];
	tools: NormalizedToolSurface[];
	hooks: NormalizedHookSurface[];
	mcps: NormalizedMcpSurface[];
	systemAppendices: NormalizedAppendixSurface[];
	agentAppendices: NormalizedAgentAppendixSurface[];
}

/**
 * Result of the pure compile step. Computed from manifest, frontmatter, and
 * declared files read as bytes only — never by importing plugin code.
 */
export interface NormalizedVibPluginBundle {
	name: string;
	version: string;
	root: string;
	manifestPath: string;
	manifestHash: string;
	surfaces: NormalizedVibPluginSurfaces;
	files: VibPluginCopiedFile[];
}

export interface VibPluginQuarantineEntry {
	surfaceId: string;
	code: VibPluginLoadErrorCode;
	message: string;
	detectedAt: string;
}

export interface VibPluginRegistrySource {
	kind: VibPluginSourceKind;
	uri: string;
	ref?: string;
	sha?: string;
	resolvedAt: string;
}

export interface VibPluginRegistryEntry {
	name: string;
	version: string;
	scope: VibPluginScope;
	enabled: boolean;
	pluginRoot: string;
	manifestPath: string;
	manifestHash: string;
	source: VibPluginRegistrySource;
	installedAt: string;
	updatedAt: string;
	copiedFiles: VibPluginCopiedFile[];
	surfaces: NormalizedVibPluginSurfaces;
	disabledSurfaceIds: string[];
	quarantine?: VibPluginQuarantineEntry[];
	/** v2 metadata status; absent is accepted for in-memory legacy test fixtures. */
	migration?: VibPluginMigrationState;
}

export interface VibPluginRegistry {
	version: 1;
	scope: VibPluginScope;
	plugins: VibPluginRegistryEntry[];
}

/**
 * Stable identifiers for plugin-contributed surfaces used by observability,
 * disabledSurfaceIds, and quarantine bookkeeping.
 */
export type VibPluginSurfaceExtensionId = string;

/** Canonical Vibrato bundle identity: kind is fixed, target is (scope, name). */
export const VIB_BUNDLE_KIND = "vib-bundle";

export interface VibBundleIdentity {
	kind: typeof VIB_BUNDLE_KIND;
	scope: VibPluginScope;
	name: string;
}

/** Source descriptor exposed to CLI/Settings: never carries raw locator secrets. */
export interface VibBundleSafeSource {
	kind: VibPluginSourceKind;
	/** Redacted display locator (host + path only; no userinfo/query/fragment). */
	display: string;
	/** Conservative safe git ref, omitted when the stored value is unsafe. */
	ref?: string;
	/** Hex-only revision identifier, omitted when the stored value is unsafe. */
	sha?: string;
	resolvedAt: string;
	/** True when this source kind supports re-resolution during update. */
	updatable: boolean;
	/** Present only when updatable is false. */
	unsupportedReason?: string;
}

export interface VibBundleSurfaceSummary {
	extensionId: string;
	kind: "tool" | "hook" | "mcp" | "system-appendix" | "agent-appendix" | "subskill";
	name: string;
	/** Persisted user intent (registry disabledSurfaceIds). */
	enabled: boolean;
	/** Deterministic quarantine derived from persisted registry state only. */
	quarantined: boolean;
	quarantineCode?: VibPluginLoadErrorCode;
}

/** Installed-bundle DTO shared by CLI and Settings. Contains no raw locators. */
export interface VibBundleSummary {
	identity: VibBundleIdentity;
	version: string;
	description?: string;
	enabled: boolean;
	source: VibBundleSafeSource;
	installedAt: string;
	updatedAt: string;
	manifestHash: string;
	/** Deterministic fingerprint of the exact installed target. */
	targetFingerprint: string;
	surfaces: VibBundleSurfaceSummary[];
	/** True when any deterministic quarantine blocks enablement. */
	quarantined: boolean;
}

/**
 * Host-derived token binding an update preview to the exact candidate, the
 * exact installed baseline, and the deterministic decision context. Apply is a
 * compare-and-swap against all three fingerprints.
 */
export interface VibReviewedUpdateToken {
	identity: VibBundleIdentity;
	candidateFingerprint: string;
	baselineFingerprint: string;
	decisionContextFingerprint: string;
	reviewedAt: string;
}

export type VibLifecycleErrorCode =
	| "already_installed_use_upgrade"
	| "not_installed"
	| "registry_unreadable"
	| "identity_mismatch"
	| "stale_candidate"
	| "stale_baseline"
	| "stale_decision_context"
	| "source_unsupported"
	| "source_unavailable"
	| "quarantined"
	| "surface_unknown"
	| "invalid_target";

export interface VibLifecycleError {
	code: VibLifecycleErrorCode;
	/** Sanitized operator-facing message; never contains raw locators or causes. */
	message: string;
	/** Safe scoped recovery hint (e.g. the exact command to run instead). */
	recovery?: string;
}

export type VibLifecycleResult<T> = { ok: true; value: T } | { ok: false; error: VibLifecycleError };

export interface VibUpdatePreview {
	identity: VibBundleIdentity;
	current: VibBundleSummary;
	candidateVersion: string;
	candidateManifestHash: string;
	/** Surface IDs added, removed, or retained by this candidate. */
	addedSurfaceIds: string[];
	removedSurfaceIds: string[];
	retainedSurfaceIds: string[];
	changed: boolean;
	token: VibReviewedUpdateToken;
}

export type VibUpdateApplyStatus = "updated" | "unchanged";

export interface VibUpdateApplyResult {
	status: VibUpdateApplyStatus;
	summary: VibBundleSummary;
	/** Number of filesystem remnants that could not be removed after a successful swap. */
	remnantCount: number;
}

export interface VibInstallResult {
	status: "installed";
	summary: VibBundleSummary;
}

/** A resolved uninstall that was deliberately not performed. */
export interface VibUninstallPreview {
	status: "would-uninstall";
	identity: VibBundleIdentity;
	summary: VibBundleSummary;
}

export interface VibToggleResult {
	summary: VibBundleSummary;
	/** False when the requested state already matched (no persisted mutation). */
	mutated: boolean;
}

/**
 * Scope-qualified runtime evidence emitted by producers. Producers never
 * publish; the session coordinator accumulates one complete generation.
 */
export interface VibRuntimeFinding {
	identity: VibBundleIdentity;
	surfaceId: string;
	code: VibPluginLoadErrorCode;
	message: string;
}

export interface VibRuntimeSnapshot {
	/** Monotonic activation generation this snapshot describes. */
	generation: number;
	findings: VibRuntimeFinding[];
}

export type VibRuntimeSnapshotState = { status: "unavailable" } | { status: "current"; snapshot: VibRuntimeSnapshot };
