/** Environment values consulted by the Python subprocess integration. */
export type PythonEnv = Record<string, string | undefined>;

const PYTHON_TRUTHY = new Set(["1", "true", "yes", "on", "y"]);

/** True when `value` is a non-empty string matching a truthy boolean token. */
export function isTruthyPythonFlag(value: string | undefined): boolean {
	return value !== undefined && PYTHON_TRUTHY.has(value.trim().toLowerCase());
}

/** Resolve paired Vibrato/legacy PI flags using OR semantics. */
export function resolvePythonFlag(env: PythonEnv, vibName: string, piName: string): boolean {
	return isTruthyPythonFlag(env[vibName]) || isTruthyPythonFlag(env[piName]);
}

export function resolvePythonSkipCheck(env: PythonEnv): boolean {
	return resolvePythonFlag(env, "VIB_PYTHON_SKIP_CHECK", "PI_PYTHON_SKIP_CHECK");
}

export function resolvePythonIpcTrace(env: PythonEnv): boolean {
	return resolvePythonFlag(env, "VIB_PYTHON_IPC_TRACE", "PI_PYTHON_IPC_TRACE");
}

export function resolvePythonIntegrationGate(env: PythonEnv): boolean {
	return resolvePythonFlag(env, "VIB_PYTHON_INTEGRATION", "PI_PYTHON_INTEGRATION");
}
