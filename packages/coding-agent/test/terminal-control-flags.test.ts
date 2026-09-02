import { describe, expect, it } from "bun:test";
import { applyTerminalControlFlagsToEnv } from "../src/main";

describe("applyTerminalControlFlagsToEnv", () => {
	it("leaves the env untouched when neither flag is set", () => {
		const env: NodeJS.ProcessEnv = {};
		applyTerminalControlFlagsToEnv({ noPty: false, noTitle: false }, env);
		expect(env).toEqual({});
	});

	it("--no-pty sets the canonical VIB_ name and the legacy PI_ name", () => {
		const env: NodeJS.ProcessEnv = {};
		applyTerminalControlFlagsToEnv({ noPty: true, noTitle: false }, env);
		expect(env.VIB_NO_PTY).toBe("1");
		expect(env.PI_NO_PTY).toBe("1");
	});

	it("--no-pty overrides a user's VIB_NO_PTY=0 so the flag keeps CLI authority", () => {
		// Regression: the reader resolves Vibrato-first, so if the flag only set PI_NO_PTY
		// a user's VIB_NO_PTY=0 would silently override the explicit --no-pty.
		const env: NodeJS.ProcessEnv = { VIB_NO_PTY: "0" };
		applyTerminalControlFlagsToEnv({ noPty: true, noTitle: false }, env);
		expect(env.VIB_NO_PTY).toBe("1");
	});

	it("--no-title sets the canonical VIB_ name and the legacy PI_ name", () => {
		const env: NodeJS.ProcessEnv = { VIB_NO_TITLE: "0" };
		applyTerminalControlFlagsToEnv({ noPty: false, noTitle: true }, env);
		expect(env.VIB_NO_TITLE).toBe("1");
		expect(env.PI_NO_TITLE).toBe("1");
	});

	it("--acp mode implies no-title but not no-pty", () => {
		const env: NodeJS.ProcessEnv = {};
		applyTerminalControlFlagsToEnv({ noPty: false, noTitle: false, mode: "acp" }, env);
		expect(env.VIB_NO_TITLE).toBe("1");
		expect(env.PI_NO_TITLE).toBe("1");
		expect(env.VIB_NO_PTY).toBeUndefined();
	});
});
