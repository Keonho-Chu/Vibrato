import { type Component, padding, TERMINAL, truncateToWidth, visibleWidth } from "@vib-rato/tui";
import { APP_NAME, getProjectDir } from "@vib-rato/utils";
import { formatBuildLabel } from "../../build-metadata";
import { formatKeyHint, type KeyDisplayContext } from "../../config/keybindings";
import { getCurrentThemeName, isLightTheme, theme } from "../../modes/theme/theme";
import { shortenPath } from "../../tools/render-utils";

export interface LspServerInfo {
	name: string;
	status: "idle" | "ready" | "error" | "connecting";
	fileTypes: string[];
}

export type WelcomeLogoMode = "unicode" | "square" | "ascii";

export interface WelcomeComponentOptions {
	getViewportRows?: () => number | undefined;
	getReservedBottomRows?: (termWidth: number) => number;
	rightGutterWidth?: number;
	buildLabel?: string;
	keyDisplayContext?: KeyDisplayContext;
	/** Workspace directory to label. Defaults to the resolved project directory. */
	cwd?: string;
	/** Render the resting logo frame instead of playing the startup gradient sweep. */
	reducedMotion?: boolean;
}

/** Left indent, inside the border, shared by the mark and every content row. */
const INDENT = "   ";
const INDENT_WIDTH = INDENT.length;

/** Columns the border itself costs: one vertical edge on each side. */
const BORDER_WIDTH = 2;

/** Rows the border itself costs: the title rail and the bottom edge. */
const BORDER_ROWS = 2;

/** Identity line under the mark, and the one-line purpose statement under it. */
const BRAND_IDENTITY = "Vibrato · LIG System · AI Tech Research Lab";
const BRAND_TAGLINE = "Research Support Tool";

/** Minimum gap between a row's left content and its right-aligned value. */
const RIGHT_VALUE_GAP = 2;

/** Gap between key-hint entries. */
const KEY_HINT_GAP = "    ";

/** Narrowest workspace label worth right-aligning; below this it is dropped. */
const MIN_WORKSPACE_WIDTH = 8;

/** Content rows the mark tier carries besides the mark itself (blanks included). */
const MARK_TIER_SURROUNDING_ROWS = 10;

/** Content rows of the widest markless tier: the same rows, blank-padded. */
const PADDED_MARKLESS_ROWS = 9;

/** The four affordances worth naming on the launch surface. */
const KEY_HINTS: ReadonlyArray<{ key: string; label: string }> = [
	{ key: "/", label: "commands" },
	{ key: "#", label: "actions" },
	{ key: "!", label: "shell" },
	{ key: "?", label: "keymap" },
];

