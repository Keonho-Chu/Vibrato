/**
 * End-to-end gateway quota observation across a real prompt.
 *
 * `gateway-quota-session-wiring.test.ts` covers the success interceptor without
 * prompting. This file drives whole turns from a stubbed `global.fetch`, so
 * every production layer between the wire and the status line runs in its real
 * order: the openai-completions client, `normalizeProviderResponse`, the
 * session's provider response interceptor for a served request, and the
 * transport's retained-header allowlist feeding `#handleRetryableError` for the
 * 429/503 rejections that never reach that interceptor.
 *
 * The harness (models.yml fixture, real `ModelRegistry` with
 * `automaticRefresh: false`, `SessionManager.create(tempDir, tempDir)`) mirrors
 * `gateway-session-headers.test.ts`. Handing the session manager an explicit
 * project directory is what keeps the managed session scope inside the fixture:
 * setting the process-wide project dir instead routes it through the macOS
 * `/private`-stripping in `standardizeMacOSPath`, and the resulting path no
 * longer matches the realpath roots the test deletion guard allows.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@vib-rato/agent-core";
import { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import { Settings } from "@vib-rato/coding-agent/config/settings";
import { AgentSession } from "@vib-rato/coding-agent/session/agent-session";
import { AuthStorage } from "@vib-rato/coding-agent/session/auth-storage";
import { fingerprintCredential } from "@vib-rato/coding-agent/session/gateway-quota-observer";
import { SessionManager } from "@vib-rato/coding-agent/session/session-manager";
import { Snowflake } from "@vib-rato/utils";

const originalFetch = global.fetch;
const API_KEY_ENV = "VIB_TEST_GATEWAY_QUOTA_API_KEY";
const API_KEY = "gateway-quota-test-secret";

beforeEach(() => {
	process.env[API_KEY_ENV] = API_KEY;
});

afterEach(() => {
	global.fetch = originalFetch;
	delete process.env[API_KEY_ENV];
});

function gatewayModelsYaml(): string {
	return (
		"providers:\n" +
		"  usage-gateway:\n" +
		"    baseUrl: https://usage-gateway.example.com/v1\n" +
		`    apiKeyEnv: ${API_KEY_ENV}\n` +
		"    api: openai-completions\n" +
		"    models:\n" +
		"      - id: relay-model\n" +
		"        name: Relay Model\n" +
		"        contextWindow: 128000\n" +
		"        maxTokens: 8192\n"
	);
}

/** One scripted gateway reply: a served SSE turn, or an HTTP rejection. */
type Reply = { status: 200; headers: Record<string, string> } | { status: number; headers: Record<string, string> };

function sseBody(): string {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "chatcmpl-gateway-quota",
			object: "chat.completion.chunk",
			created: 0,
			model: "relay-model",
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return `data: ${chunk({ role: "assistant", content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`;
}

/**
 * Serve the scripted replies in order, repeating the last one. Every reply
 * carries its headers on a real `Response`, so the retained-header allowlist and
 * the response normalizer both run for real.
 */
function installFetch(replies: Reply[]): { calls: number } {
	const state = { calls: 0 };
	async function stub(): Promise<Response> {
		const reply = replies[Math.min(state.calls, replies.length - 1)];
		state.calls += 1;
		if (reply.status === 200) {
			return new Response(sseBody(), {
				status: 200,
				headers: { "content-type": "text/event-stream", ...reply.headers },
			});
		}
		return new Response(JSON.stringify({ error: { message: "gateway rejected the request" } }), {
			status: reply.status,
			headers: {
				"content-type": "application/json",
				// The OpenAI client retries 429/503 on its own, five times with
				// backoff, which would both outrun the test timeout and let a
				// retry consume the next scripted reply. `x-should-retry` is the
				// SDK's own opt-out, so the scripted rejection is what the turn
				// actually ends on.
				"x-should-retry": "false",
				...reply.headers,
			},
		});
	}
	global.fetch = Object.assign(stub, { preconnect: originalFetch.preconnect }) as unknown as typeof fetch;
	return state;
}

async function buildSession(tempDir: string): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const modelsPath = path.join(tempDir, "models.yml");
	await fs.writeFile(modelsPath, gatewayModelsYaml(), "utf8");

	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	// automaticRefresh: false — keep the background signed-preset-registry fetch
	// from racing the fetch stub.
	const modelRegistry = new ModelRegistry(authStorage, modelsPath, undefined, { automaticRefresh: false });
	const model = modelRegistry.find("usage-gateway", "relay-model");
	if (!model) throw new Error("gateway fixture model not found in ModelRegistry after loading models.yml");

	const agent = new Agent({
		getApiKey: provider => modelRegistry.getApiKeyForProvider(provider),
		initialState: { model, systemPrompt: ["Be extremely concise."], tools: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(tempDir, tempDir),
		// `retry.requestMaxRetries: 0` matters as much as the session-level
		// switch: without it the provider client retries a 429/503 itself, the
		// next scripted reply is consumed by that retry, and the rejection under
		// test is never the turn's outcome.
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"retry.requestMaxRetries": 0,
		}),
		modelRegistry,
	});
	session.subscribe(() => {});
	return { session, authStorage };
}

