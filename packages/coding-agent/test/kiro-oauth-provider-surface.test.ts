import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as kiroOAuthModule from "@vib-rato/ai";
import * as kiroLoginModule from "@vib-rato/ai/utils/oauth/kiro";
import { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import { getSelectableOAuthProviders } from "@vib-rato/coding-agent/config/provider-allowlist";
import { resetSettingsForTest } from "@vib-rato/coding-agent/config/settings";
import { AuthStorage } from "@vib-rato/coding-agent/session/auth-storage";
import { getAgentDbPath, Snowflake } from "@vib-rato/utils";
import { runAuthBrokerCommand } from "../src/cli/auth-broker-cli";

/**
 * Coverage for issue #5064: Kiro OAuth was advertised in every product
 * surface (interactive `/login`, `vib auth-broker login kiro`) but the
 * underlying `AuthStorage.login()` dispatcher had no `case "kiro"`, so every
 * advertised path reported `Unknown OAuth provider: kiro`. This suite proves
 * the package/direct CLI surface and the bundled model catalog are coherent
 * with the advertised provider list.
 */

describe("Kiro OAuth CLI surface (package/direct)", () => {
	let tempDir = "";
	let originalAgentDir: string | undefined;
	const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

	function silenceStdout(): () => string {
		let captured = "";
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;
		return () => captured;
	}

	beforeEach(async () => {
		originalAgentDir = process.env.VIB_AGENT_DIR;
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vib-kiro-cli-"));
		process.env.VIB_AGENT_DIR = tempDir;
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		if (originalAgentDir === undefined) delete process.env.VIB_AGENT_DIR;
		else process.env.VIB_AGENT_DIR = originalAgentDir;
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	test("kiro stays in the OAuth registry but no longer passes the auth-broker CLI's gate", async () => {
		// The provider is still compiled in and reachable through the registry...
		const providers = new Set(kiroOAuthModule.getOAuthProviders().map(p => p.id));
		expect(providers.has("kiro")).toBe(true);
		// ...but the product allowlist decides what the CLI will accept.
		const selectable = new Set(getSelectableOAuthProviders().map(p => p.id));
		expect(selectable.has("kiro")).toBe(false);
	});

	test("`vib auth-broker login unknown-provider-xyz` fails with a clear unknown-provider error, not a crash", async () => {
		const restore = silenceStdout();
		try {
			await expect(
				runAuthBrokerCommand({
					action: "login",
					flags: { provider: "unknown-provider-xyz" },
				}),
			).rejects.toThrow(/Unknown OAuth provider/);
		} finally {
			restore();
		}
	});

	test("`vib auth-broker login kiro` is refused by the allowlist before any login flow starts", async () => {
		// The allowlist gate runs ahead of runLocalLogin(), so the AWS SSO device
		// flow is never entered and nothing is written to the credential store.
		const restore = silenceStdout();
		const loginKiroSpy = vi.spyOn(kiroLoginModule, "loginKiro").mockImplementation(async options => {
			options.onAuth("https://device.sso.us-east-1.amazonaws.com/", "Enter code: TEST-CODE");
			return { access: "broker-kiro-access", refresh: "broker-kiro-refresh", expires: Date.now() + 3600_000 };
		});
		try {
			await expect(
				runAuthBrokerCommand({
					action: "login",
					flags: { provider: "kiro" },
				}),
			).rejects.toThrow("Unknown OAuth provider 'kiro'");
			expect(loginKiroSpy).not.toHaveBeenCalled();

			const store = await kiroOAuthModule.SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				expect(store.getOAuth("kiro")).toBeNull();
			} finally {
				store.close();
			}
		} finally {
			loginKiroSpy.mockRestore();
			restore();
		}
	});

	test("the gate's known-provider list is exactly the selectable set, and names it in the error", async () => {
		const restore = silenceStdout();
		try {
			const expectedKnown = getSelectableOAuthProviders()
				.map(provider => provider.id)
				.sort()
				.join(", ");
			await expect(runAuthBrokerCommand({ action: "login", flags: { provider: "kiro" } })).rejects.toThrow(
				`Known: ${expectedKnown}`,
			);
			// The advertised list is what the CLI accepts: every id in it passes the
			// gate, and hidden built-ins do not.
			expect(expectedKnown).toContain("anthropic");
			expect(expectedKnown).not.toContain("kiro");
			for (const hidden of ["cursor", "github-copilot", "minimax-code"]) {
				await expect(runAuthBrokerCommand({ action: "login", flags: { provider: hidden } })).rejects.toThrow(
					`Unknown OAuth provider '${hidden}'`,
				);
			}
		} finally {
			restore();
		}
	});
});

describe("Kiro model catalog reachable through ModelRegistry (interactive/model-picker surface)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let previousPresetRegistryDisabled: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		previousPresetRegistryDisabled = Bun.env.VIB_MODEL_PRESET_REGISTRY_DISABLED;
		Bun.env.VIB_MODEL_PRESET_REGISTRY_DISABLED = "true";
		tempDir = path.join(os.tmpdir(), `pi-test-kiro-model-registry-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		if (previousPresetRegistryDisabled === undefined) delete Bun.env.VIB_MODEL_PRESET_REGISTRY_DISABLED;
		else Bun.env.VIB_MODEL_PRESET_REGISTRY_DISABLED = previousPresetRegistryDisabled;
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	test("kiro's default model is discoverable through the registry (package + interactive model list)", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		try {
			const model = registry.find("kiro", "auto");
			expect(model).toBeDefined();
			expect(model?.api).toBe("kiro-codewhisperer-stream");
			expect(model?.provider).toBe("kiro");
		} finally {
			registry.dispose();
		}
	});
});

describe("Kiro standalone/import boundary smoke", () => {
	test("@vib-rato/ai exports the Kiro OAuth login/refresh entry points used by every advertised path", () => {
		expect(typeof kiroOAuthModule.getOAuthProviders).toBe("function");
		const kiro = kiroOAuthModule.getOAuthProviders().find(p => p.id === "kiro");
		expect(kiro?.available).toBe(true);
	});

	test("`vib auth-broker login kiro` fails the allowlist gate, not a module resolution error (issue #5064)", async () => {
		// This used to build the real compiled binary and drive the AWS SSO OIDC
		// device-code flow, proving `runLocalLogin()` no longer spawned a child
		// resolved via `import.meta.resolve("@vib-rato/ai/cli")` (unresolvable
		// inside a compiled binary's $bunfs). The product allowlist now refuses
		// kiro before `runLocalLogin()` is ever reached, so that flow cannot be
		// entered through this provider and the compile-plus-network run buys
		// nothing. What stays checkable is that the failure is the allowlist's
		// refusal rather than a resolution crash.
		const ORIGINAL_WRITE = process.stdout.write.bind(process.stdout);
		let captured = "";
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			const error = await runAuthBrokerCommand({
				action: "login",
				flags: { provider: "kiro" },
			}).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toContain("Unknown OAuth provider 'kiro'");
			expect(message).not.toContain("Cannot find package");
			expect(message).not.toContain("Cannot find module");
			expect(captured).not.toContain("Cannot find package");
			expect(captured).not.toContain("Cannot find module");
			expect(captured).not.toContain("Registering client with AWS SSO OIDC");
		} finally {
			process.stdout.write = ORIGINAL_WRITE;
		}
	});
});