/**
 * Launch surface: a rounded border with the name and version drawn into its
 * top rail, wrapped around a single column holding the `vib` block-letter mark
 * swept in the LIG CI palette, the identity line, the model and workspace the
 * session is pointed at, an LSP summary, and four key hints. One column, no
 * side panels.
 *
 * The mark and the border carry the brand, so no rule or plain-text wordmark
 * sits beside them. When the row budget or the terminal width cannot hold the
 * mark whole it is dropped entirely — content rows are never traded away to
 * keep it, and it is never clipped.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private lspServers: LspServerInfo[] = [],
		private readonly logoMode: WelcomeLogoMode = "unicode",
		private readonly options: WelcomeComponentOptions = {},
	) {}

	invalidate(): void {}

	/**
	 * Start the gradient sweep. It loops continuously until `dispose()`, so the
	 * timer's lifetime is the component's. Safe to call multiple times —
	 * subsequent calls reset and restart.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		if (this.options.reducedMotion) {
			// `#animStart` stays null, which `#currentLogoFrame` already resolves to
			// the resting frame, so one render settles the surface with no timer.
			// A continuous sweep makes this affordance matter more, not less.
			requestRender();
			return;
		}
		this.#animStart = performance.now();
		requestRender();
		this.#animTimer = setInterval(requestRender, SWEEP_TICK_MS);
		// Never hold the process open on the strength of a decoration.
		this.#animTimer.unref?.();
	}

	/**
	 * Stop the sweep and hold the resting frame. Called once the session becomes
	 * active: the mark has scrolled out of view by then, and the component is
	 * never removed from the UI root, so a still-looping timer would re-render
	 * the whole interface for the rest of the session to animate something
	 * nobody can see.
	 */
	settle(): void {
		this.#stopAnimation();
	}

	dispose(): void {
		this.#stopAnimation();
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	render(termWidth: number): string[] {
		// The gutter is reserved by shrinking the box, so its right edge stops
		// short of the composer's rail instead of overprinting it.
		const rightGutterWidth = this.#rightGutterWidth(termWidth);
		const boxWidth = Math.max(0, termWidth - rightGutterWidth);
		if (boxWidth < 4) return [];

		const targetRows = this.#targetRows(termWidth);
		if (targetRows !== undefined && targetRows <= 0) return [];

		return this.#withRightGutter(this.#box(boxWidth, targetRows ?? Number.POSITIVE_INFINITY), rightGutterWidth);
	}

	/** Draw the border, then fit the content column inside it. */
	#box(boxWidth: number, budget: number): string[] {
		const contentWidth = boxWidth - BORDER_WIDTH;
		const hChar = theme.boxRound.horizontal;
		const h = theme.fg("dim", hChar);
		const v = theme.fg("dim", theme.boxRound.vertical);

		const top = this.#titleRail(boxWidth, hChar);
		if (budget < 2) return [top];

		const bottom =
			theme.fg("dim", theme.boxRound.bottomLeft) +
			h.repeat(contentWidth) +
			theme.fg("dim", theme.boxRound.bottomRight);
		if (budget < BORDER_ROWS + 1) return [top, bottom];

		const body = this.#bodyRows(contentWidth, budget - BORDER_ROWS).map(
			row => v + this.#fitToWidth(row, contentWidth) + v,
		);
		return [top, ...body, bottom];
	}

	/** Top edge with ` vib v1.2.3 · dev build ` inlaid after a short lead-in. */
	#titleRail(boxWidth: number, hChar: string): string {
		const buildLabel = this.options.buildLabel ?? formatBuildLabel();
		const title = ` ${APP_NAME} v${this.version}${buildLabel ? ` · ${buildLabel}` : ""} `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", title);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - BORDER_WIDTH;
		const tl = theme.fg("dim", theme.boxRound.topLeft);
		const tr = theme.fg("dim", theme.boxRound.topRight);
		if (titleVisLen >= titleSpace) {
			return tl + truncateToWidth(titleStyled, titleSpace) + tr;
		}
		return tl + titleStyled + theme.fg("dim", hChar.repeat(titleSpace - titleVisLen)) + tr;
	}

	/** Content column: the widest tier that fits `budget` rows. */
	#bodyRows(width: number, budget: number): string[] {
		const identityRow = this.#clip(`${INDENT}${theme.fg("muted", BRAND_IDENTITY)}`, width);
		const taglineRow = this.#clip(`${INDENT}${theme.fg("dim", BRAND_TAGLINE)}`, width);
		const modelRow = this.#modelRow(width);

		if (budget < 2) return [identityRow];
		if (budget < 3) return [identityRow, modelRow];

		const lspRow = this.#clip(`${INDENT}${theme.fg("dim", this.#lspLabel())}`, width);
		const keysRow = this.#clip(`${INDENT}${this.#keyHints(Math.max(1, width - INDENT_WIDTH))}`, width);

		const logoLines = this.#logoLines();
		const markWidth = Math.max(...logoLines.map(line => visibleWidth(line)));
		// The mark goes whole or not at all: no horizontal clip, no partial rows.
		if (INDENT_WIDTH + markWidth <= width && budget >= logoLines.length + MARK_TIER_SURROUNDING_ROWS) {
			const mark = this.#currentLogoFrame(logoLines).map(line => `${INDENT}${line}`);
			return ["", ...mark, "", identityRow, taglineRow, "", modelRow, lspRow, "", keysRow, ""];
		}

		// The tagline rides only the two roomiest tiers; every tighter budget
		// spends its rows on the model, LSP, and key-hint information instead.
		if (budget >= PADDED_MARKLESS_ROWS) return ["", identityRow, taglineRow, "", modelRow, lspRow, "", keysRow, ""];
		if (budget >= 6) return [identityRow, "", modelRow, lspRow, "", keysRow];
		if (budget >= 5) return [identityRow, "", modelRow, lspRow, keysRow];
		if (budget >= 4) return [identityRow, modelRow, lspRow, keysRow];
		return [identityRow, modelRow, keysRow];
	}

	#modelRow(width: number): string {
		const left = `${INDENT}${theme.fg("muted", this.modelName)} ${theme.fg("dim", `· ${this.providerName}`)}`;
		// Right-align inside a trailing indent that mirrors the leading one, so the
		// workspace never sits flush against the border.
		const railWidth = Math.max(0, width - INDENT_WIDTH);
		const workspaceBudget = railWidth - visibleWidth(left) - RIGHT_VALUE_GAP;
		const workspace = workspaceBudget >= MIN_WORKSPACE_WIDTH ? this.#workspaceLabel(workspaceBudget) : "";
		return this.#alignRow(left, workspace ? theme.fg("dim", workspace) : "", railWidth);
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

	/** Fit string to exact width with native ANSI/wide-glyph truncation and padding. */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			return truncateToWidth(str, width, null, true);
		}
		return str + padding(width - visLen);
	}

	#withRightGutter(lines: string[], rightGutterWidth: number): string[] {
		if (rightGutterWidth <= 0) return lines;
		const gutter = padding(rightGutterWidth);
		return lines.map(line => line + gutter);
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

	/** Pick the logo frame for the current sweep position, or the resting frame. */
	#currentLogoFrame(logoLines: readonly string[]): readonly string[] {
		if (this.#animStart == null) return restFrame(this.logoMode);
		const elapsed = performance.now() - this.#animStart;
		// Linear, deliberately: the one-shot intro used an ease-out cubic to
		// decelerate into a resting frame, and a curve that ends at rest cannot be
		// made continuous across a loop seam — it would snap from stopped back to
		// full speed once per period. At constant speed both phases simply wrap,
		// and `gradientLogo` is periodic in each, so the seam is invisible.
		const phase = fract(elapsed / SWEEP_PERIOD_MS);
		// The shine traverses on its own period so the two layers parallax.
		const shinePos = fract(elapsed / SHINE_PERIOD_MS);
		return gradientLogo(logoLines, phase, { strength: SHINE_STRENGTH, pos: shinePos });
	}

	#logoLines(): readonly string[] {
		if (this.logoMode === "ascii") return ASCII_VIB_LOGO;
		if (this.logoMode === "square") return SQUARE_VIB_LOGO;
		return VIB_LOGO;
	}
}

