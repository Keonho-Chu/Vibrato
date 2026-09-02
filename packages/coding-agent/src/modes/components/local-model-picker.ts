import { Container, matchesKey, Spacer, Text, TruncatedText } from "@vib-rato/tui";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

/**
 * A model discovered on a local LLM endpoint.
 *
 * Structurally identical to `LocalEndpointModel` in `setup/local-endpoint.ts`;
 * declared here so the TUI components stay independent of the setup module.
 */
export interface LocalModelChoice {
	id: string;
	contextLength?: number;
}

/** Rows shown at once before the list scrolls. */
const VISIBLE_ROWS = 10;

/**
 * Render a context window the way a user reads it: `128K context`, not `131072`.
 * Returns null when the server did not report a usable length, so the row simply
 * omits the annotation instead of printing a placeholder.
 */
export function formatModelContextLength(contextLength: number | undefined): string | null {
	if (contextLength === undefined || !Number.isFinite(contextLength) || contextLength <= 0) return null;
	if (contextLength >= 1_000_000) {
		const millions = contextLength / 1_000_000;
		return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M context`;
	}
	if (contextLength >= 1000) return `${Math.round(contextLength / 1000)}K context`;
	return `${contextLength} tokens context`;
}

/**
 * The second (and last) screen of the local endpoint connect flow: pick which
 * discovered model the session should start with. The caller skips this screen
 * entirely when the endpoint reported exactly one model.
 */
export class LocalModelPickerComponent extends Container {
	#listContainer: Container;
	#models: readonly LocalModelChoice[];
	#onCancel: () => void;
	#onRender: () => void;
	#onSelect: (model: LocalModelChoice) => void | Promise<unknown>;
	#scrollOffset = 0;
	#selectInFlight = false;
	#selectedIndex = 0;

	constructor(
		models: readonly LocalModelChoice[],
		baseUrl: string,
		onSelect: (model: LocalModelChoice) => void | Promise<unknown>,
		onCancel: () => void,
		onRender: () => void = () => {},
	) {
		super();
		this.#models = models;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#onRender = onRender;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Choose a model")));
		this.addChild(new TruncatedText(theme.fg("muted", `  ${models.length} model(s) served by ${baseUrl}`), 0, 0));
		this.addChild(new Spacer(1));
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to cancel]"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#updateList();
	}

	handleInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			this.#onCancel();
			return;
		}
		if (matchesKey(keyData, "up")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrent();
		}
	}

	#selectCurrent(): void {
		if (this.#selectInFlight) return;
		const model = this.#models[this.#selectedIndex];
		if (!model) return;
		this.#selectInFlight = true;
		let selection: unknown;
		try {
			selection = this.#onSelect(model);
		} catch (error) {
			this.#selectInFlight = false;
			throw error;
		}
		if (!(selection instanceof Promise)) {
			this.#selectInFlight = false;
			return;
		}
		void selection.then(
			() => {
				this.#selectInFlight = false;
			},
			() => {
				this.#selectInFlight = false;
			},
		);
	}

	#moveSelection(delta: number): void {
		if (this.#models.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex + delta + this.#models.length) % this.#models.length;
		if (this.#selectedIndex < this.#scrollOffset) this.#scrollOffset = this.#selectedIndex;
		else if (this.#selectedIndex >= this.#scrollOffset + VISIBLE_ROWS) {
			this.#scrollOffset = this.#selectedIndex - VISIBLE_ROWS + 1;
		}
		this.#updateList();
		this.#onRender();
	}

	#updateList(): void {
		this.#listContainer.clear();
		if (this.#models.length === 0) {
			this.#listContainer.addChild(new TruncatedText(theme.fg("warning", "  No models were reported."), 0, 0));
			return;
		}
		const end = Math.min(this.#models.length, this.#scrollOffset + VISIBLE_ROWS);
		for (let i = this.#scrollOffset; i < end; i++) {
			const model = this.#models[i];
			if (!model) continue;
			const selected = i === this.#selectedIndex;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = selected ? theme.fg("accent", model.id) : model.id;
			const context = formatModelContextLength(model.contextLength);
			const suffix = context ? theme.fg("muted", `  ${context}`) : "";
			this.#listContainer.addChild(new TruncatedText(`${prefix}${label}${suffix}`, 0, 0));
		}
		if (this.#models.length > VISIBLE_ROWS) {
			this.#listContainer.addChild(
				new TruncatedText(theme.fg("dim", `  Showing ${end - this.#scrollOffset} of ${this.#models.length}`), 0, 0),
			);
		}
	}
}
