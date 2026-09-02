import { type Component, padding, truncateToWidth, visibleWidth } from "@vib-rato/tui";
import { APP_NAME, getProjectDir } from "@vib-rato/utils";
import { formatBuildLabel } from "../../build-metadata";
import { formatKeyHint, type KeyDisplayContext } from "../../config/keybindings";
import { theme } from "../../modes/theme/theme";
import { shortenPath } from "../../tools/render-utils";

export interface LspServerInfo {
	name: string;
	status: "idle" | "ready" | "error" | "connecting";
	fileTypes: string[];
}

export interface WelcomeComponentOptions {
	getViewportRows?: () => number | undefined;
	getReservedBottomRows?: (termWidth: number) => number;
	rightGutterWidth?: number;
	buildLabel?: string;
	keyDisplayContext?: KeyDisplayContext;
	/** Workspace directory to label. Defaults to the resolved project directory. */
	cwd?: string;
}

/**
 * Brand rule (U+258C). Rendered through `theme.fg("accent", …)` so it resolves
 * per theme: LIG Innovative Blue on light grounds, the accent tint on dark.
 */
const BRAND_RULE = "▌";

/** Identity line under the wordmark. */
const BRAND_IDENTITY = "Vibrato · LIG System";

/** Minimum gap between a row's left content and its right-aligned value. */
const RIGHT_VALUE_GAP = 2;

/** Gap between key-hint entries. */
const KEY_HINT_GAP = "    ";

/** Narrowest workspace label worth right-aligning; below this it is dropped. */
const MIN_WORKSPACE_WIDTH = 8;

/** The four affordances worth naming on the launch surface. */
const KEY_HINTS: ReadonlyArray<{ key: string; label: string }> = [
	{ key: "/", label: "commands" },
	{ key: "#", label: "actions" },
	{ key: "!", label: "shell" },
	{ key: "?", label: "keymap" },
];

/**
 * Minimal launch surface: a brand rule, the `vib` wordmark, and the model and
 * workspace the session is pointed at. No border, no columns, no animation.
 *
 * The mark is plain bold text on purpose. The LIG corporate identity guide
 * forbids redrawing the wordmark in any other form, so block-letter art is not
 * an option here; the brand is carried by the accent rule and the theme.
 */
export class WelcomeComponent implements Component {
	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private lspServers: LspServerInfo[] = [],
		private readonly options: WelcomeComponentOptions = {},
	) {}

	invalidate(): void {}

	/**
	 * The surface is static, so there is no intro to play: render once and start
	 * no timer. Kept as the entry point callers already use.
	 */
	playIntro(requestRender: () => void): void {
		requestRender();
	}

	dispose(): void {}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	render(termWidth: number): string[] {
		// The gutter is reserved by shrinking the drawable width, so right-aligned
		// values stop short of the composer's rail instead of overprinting it.
		const width = Math.max(0, termWidth - this.#rightGutterWidth(termWidth));
		if (width < 4) return [];

		const targetRows = this.#targetRows(termWidth);
		if (targetRows !== undefined && targetRows <= 0) return [];

		return this.#rows(width, targetRows ?? Number.POSITIVE_INFINITY);
	}

	#rows(width: number, budget: number): string[] {
		const rule = theme.fg("accent", BRAND_RULE);
		const brandRow = this.#alignRow(`${rule} ${theme.bold(APP_NAME)}`, this.#versionValue(), width);
		const identityRow = this.#clip(`${rule} ${theme.fg("muted", BRAND_IDENTITY)}`, width);
		const modelRow = this.#modelRow(width);

		if (budget < 2) return [brandRow];
		if (budget < 3) return [brandRow, modelRow];

		const lspRow = this.#clip(`  ${theme.fg("dim", this.#lspLabel())}`, width);
		const keysRow = this.#clip(`  ${this.#keyHints(Math.max(1, width - 2))}`, width);

		if (budget < 4) return [brandRow, identityRow, modelRow];
		if (budget < 5) return [brandRow, identityRow, modelRow, keysRow];
		if (budget < 6) return [brandRow, identityRow, modelRow, lspRow, keysRow];
		if (budget < 7) return [brandRow, identityRow, "", modelRow, lspRow, keysRow];
		return [brandRow, identityRow, "", modelRow, lspRow, "", keysRow];
	}

	#modelRow(width: number): string {
		const left = `  ${theme.fg("muted", this.modelName)} ${theme.fg("dim", `· ${this.providerName}`)}`;
		const workspaceBudget = width - visibleWidth(left) - RIGHT_VALUE_GAP;
		const workspace = workspaceBudget >= MIN_WORKSPACE_WIDTH ? this.#workspaceLabel(workspaceBudget) : "";
		return this.#alignRow(left, workspace ? theme.fg("dim", workspace) : "", width);
	}

	/** Right-align `right` at `width`, dropping it whole rather than wrapping. */
	#alignRow(left: string, right: string, width: number): string {
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		if (right === "" || leftWidth + RIGHT_VALUE_GAP + rightWidth > width) {
			return this.#clip(left, width);
		}
		return left + padding(width - leftWidth - rightWidth) + right;
	}

	#clip(text: string, width: number): string {
		return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
	}

	#versionValue(): string {
		const buildLabel = this.options.buildLabel ?? formatBuildLabel();
		return theme.fg("dim", buildLabel ? `${this.version} · ${buildLabel}` : this.version);
	}

	#lspLabel(): string {
		const count = this.lspServers.length;
		if (count === 0) return "No LSP servers";
		return `${count} LSP server${count === 1 ? "" : "s"}`;
	}

	#keyHints(width: number): string {
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		const entries = KEY_HINTS.map(
			hint => `${theme.fg("dim", formatKeyHint(hint.key, context))}  ${theme.fg("muted", hint.label)}`,
		);
		let kept = entries.length;
		while (kept > 1 && visibleWidth(entries.slice(0, kept).join(KEY_HINT_GAP)) > width) kept -= 1;
		return entries.slice(0, kept).join(KEY_HINT_GAP);
	}

	/** `~`-shortened workspace path, middle-elided to fit `maxWidth`. */
	#workspaceLabel(maxWidth: number): string {
		const short = shortenPath(this.options.cwd ?? getProjectDir());
		if (visibleWidth(short) <= maxWidth) return short;

		const parts = short.split(/[/\\]/);
		const separator = short.includes("\\") && !short.includes("/") ? "\\" : "/";
		const last = parts[parts.length - 1] ?? short;
		if (parts.length > 2) {
			const elided = `${parts[0]}${separator}…${separator}${last}`;
			if (visibleWidth(elided) <= maxWidth) return elided;
		}
		return visibleWidth(last) <= maxWidth ? last : "";
	}

	#rightGutterWidth(termWidth: number): number {
		const configured = this.options.rightGutterWidth ?? 0;
		if (!Number.isFinite(configured) || configured <= 0) return 0;
		return Math.min(Math.floor(configured), Math.max(0, termWidth - 4));
	}

	#targetRows(termWidth: number): number | undefined {
		const viewportRows = this.options.getViewportRows?.();
		if (typeof viewportRows !== "number" || !Number.isFinite(viewportRows) || viewportRows <= 0) {
			return undefined;
		}
		const reservedRows = Math.max(0, Math.floor(this.options.getReservedBottomRows?.(termWidth) ?? 0));
		return Math.max(0, Math.floor(viewportRows) - reservedRows);
	}
}