// The launch mark spells the `vib` command in outlined block letters. It is
// deliberately not a rendering of the LIG wordmark: the CI guide forbids
// redrawing the wordmark in any other form, so the corporate identity is
// carried by the gradient palette and the theme, never by ASCII art.
// biome-ignore format: preserve ASCII art layout
const VIB_LOGO = [
	"╭──╮        ╭──╮  ╭────╮  ╭───────╮ ",
	"╰╮ ╰╮      ╭╯ ╭╯  ╰╮  ╭╯  │ ╭────╮╰╮",
	" ╰╮ ╰╮    ╭╯ ╭╯    │  │   │ ╰────╯╭╯",
	"  ╰╮ ╰╮  ╭╯ ╭╯     │  │   │ ╭────╮╰╮",
	"   ╰╮ ╰──╯ ╭╯     ╭╯  ╰╮  │ ╰────╯╭╯",
	"    ╰──────╯      ╰────╯  ╰───────╯ ",
];

// biome-ignore format: preserve ASCII art layout
const SQUARE_VIB_LOGO = [
	"┌──┐        ┌──┐  ┌────┐  ┌───────┐ ",
	"└┐ └┐      ┌┘ ┌┘  └┐  ┌┘  │ ┌────┐└┐",
	" └┐ └┐    ┌┘ ┌┘    │  │   │ └────┘┌┘",
	"  └┐ └┐  ┌┘ ┌┘     │  │   │ ┌────┐└┐",
	"   └┐ └──┘ ┌┘     ┌┘  └┐  │ └────┘┌┘",
	"    └──────┘      └────┘  └───────┘ ",
];

