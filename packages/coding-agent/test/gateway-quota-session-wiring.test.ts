/**
 * Session wiring for the success seam, driven through the real provider
 * response interceptor.
 *
 * `prepareSimpleStreamOptions` hands back the very callback the session installs
 * with `setProviderResponseInterceptor`, so these exercise the production hook
 * rather than calling the fold directly: deleting the `#observeGatewayQuota`
 * call inside that wrapper turns them red. The fold itself is private, and this
 * is one of the two ways in. The other is a whole prompt, covered by
 * `gateway-quota-prompt-e2e.test.ts`, which also reaches the 429/503
 * transport-failure seam.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@vib-rato/agent-core";
import { getBundledModel, type ProviderResponseMetadata } from "@vib-rato/ai";
import { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import { Settings } from "@vib-rato/coding-agent/config/settings";
import { AgentSession } from "@vib-rato/coding-agent/session/agent-session";
import { AuthStorage } from "@vib-rato/coding-agent/session/auth-storage";
import { fingerprintCredential } from "@vib-rato/coding-agent/session/gateway-quota-observer";
import { SessionManager } from "@vib-rato/coding-agent/session/session-manager";
import { TempDir } from "@vib-rato/utils";

const PROVIDER = "anthropic";

describe("AgentSession gateway quota wiring", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@vib-gateway-quota-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(PROVIDER, "gateway-key-one");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function requireModel() {
		const model = getBundledModel(PROVIDER, "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		return model;
	}

	function buildSessionWithModel(): { session: AgentSession; model: ReturnType<typeof requireModel> } {
		const model = requireModel();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		sessions.push(session);
		return { session, model };
	}

	function buildSession(): AgentSession {
		return buildSessionWithModel().session;
	}

	/**
	 * Count every credential entry point the observation path could reach.
	 *
	 * `getApiKey` is the mutating resolve: it refreshes rotating config keys,
	 * rewrites the model's `Authorization` header, and refreshes OAuth tokens.
	 * `peekApiKey` is the read-only one. Observation may use the second and must
	 * never use the first.
	 */
	function countCredentialCalls(): { getApiKey: number; peekApiKey: number } {
		const counts = { getApiKey: 0, peekApiKey: 0 };
		const registry = modelRegistry as unknown as Record<string, unknown>;
		const storage = modelRegistry.authStorage as unknown as Record<string, unknown>;
		const realGet = modelRegistry.getApiKey.bind(modelRegistry);
		const realPeek = modelRegistry.authStorage.peekApiKey.bind(modelRegistry.authStorage);
		registry.getApiKey = (...args: unknown[]) => {
			counts.getApiKey += 1;
			return (realGet as (...a: unknown[]) => unknown)(...args);
		};
		storage.peekApiKey = (...args: unknown[]) => {
			counts.peekApiKey += 1;
			return (realPeek as (...a: unknown[]) => unknown)(...args);
		};
		return counts;
	}

	/**
	 * Deliver one provider response through the session's own interceptor.
	 *
	 * The callback comes from `prepareSimpleStreamOptions`, which installs
	 * `#onResponse` verbatim, so this is the same function the streaming
	 * transport calls on a served request.
	 */
	async function deliver(
		session: AgentSession,
		response: ProviderResponseMetadata,
		model = requireModel(),
	): Promise<void> {
		const prepared = session.prepareSimpleStreamOptions({ apiKey: "unused" }, PROVIDER);
		if (!prepared.onResponse) throw new Error("Expected the session to install a provider response interceptor");
		await prepared.onResponse(response, model, undefined);
		// The fold resolves the credential asynchronously before it applies.
		for (let i = 0; i < 20; i++) await Promise.resolve();
	}

	const served = (headers: Record<string, string>, status = 200): ProviderResponseMetadata => ({ status, headers });

	it("starts with no gateway observation", () => {
		expect(buildSession().gatewayQuotaState).toBeNull();
	});

	it("observes the window budget from a served response through the real interceptor", async () => {
		const session = buildSession();

		await deliver(session, served({ "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "600" }));

		expect(session.gatewayQuotaState).toMatchObject({ limit: 1000, remaining: 600 });
	});

	it("binds the observation to the model, the resolved credential, and the session", async () => {
		const session = buildSession();
		const model = requireModel();

		await deliver(session, served({ "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "600" }));

		expect(session.gatewayQuotaState?.key).toEqual({
			provider: model.provider,
			baseUrl: model.baseUrl,
			credentialId: fingerprintCredential("gateway-key-one", session.credentialSessionId),
			sessionId: session.sessionId,
		});
	});

	it("discards the previous credential's budget when the credential rotates mid-session", async () => {
		const session = buildSession();
		await deliver(session, served({ "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "10" }));
		const firstKeyId = session.gatewayQuotaState?.key.credentialId;
		expect(session.gatewayQuotaState).toMatchObject({ limit: 1000, remaining: 10 });

		// The session-scoped selector never changes once the session exists, so
		// only a credential-derived key can notice this rotation.
		authStorage.setRuntimeApiKey(PROVIDER, "gateway-key-two");
		await deliver(session, served({ "x-vug-queued-ms": "40" }));

		expect(session.credentialSessionId).toBe(session.sessionId);
		expect(session.gatewayQuotaState?.key.credentialId).not.toBe(firstKeyId);
		expect(session.gatewayQuotaState?.limit).toBeUndefined();
		expect(session.gatewayQuotaState?.remaining).toBeUndefined();
		expect(session.gatewayQuotaState?.lastQueuedMs).toBe(40);
	});

	it("ignores a served response that carries no gateway header", async () => {
		const session = buildSession();

		await deliver(session, served({ "content-type": "application/json", "x-request-id": "abc" }));

		expect(session.gatewayQuotaState).toBeNull();
	});

	it("touches no credential state for a response with no gateway header", async () => {
		const { session, model } = buildSessionWithModel();
		const counts = countCredentialCalls();
		const headersBefore = JSON.stringify(model.headers ?? null);

		// Every response from every provider reaches the interceptor. One that is
		// not the gateway's must cost nothing: no credential resolve, no peek, and
		// above all no rewrite of the model's effective Authorization header.
		await deliver(session, served({ "content-type": "application/json", "x-request-id": "abc" }), model);
		await deliver(session, served({ "retry-after": "5" }), model);
		await deliver(session, served({}), model);

		expect(counts).toEqual({ getApiKey: 0, peekApiKey: 0 });
		expect(JSON.stringify(model.headers ?? null)).toBe(headersBefore);
		expect(session.gatewayQuotaState).toBeNull();
	});

	it("fingerprints a gateway response with the read-only peek, never the mutating resolve", async () => {
		const { session, model } = buildSessionWithModel();
		const counts = countCredentialCalls();
		const headersBefore = JSON.stringify(model.headers ?? null);

		await deliver(session, served({ "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "600" }), model);

		expect(counts.getApiKey).toBe(0);
		expect(counts.peekApiKey).toBeGreaterThan(0);
		expect(JSON.stringify(model.headers ?? null)).toBe(headersBefore);
		expect(session.gatewayQuotaState?.key.credentialId).toBe(
			fingerprintCredential("gateway-key-one", session.credentialSessionId),
		);
	});

	it("ignores a non-2xx response arriving on the success interceptor", async () => {
		const session = buildSession();

		await deliver(session, served({ "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "600" }, 500));

		expect(session.gatewayQuotaState).toBeNull();
	});

	it("keeps one session's observation out of another session", async () => {
		const first = buildSession();
		const second = buildSession();

		await deliver(first, served({ "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "600" }));

		expect(first.gatewayQuotaState?.remaining).toBe(600);
		expect(second.gatewayQuotaState).toBeNull();
	});

	it("never writes the observation or the credential into the transcript", async () => {
		const session = buildSession();

		await deliver(session, served({ "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "600" }));
		const dumped = JSON.stringify(session.messages);

		expect(session.gatewayQuotaState?.remaining).toBe(600);
		expect(dumped).not.toContain("x-vug");
		expect(dumped).not.toContain("gateway-key-one");
		expect(dumped).not.toContain("600");
	});
});
