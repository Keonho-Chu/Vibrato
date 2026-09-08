import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Container } from "@vib-rato/tui";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { ExecutionStatusTracker } from "../src/modes/execution-status";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

const controllers: ExtensionUiController[] = [];
function harness() {
	const tracker = new ExecutionStatusTracker();
	const stopHandlers = new Set<() => void>();
	let stopped = false;
	const overlayHide = vi.fn();
	const context = {
		editor: { getText: () => "draft", setText: vi.fn() },
		editorContainer: new Container(),
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		ui: {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			showOverlay: () => ({ hide: overlayHide }),
			terminal: { columns: 80, rows: 24 },
		},
		executionStatus: tracker,
		onStop: (handler: () => void) => {
			stopHandlers.add(handler);
			return () => {
				stopHandlers.delete(handler);
			};
		},
		isStopped: () => stopped,
		restoreComposer: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(context);
	controllers.push(controller);
	return {
		tracker,
		context,
		controller,
		overlayHide,
		stop: () => {
			stopped = true;
			for (const handler of [...stopHandlers]) handler();
		},
	};
}

beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
});

describe("execution status dialog lifetimes", () => {
	it("settles successful selection before releasing its input state", async () => {
		const { tracker, context, controller } = harness();
		const pending = controller.showHookSelector("Select", ["one", "two"]);
		expect(tracker.getSnapshot().inputRequests).toBe(1);
		context.hookSelector?.handleInput("\r");
		await expect(pending).resolves.toBe("one");
		expect(tracker.getSnapshot().inputRequests).toBe(0);
	});
	it("aborts input and honors a pre-aborted confirmation signal", async () => {
		const { tracker, controller } = harness();
		const abort = new AbortController();
		const pending = controller.showHookInput("Input", undefined, { signal: abort.signal });
		expect(tracker.getSnapshot().inputRequests).toBe(1);
		abort.abort();
		await expect(pending).resolves.toBeUndefined();
		await expect(controller.showHookConfirm("Confirm", "Proceed?", { signal: abort.signal })).resolves.toBe(false);
		expect(tracker.getSnapshot().inputRequests).toBe(0);
	});
	it("settles standard input on explicit hide, stop, and disposal", async () => {
		const { tracker, controller, stop } = harness();
		const hidden = controller.showHookInput("Hidden input");
		controller.hideHookInput();
		await expect(hidden).resolves.toBeUndefined();
		const disposed = controller.showHookEditor("Disposed editor");
		controller.dispose();
		await expect(disposed).resolves.toBeUndefined();
		const stopped = controller.showHookSelector("Stopped selector", ["one"]);
		stop();
		await expect(stopped).resolves.toBeUndefined();
		expect(tracker.getSnapshot().inputRequests).toBe(0);
	});
	it("does not let captured old cleanup hide or cancel a replacement dialog", async () => {
		const { tracker, context, controller } = harness();
		const first = controller.showHookEditor("First");
		const cleanup = controller.captureSessionUiCleanup();
		const second = controller.showHookInput("Second");
		const secondComponent = context.hookInput;
		await expect(first).resolves.toBeUndefined();
		cleanup();
		cleanup();
		expect(context.hookInput).toBe(secondComponent);
		expect(tracker.getSnapshot().inputRequests).toBe(1);
		controller.hideHookInput();
		await expect(second).resolves.toBeUndefined();
		expect(tracker.getSnapshot().inputRequests).toBe(0);
	});
	it("settles synchronous custom completion and disposes its late component", async () => {
		const { tracker, controller } = harness();
		const component = { render: () => ["custom"], invalidate: () => {}, dispose: vi.fn() };
		await expect(
			controller.showHookCustom<string>((_ui, _theme, _keys, done) => {
				done("ok");
				return component;
			}),
		).resolves.toBe("ok");
		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(tracker.getSnapshot().inputRequests).toBe(0);
	});
	it("propagates custom factory rejection without leaking a request", async () => {
		const { tracker, controller } = harness();
		const failure = new Error("factory failed");
		await expect(controller.showHookCustom(() => Promise.reject(failure))).rejects.toBe(failure);
		expect(tracker.getSnapshot().inputRequests).toBe(0);
	});
	it("cancels pending custom construction on disposal and disposes late resolution", async () => {
		const { tracker, controller } = harness();
		const component = { render: () => ["late"], invalidate: () => {}, dispose: vi.fn() };
		const factory = Promise.withResolvers<typeof component>();
		const pending = controller.showHookCustom(() => factory.promise);
		controller.dispose();
		await expect(pending).resolves.toBeUndefined();
		expect(tracker.getSnapshot().inputRequests).toBe(0);
		factory.resolve(component);
		await Bun.sleep(0);
		expect(component.dispose).toHaveBeenCalledTimes(1);
	});
	it("keeps a replacement custom overlay alive when old cleanup and factory finish late", async () => {
		const { tracker, controller, overlayHide } = harness();
		const oldComponent = { render: () => ["old"], invalidate: () => {}, dispose: vi.fn() };
		const factory = Promise.withResolvers<typeof oldComponent>();
		const first = controller.showHookCustom(() => factory.promise);
		const cleanup = controller.captureSessionUiCleanup();
		const receiveDone = Promise.withResolvers<(value: string) => void>();
		const currentComponent = { render: () => ["current"], invalidate: () => {}, dispose: vi.fn() };
		const second = controller.showHookCustom<string>(
			(_ui, _theme, _keys, done) => {
				receiveDone.resolve(done);
				return currentComponent;
			},
			{ overlay: true },
		);
		const done = await receiveDone.promise;
		await expect(first).resolves.toBeUndefined();
		cleanup();
		factory.resolve(oldComponent);
		await Bun.sleep(0);
		expect(tracker.getSnapshot().inputRequests).toBe(1);
		expect(currentComponent.dispose).not.toHaveBeenCalled();
		expect(overlayHide).not.toHaveBeenCalled();
		done("accepted");
		await expect(second).resolves.toBe("accepted");
		expect(tracker.getSnapshot().inputRequests).toBe(0);
		expect(overlayHide).toHaveBeenCalledTimes(1);
	});
});