// biome-ignore format: preserve ASCII art layout
const ASCII_VIB_LOGO = [
	"+--+        +--+  +----+  +-------+ ",
	" \\  \\      /  /    |  |   | +----+\\ ",
	"  \\  \\    /  /     |  |   | +----+/ ",
	"   \\  \\  /  /      |  |   | +----+\\ ",
	"    \\  \\/  /       |  |   | +----+/ ",
	"     +----+       +----+  +-------+ ",
];

type GradientStop = readonly [number, number, number];

interface GradientPalette {
	/** Truecolor stops, swept bottom-left → top-right. */
	stops: ReadonlyArray<GradientStop>;
	/** 256-color ramp fallback when truecolor isn't available. */
	ramp256: readonly number[];
}

/**
 * Brand-blue palette for dark terminals.
 *
 * This used to sweep LIG Futuristic Gray (#BCBEC0) ⇄ white, which the CI guide
 * prescribes for the wordmark on dark grounds. It read as almost nothing: the
 * whole ramp sat inside a 134/255 luminance band with its floor at 121, so the
 * movement had no contrast to show. The repository owner decided the `vib`
 * mark sweeps blue on dark terminals too. That is a deliberate departure from
 * BS 08, recorded in `docs/design-system.md`, and it is scoped to this mark —
 * the lettering of the `vib` command, never the LIG wordmark, which is still
 * never redrawn or recoloured.
 */
const DARK_TERMINAL_PALETTE: GradientPalette = {
	stops: [
		[26, 54, 102], // deep brand navy, still legible on a dark ground
		[63, 110, 180],
		[220, 232, 251], // near-white blue highlight peak
		[63, 110, 180],
		[26, 54, 102],
	],
	// Same blue family in the xterm cube, ascending in lightness to the peak:
	// #00005f, #005faf, #87afff, #d7d7ff.
	ramp256: [17, 25, 111, 189, 111, 25, 17],
};

/**
 * LIG CI palette for light terminals: LIG Innovative Blue (#002F6D) bracketed
 * by the two ends of the guide's graphic-motif gradient (derived from its CMYK
 * spec, C100 M80 Y30 K35 → C100 M86 Y20).
 */
const LIGHT_TERMINAL_PALETTE: GradientPalette = {
	stops: [
		[0, 45, 92], // motif dark end
		[0, 47, 109], // LIG Innovative Blue
		[0, 61, 150], // motif light end
		[0, 47, 109],
		[0, 45, 92],
	],
	ramp256: [17, 18, 24, 25, 24, 18, 17],
};

function currentGradientPalette(): GradientPalette {
	return isLightTheme(getCurrentThemeName()) ? LIGHT_TERMINAL_PALETTE : DARK_TERMINAL_PALETTE;
}

/**
 * Half-width of the shine highlight band, in gradient-t units. Narrow enough
 * that the highlight reads as a travelling line rather than a wash.
 */
const SHINE_HALF_WIDTH = 0.1;

interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the diagonal, in [0, 1]. */
	pos: number;
}

/** Positive fractional part, so a wrapping phase stays in [0, 1). */
function fract(value: number): number {
	return ((value % 1) + 1) % 1;
}

/**
 * Shine intensity at gradient position `t`. The distance is circular — the
 * gradient is a ring, so a band leaving one end has to re-enter at the other.
 * A plain `|t - pos|` made the highlight vanish at t=1 and reappear at t=0,
 * which is exactly the seam a continuous loop would show once per period.
 */
