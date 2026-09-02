import { describe, expect, it } from "bun:test";
import {
	resolvePythonIntegrationGate,
	resolvePythonIpcTrace,
	resolvePythonSkipCheck,
} from "@vib-rato/coding-agent/tools/implementations";
import {
	resolvePythonIntegrationGate as resolveKernelIntegrationGate,
	resolvePythonIpcTrace as resolveKernelIpcTrace,
	resolvePythonSkipCheck as resolveKernelSkipCheck,
} from "../../src/eval/py/env";

const RESOLVERS = [
	{
		kernel: resolveKernelSkipCheck,
		tool: resolvePythonSkipCheck,
		vib: "VIB_PYTHON_SKIP_CHECK",
		pi: "PI_PYTHON_SKIP_CHECK",
	},
	{
		kernel: resolveKernelIpcTrace,
		tool: resolvePythonIpcTrace,
		vib: "VIB_PYTHON_IPC_TRACE",
		pi: "PI_PYTHON_IPC_TRACE",
	},
	{
		kernel: resolveKernelIntegrationGate,
		tool: resolvePythonIntegrationGate,
		vib: "VIB_PYTHON_INTEGRATION",
		pi: "PI_PYTHON_INTEGRATION",
	},
] as const;

describe("Python environment flag resolvers", () => {
	it("shares the kernel resolver with tool exports for hostile Vibrato/PI values", () => {
		for (const { kernel, tool, vib, pi } of RESOLVERS) {
			expect(tool).toBe(kernel);
			expect(tool({ [vib]: "0", [pi]: "1" })).toBe(true);
			expect(tool({ [vib]: " \tYeS\n" })).toBe(true);
			expect(tool({ [vib]: "false", [pi]: " 0 " })).toBe(false);
		}
	});
});