async function withGatewaySession(prefix: string, run: (session: AgentSession) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `vib-gw-quota-${prefix}-${Snowflake.next()}-`));
	try {
		const { session, authStorage } = await buildSession(tempDir);
		try {
			await run(session);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

/** Drive one turn and let the credential-resolving fold settle. */
async function turn(session: AgentSession, prompt: string): Promise<void> {
	await session.prompt(prompt);
	await session.agent.waitForIdle();
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await Bun.sleep(1);
}

describe("gateway quota across a prompt", () => {
	it("observes the window budget from a served turn", async () => {
		await withGatewaySession("served", async session => {
			installFetch([{ status: 200, headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "600" } }]);

			await turn(session, "ask the gateway");

			expect(session.gatewayQuotaState).toMatchObject({ limit: 1000, remaining: 600 });
			expect(session.gatewayQuotaState?.key).toMatchObject({
				provider: "usage-gateway",
				baseUrl: "https://usage-gateway.example.com/v1",
				credentialId: fingerprintCredential(API_KEY, session.credentialSessionId),
				sessionId: session.sessionId,
			});
		});
	});

	it("reads the reset instant and the last queue wait off a served turn", async () => {
		await withGatewaySession("reset", async session => {
			const resetAt = Date.now() + 90 * 60_000;
			installFetch([
				{
					status: 200,
					headers: {
						"x-vug-daily-limit": "1000",
						"x-vug-daily-remaining": "250",
						"x-vug-daily-reset": String(Math.floor(resetAt / 1000)),
						"x-vug-queued-ms": "1250",
					},
				},
			]);

			await turn(session, "ask the gateway");

			expect(session.gatewayQuotaState?.resetAt).toBe(Math.floor(resetAt / 1000) * 1000);
			expect(session.gatewayQuotaState?.lastQueuedMs).toBe(1250);
		});
	});

	it("ignores a served turn that carries no gateway header", async () => {
		await withGatewaySession("plain", async session => {
			installFetch([{ status: 200, headers: {} }]);

			await turn(session, "ordinary provider");

			expect(session.gatewayQuotaState).toBeNull();
		});
	});

	it("observes a token-limit rejection end to end", async () => {
		await withGatewaySession("exhausted", async session => {
			installFetch([
				{
					status: 429,
					headers: { "x-vug-daily-limit": "1000", "x-vug-daily-used": "1000", "retry-after": "43200" },
				},
			]);

			await turn(session, "exhaust the token budget");

			expect(session.gatewayQuotaState?.exhausted).toMatchObject({ used: 1000, limit: 1000 });
		});
	});

	it("observes gateway congestion end to end", async () => {
		await withGatewaySession("busy", async session => {
			installFetch([
				{ status: 503, headers: { "x-vug-queue-depth": "9", "x-vug-inflight": "4", "retry-after": "5" } },
			]);

			await turn(session, "hit a congested gateway");

			expect(session.gatewayQuotaState?.busy).toMatchObject({ code: 503, queueDepth: 9, inflight: 4 });
		});
	});

	it("leaves no observation when a rejection carries only retry-after", async () => {
		await withGatewaySession("plain-503", async session => {
			installFetch([{ status: 503, headers: { "retry-after": "5" } }]);

			await turn(session, "ordinary congestion");

			expect(session.gatewayQuotaState).toBeNull();
		});
	});

	it("clears a limit-reached note once the gateway serves a later turn", async () => {
		await withGatewaySession("recover", async session => {
			installFetch([
				{ status: 429, headers: { "x-vug-daily-limit": "1000", "x-vug-daily-used": "1000" } },
				{ status: 200, headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "1000" } },
			]);

			await turn(session, "hit the token limit");
			expect(session.gatewayQuotaState?.exhausted).toMatchObject({ used: 1000, limit: 1000 });

			await turn(session, "try again after the reset");

			expect(session.gatewayQuotaState?.exhausted).toBeUndefined();
			expect(session.gatewayQuotaState?.remaining).toBe(1000);
		});
	});

	it("never writes the observation or the credential into the transcript", async () => {
		await withGatewaySession("transcript", async session => {
			installFetch([{ status: 200, headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "600" } }]);

			await turn(session, "ask the gateway");
			const dumped = JSON.stringify(session.messages);

			expect(session.gatewayQuotaState?.remaining).toBe(600);
			// Header names and the credential, not the bare number: a millisecond
			// timestamp contains almost any short digit run by chance.
			expect(dumped).not.toContain("x-vug");
			expect(dumped).not.toContain(API_KEY);
			expect(dumped).not.toContain("daily-remaining");
		});
	});
});
