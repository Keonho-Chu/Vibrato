/**
 * End-to-end regression test for issue #15 (items 1): a gateway-style
 * `models.yml` entry with `compat.sendSessionHeaders: true` must carry the
 * current AgentSession's session id on the wire as the `session_id` and
 * `x-session-id` request headers, through the real config-loading path
 * (models.yml -> ModelRegistry -> Model with merged compat) and the real
 * request path (Agent -> agent-loop -> streamSimple -> openai-completions
 * createClient), all the way to a stubbed `global.fetch`.
 *
 * A second fixture that omits the opt-in must send neither header, and the
 * headers must track a fresh session id after a session fork (`session.branch`).
 *
 * See `packages/ai/src/providers/openai-completions.ts` (~line 1304) for the
 * production header-injection site and `packages/ai/test/openai-completions-session-headers.test.ts`
 * for the lower-level wire-capture test this builds on.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@vib-rato/agent-core";
import type { OpenAICompat } from "@vib-rato/ai/core";
import { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import { Settings } from "@vib-rato/coding-agent/config/settings";
import { AgentSession } from "@vib-rato/coding-agent/session/agent-session";
import { AuthStorage } from "@vib-rato/coding-agent/session/auth-storage";
import { SessionManager } from "@vib-rato/coding-agent/session/session-manager";
import { Snowflake } from "@vib-rato/utils";

const originalFetch = global.fetch;
const API_KEY_ENV = "VIB_TEST_GATEWAY_API_KEY";

afterEach(() => {
	global.fetch = originalFetch;
});

beforeEach(() => {
	process.env[API_KEY_ENV] = "gateway-test-secret";
});

afterEach(() => {
	delete process.env[API_KEY_ENV];
});

// ── models.yml fixture: a gateway-style openai-completions provider ─────────

function gatewayModelsYaml(sendSessionHeaders: boolean): string {
	const compatBlock = sendSessionHeaders ? "    compat:\n      sendSessionHeaders: true\n" : "";
	return (
		"providers:\n" +
		"  usage-gateway:\n" +
		"    baseUrl: https://usage-gateway.example.com/v1\n" +
		`    apiKeyEnv: ${API_KEY_ENV}\n` +
		"    api: openai-completions\n" +
		compatBlock +
		"    models:\n" +
		"      - id: relay-model\n" +
		"        name: Relay Model\n" +
		"        contextWindow: 128000\n" +
		"        maxTokens: 8192\n"
	);
}

// ── Wire-capture fetch (same pattern as openai-completions-session-headers.test.ts) ──

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
}

function installCapturingFetch(captured: CapturedRequest[]): void {
	async function capturingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const headers: Record<string, string> = {};
		const merge = (h: ConstructorParameters<typeof Headers>[0] | undefined): void => {
			if (!h) return;
			new Headers(h).forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
		};
		if (input instanceof Request) merge(input.headers);
		merge(init?.headers);
		captured.push({
			url: input instanceof Request ? input.url : String(input),
			headers,
		});
		const payload = `data: ${JSON.stringify({
			id: "chatcmpl-gateway-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "relay-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		})}\n\ndata: ${JSON.stringify({
			id: "chatcmpl-gateway-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "relay-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\ndata: [DONE]\n\n`;
		return new Response(payload, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	global.fetch = Object.assign(capturingFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;
}

// ── Real config-loading + real AgentSession wiring ───────────────────────────

async function buildGatewaySession(
	tempDir: string,
	sendSessionHeaders: boolean,
): Promise<{ session: AgentSession; authStorage: AuthStorage; modelRegistry: ModelRegistry }> {
	const modelsPath = path.join(tempDir, "models.yml");
	await fs.writeFile(modelsPath, gatewayModelsYaml(sendSessionHeaders), "utf8");

	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	// automaticRefresh: false — this is a unit test, not a network smoke test;
	// avoid the background signed-preset-registry fetch racing our fetch stub.
	const modelRegistry = new ModelRegistry(authStorage, modelsPath, undefined, { automaticRefresh: false });

	const model = modelRegistry.find("usage-gateway", "relay-model");
	if (!model) throw new Error("gateway fixture model not found in ModelRegistry after loading models.yml");
	expect((model.compat as OpenAICompat | undefined)?.sendSessionHeaders).toBe(sendSessionHeaders || undefined);

	const agent = new Agent({
		getApiKey: provider => modelRegistry.getApiKeyForProvider(provider),
		initialState: {
			model,
			systemPrompt: ["Be extremely concise."],
			tools: [],
		},
	});

	const sessionManager = SessionManager.create(tempDir, tempDir);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
	});
	session.subscribe(() => {});

	return { session, authStorage, modelRegistry };
}

async function withTempDir<T>(prefix: string, run: (tempDir: string) => Promise<T>): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `vib-gw-session-headers-${prefix}-${Snowflake.next()}-`));
	try {
		return await run(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

describe("gateway session headers (coding-agent end-to-end)", () => {
	it("sends session_id and x-session-id headers matching the current session id when compat.sendSessionHeaders is on", async () => {
		await withTempDir("on", async tempDir => {
			const { session, authStorage } = await buildGatewaySession(tempDir, true);
			try {
				const captured: CapturedRequest[] = [];
				installCapturingFetch(captured);

				await session.prompt("hello");
				await session.agent.waitForIdle();

				expect(captured).toHaveLength(1);
				expect(captured[0].url).toBe("https://usage-gateway.example.com/v1/chat/completions");
				expect(captured[0].headers.session_id).toBe(session.sessionId);
				expect(captured[0].headers["x-session-id"]).toBe(session.sessionId);
			} finally {
				await session.dispose();
				authStorage.close();
			}
		});
	});

	it("sends neither header when the gateway fixture omits the sendSessionHeaders opt-in", async () => {
		await withTempDir("off", async tempDir => {
			const { session, authStorage } = await buildGatewaySession(tempDir, false);
			try {
				const captured: CapturedRequest[] = [];
				installCapturingFetch(captured);

				await session.prompt("hello");
				await session.agent.waitForIdle();

				expect(captured).toHaveLength(1);
				expect(captured[0].headers.session_id).toBeUndefined();
				expect(captured[0].headers["x-session-id"]).toBeUndefined();
			} finally {
				await session.dispose();
				authStorage.close();
			}
		});
	});

	it("sends the new session id after a session fork, not the pre-fork id", async () => {
		await withTempDir("fork", async tempDir => {
			const { session, authStorage } = await buildGatewaySession(tempDir, true);
			try {
				const captured: CapturedRequest[] = [];
				installCapturingFetch(captured);

				await session.prompt("first turn");
				await session.agent.waitForIdle();
				expect(captured).toHaveLength(1);
				const preForkSessionId = session.sessionId;
				expect(captured[0].headers["x-session-id"]).toBe(preForkSessionId);

				const userMessages = session.getUserMessagesForBranching();
				expect(userMessages.length).toBeGreaterThan(0);
				const branchResult = await session.branch(userMessages[0]!.entryId);
				expect(branchResult.cancelled).toBe(false);

				const postForkSessionId = session.sessionId;
				expect(postForkSessionId).not.toBe(preForkSessionId);

				await session.prompt("second turn, after fork");
				await session.agent.waitForIdle();

				expect(captured).toHaveLength(2);
				expect(captured[1].headers["x-session-id"]).toBe(postForkSessionId);
				expect(captured[1].headers.session_id).toBe(postForkSessionId);
				expect(captured[1].headers["x-session-id"]).not.toBe(preForkSessionId);
			} finally {
				await session.dispose();
				authStorage.close();
			}
		});
	});
});