function shineAt(t: number, pos: number, strength: number): number {
	if (strength <= 0) return 0;
	const offset = Math.abs(t - pos);
	const dist = Math.min(offset, 1 - offset);
	return Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * strength;
}
/**
 * Apply a multi-stop diagonal gradient (bottom-left → top-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
function gradientLogo(
	lines: readonly string[],
	phase = 0,
	shine?: ShineConfig,
	palette: GradientPalette = currentGradientPalette(),
): string[] {
	const reset = "\x1b[0m";
	const rows = lines.length;
	const cols = Math.max(...lines.map(l => l.length));
	// span+1 so `base` stays strictly < 1: avoids the wrap-around at the
	// far corner mapping back to t=0 (hot pink) on the resting frame.
	const span = Math.max(1, cols + rows - 1);
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	const colorAt = TERMINAL.trueColor
		? (t: number): string => {
				// 5-stop palette keeps the sweep inside the CI colours instead of
				// drifting through unrelated hues the way a naive HSL lerp would.
				const stops = palette.stops;
				const seg = t * (stops.length - 1);
				const i = Math.min(stops.length - 2, Math.floor(seg));
				const f = seg - i;
				const a = stops[i];
				const b = stops[i + 1];
				let r = a[0] + (b[0] - a[0]) * f;
				let g = a[1] + (b[1] - a[1]) * f;
				let bl = a[2] + (b[2] - a[2]) * f;
				const intensity = shineAt(t, shinePos, shineStrength);
				if (intensity > 0) {
					r += (255 - r) * intensity;
					g += (255 - g) * intensity;
					bl += (255 - bl) * intensity;
				}
				return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
			}
		: (t: number): string => {
				const ramp = palette.ramp256;
				let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
				// Promote to the brightest ramp slot when the shine band peaks here.
				if (shineAt(t, shinePos, shineStrength) > 0.5) idx = ramp.length - 1;
				return `\x1b[38;5;${ramp[idx]}m`;
			};
	return lines.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			// Diagonal: bottom-left (x=0, y=rows-1) → top-right (x=cols-1, y=0)
			const base = (x + (rows - 1 - y)) / span;
			const t = (((base + phase) % 1) + 1) % 1;
			result += colorAt(t) + char + reset;
		}
		return result;
	});
}

/**
 * Duration of one full rotation of the gradient, and of one traversal of the
 * shine band. These preserve the pace the one-shot intro was tuned to: it ran
 * 1.5 rotations and 3 shine traversals across 3000 ms, so a rotation took
 * 2000 ms and a traversal 1000 ms. The loop keeps those speeds and never stops.
 */
const SWEEP_PERIOD_MS = 2000;
const SHINE_PERIOD_MS = 1000;

/**
 * Opacity of the shine overlay. Constant, where the one-shot intro faded it to
 * zero: a fade has an end, and an end is a seam.
 */
const SHINE_STRENGTH = 0.8;

/**
 * Resolve the sweep cadence without making tests mutate global process state.
 *
 * 20fps is enough here: a rotation takes 2000 ms across 36 columns, so the
 * gradient advances one column every ~55 ms and a 50 ms tick stays under that.
 * Native Windows multiplexers stay capped at 10fps to avoid ConPTY output
 * backpressure. The sweep now runs for the life of the surface rather than for
 * three seconds, so this cadence is a standing cost, not a startup one.
 */
export function resolveWelcomeIntroTickMs(
	platform: NodeJS.Platform = process.platform,
	tmux = process.env.TMUX,
): number {
	return platform === "win32" && tmux ? 100 : 50;
}

/** The resolved cadence the sweep timer runs at. */
const SWEEP_TICK_MS = resolveWelcomeIntroTickMs();

/** Resting gradient frames, cached per logo mode and palette, for the no-motion path. */
const REST_FRAME_CACHE = new Map<string, readonly string[]>();

function restFrame(mode: WelcomeLogoMode): readonly string[] {
	const palette = currentGradientPalette();
	const key = `${mode}:${palette === LIGHT_TERMINAL_PALETTE ? "light" : "dark"}`;
	let frame = REST_FRAME_CACHE.get(key);
	if (!frame) {
		const lines = mode === "ascii" ? ASCII_VIB_LOGO : mode === "square" ? SQUARE_VIB_LOGO : VIB_LOGO;
		frame = gradientLogo(lines, 0, undefined, palette);
		REST_FRAME_CACHE.set(key, frame);
	}
	return frame;
}
