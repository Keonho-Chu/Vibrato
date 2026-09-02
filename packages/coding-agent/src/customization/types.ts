/**
 * Core types and scope resolution for the `/extensions` umbrella local
 * customization surface (issue #4291, parent #4283).
 *
 * `.vib` is the canonical persisted authority at two scopes:
 * - project-local: `<project>/.vib/`
 * - user-global:   `~/.vib/agent/`
 *
 * Claude Code and Codex layouts are import sources only — never a parallel
 * runtime authority. This module defines the narrow contract types the UI
 * and import flow consume without coupling to sibling ownership internals
 * or to the provider/extension-module ExtensionDashboard.
 */
import * as path from "node:path";
import { getAgentDir, getMCPConfigPath, getProjectAgentDir } from "@vib-rato/utils";
import type { MigrateSource } from "../migrate/types";
import type { MCPServerConfig } from "../runtime-mcp/types";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export type VibScope = "project" | "global";

export interface VibScopePaths {
	scope: VibScope;
	/** Root directory: `<project>/.vib` or `~/.vib/agent` */
	root: string;
	/** MCP config: `<root>/mcp.json` */
	mcpConfigPath: string;
	/** Skills directory: `<root>/skills/` */
	skillsDir: string;
	/** Hooks directory: `<root>/hooks/` */
	hooksDir: string;
}

export function resolveScopePaths(scope: VibScope, projectCwd: string): VibScopePaths {
	if (scope === "project") {
		const root = getProjectAgentDir(projectCwd);
		return {
			scope,
			root,
			mcpConfigPath: getMCPConfigPath("project", projectCwd),
			skillsDir: path.join(root, "skills"),
			hooksDir: path.join(root, "hooks"),
		};
	}
	const root = getAgentDir();
	return {
		scope,
		root,
		mcpConfigPath: getMCPConfigPath("user", projectCwd),
		skillsDir: path.join(root, "skills"),
		hooksDir: path.join(root, "hooks"),
	};
}

export function scopeLabel(scope: VibScope): string {
	return scope === "project" ? "Project .vib" : "Global .vib";
}

// ---------------------------------------------------------------------------
// Customization surfaces
// ---------------------------------------------------------------------------

export type CustomizationSurface = "skills" | "hooks" | "mcps";

export const CUSTOMIZATION_SURFACES: readonly CustomizationSurface[] = ["skills", "hooks", "mcps"];

export function surfaceLabel(surface: CustomizationSurface): string {
	switch (surface) {
		case "skills":
			return "Skills";
		case "hooks":
			return "Hooks";
		case "mcps":
			return "MCPs";
	}
}

// ---------------------------------------------------------------------------
// Import source
// ---------------------------------------------------------------------------

export type ImportProduct = Exclude<MigrateSource, "opencode">;
export type ImportSourceScope = "project" | "user";

export const IMPORT_PRODUCTS: readonly ImportProduct[] = ["claude-code", "codex"];
export const IMPORT_SOURCE_SCOPES: readonly ImportSourceScope[] = ["project", "user"];

export function productLabel(product: ImportProduct): string {
	switch (product) {
		case "claude-code":
			return "Claude Code";
		case "codex":
			return "Codex";
	}
}

export function sourceScopeLabel(scope: ImportSourceScope): string {
	return scope === "project" ? "Project-local" : "User-global";
}

export function sourceConfigDir(
	product: ImportProduct,
	sourceScope: ImportSourceScope,
	projectCwd: string,
	homeDir: string,
): string {
	if (product === "claude-code") {
		return sourceScope === "project" ? path.join(projectCwd, ".claude") : path.join(homeDir, ".claude");
	}
	return sourceScope === "project" ? path.join(projectCwd, ".codex") : path.join(homeDir, ".codex");
}

// ---------------------------------------------------------------------------
// Inventory row — provenance/status model for the dashboard
// ---------------------------------------------------------------------------

export type InventoryStatus =
	| "enabled"
	| "disabled"
	| "invalid"
	| "shadowed"
	| "quarantined"
	| "imported"
	| "restart-required";

export interface InventoryRow {
	/** Stable row identity: `<surface>:<scope>:<path>` */
	id: string;
	/** Surface kind */
	surface: CustomizationSurface;
	/** Entry name */
	name: string;
	/** Display name */
	displayName: string;
	/** Effective status */
	status: InventoryStatus;
	/** Provenance — which scope/convention discovered it */
	provenance: string;
	/** Absolute discovered path — the exact identity mutations act on */
	path: string;
	/** Scope that persists this row (project `.vib` or global `.vib`) */
	scope: VibScope;
	/** Short description (no secrets) */
	description?: string;
	/** Diagnostics/remediation detail for invalid/conflicted rows */
	diagnostics?: string[];
	/** Redacted inspector payload (never contains secret values) */
	raw: unknown;
}

// ---------------------------------------------------------------------------
// Normalized import preview
// ---------------------------------------------------------------------------

export type ImportCollisionPolicy = "skip" | "rename" | "overwrite";

export type ImportEntryStatus = "add" | "conflict" | "unsupported" | "redacted" | "overwrite";

export interface ImportPreviewEntry {
	surface: CustomizationSurface;
	/** Source name in the foreign layout */
	sourceName: string;
	/** Destination name in `.vib` (may differ under rename policy) */
	destinationName: string;
	status: ImportEntryStatus;
	/** Source path category (file, section, etc.) */
	sourceCategory: string;
	/** Redacted description for the preview UI */
	description: string;
	/** Reason for conflict/unsupported/redaction if applicable */
	reason?: string;
}

export interface NormalizedPayload {
	mcp?: { name: string; config: MCPServerConfig };
	skill?: { slug: string; content: string };
	hook?: { phase: "pre" | "post"; fileName: string; content: string };
}

export interface ImportPreview {
	product: ImportProduct;
	sourceScope: ImportSourceScope;
	destinationScope: VibScope;
	surfaces: CustomizationSurface[];
	entries: ImportPreviewEntry[];
	/** Aggregate warnings across all entries */
	warnings: string[];
}

/**
 * Validated apply plan produced alongside the redacted preview. `payloads` is
 * parallel to `preview.entries` (undefined for entries that carry no write).
 * It is deliberately separate from the preview DTO: the preview is safe to
 * serialize and display, while the plan holds full file contents and MCP
 * secret values and is only consumed by the apply transaction.
 */
export interface ImportPlan {
	preview: ImportPreview;
	payloads: readonly (NormalizedPayload | undefined)[];
}

// ---------------------------------------------------------------------------
// Import result
// ---------------------------------------------------------------------------

export type ImportOutcome = "imported" | "skipped" | "renamed" | "overwritten" | "failed";

export interface ImportResultEntry {
	surface: CustomizationSurface;
	sourceName: string;
	destinationName: string;
	outcome: ImportOutcome;
	reason?: string;
}

export interface ImportResult {
	entries: ImportResultEntry[];
	/** True if all entries succeeded (imported/skipped/renamed/overwritten) */
	ok: boolean;
}
