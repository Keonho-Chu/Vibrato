/**
 * Client-side regression for the LIG usage gateway (VUG) contract — Vibrato#16.
 *
 * Every case here drives the real client path: a `models.yml` provider parsed by
 * the real `ModelRegistry`, the real `openai-models-list` discovery lane, the
 * real credential lookup, and the real `openai-completions` stream adapter from
 * `packages/ai` over a loopback socket. The only stand-in is the server, which is
 * the fake gateway fixture next door; its header banner lists exactly what it
 * does and does not mimic.
 *
 * Cases that depend on in-flight work are `it.todo` with the blocking issue named.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type Context,
	clampThinkingLevelForModel,
	classifyFallbackTrigger,
	type Effort,
	getSupportedEfforts,
	type Model,
	type OpenAICompat,
	type ProviderResponseMetadata,
	streamSimple,
} from "@vib-rato/ai/core";
import { getAgentDbPath, getAgentDir, setAgentDir } from "@vib-rato/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";
import { type FakeGateway, startFakeGateway } from "./fixtures/fake-gateway";

const KEY_ENV = "VIB_GATEWAY_LOOPBACK_KEY";
const GOOD_KEY = "vug-loopback-good-key";
const MODEL_ID = "VIB";

/** The hint the gateway attaches to its vLLM model on `GET /v1/models`. */
const VIB_HINT = {
	reasoning: true,
	thinking: {
		minLevel: "low",
		maxLevel: "xhigh",
		levels: ["low", "medium", "xhigh"],
		defaultLevel: "medium",
		mode: "effort",
	},
	compat: { supportsReasoningEffort: true, reasoningContentField: "reasoning" },
};

const MODELS_LIST_ENTRY = { id: MODEL_ID, max_model_len: 212_144, vibrato: VIB_HINT };

const originalAgentDir = getAgentDir();
let tempRoot: string | undefined;
let gateway: FakeGateway | undefined;
let authStorage: AuthStorage | undefined;
let registry: ModelRegistry | undefined;

interface HarnessOptions {
	sendSessionHeaders?: boolean;
}

/**
 * Writes a gateway-shaped `models.yml`, discovers against the live fixture, and
 * returns the discovered model plus the credential the registry resolved for it.
 */
async function connect(options: HarnessOptions = {}): Promise<{ model: Model<Api>; apiKey: string }> {
	if (!gateway) throw new Error("gateway not started");
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-gateway-loopback-"));
	const agentDir = path.join(tempRoot, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	setAgentDir(agentDir);
	process.env[KEY_ENV] = GOOD_KEY;

	const compatBlock =
		options.sendSessionHeaders === undefined
			? ""
			: `    compat:\n      sendSessionHeaders: ${options.sendSessionHeaders}\n`;
	const modelsPath = path.join(agentDir, "models.yml");
	await fs.writeFile(
		modelsPath,
		`providers:
  local:
    baseUrl: ${gateway.url}
    api: openai-completions
    apiKeyEnv: ${KEY_ENV}
${compatBlock}    discovery:
      type: openai-models-list
`,
		{ mode: 0o600 },
	);

	authStorage = await AuthStorage.create(getAgentDbPath());
	registry = new ModelRegistry(authStorage, modelsPath);
	await registry.refreshProvider("local");
	const model = registry.find("local", MODEL_ID);
	if (!model) throw new Error("gateway model was not discovered");
	const apiKey = await registry.getApiKey(model);
	if (!apiKey) throw new Error("registry resolved no credential for the gateway provider");
	return { model, apiKey };
}

function userContext(text = "hello"): Context {
	return { messages: [{ role: "user", content: text, timestamp: Date.now() }] };
}

const compatOf = (model: Model<Api>): OpenAICompat | undefined => model.compat as OpenAICompat | undefined;

const chatRecords = () => gateway!.recordsFor("/v1/chat/completions");
const lastChat = () => chatRecords().at(-1)!;

beforeEach(async () => {
	resetSettingsForTest();
	gateway = await startFakeGateway({ keys: [GOOD_KEY], models: [MODELS_LIST_ENTRY] });
});

afterEach(async () => {
	resetSettingsForTest();
	setAgentDir(originalAgentDir);
	delete process.env[KEY_ENV];
	authStorage?.close();
	authStorage = undefined;
	registry = undefined;
	await gateway?.stop();
	gateway = undefined;
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

describe("gateway loopback: /v1/models discovery", () => {
	it("reads the operator hint off the gateway's own models list", async () => {
		const { model } = await connect();
		expect(model.reasoning).toBe(true);
		expect(getSupportedEfforts(model)).toEqual(["low", "medium", "xhigh"] as Effort[]);
		expect(String(model.thinking?.defaultLevel)).toBe("medium");
		expect(compatOf(model)?.supportsReasoningEffort).toBe(true);
		expect(compatOf(model)?.reasoningContentField).toBe("reasoning");
		expect(model.contextWindow).toBe(212_144);
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe(gateway!.url);
	});

	it("authenticates the models list and does not meter it", async () => {
		await connect();
		const listed = gateway!.recordsFor("/v1/models");
		expect(listed).toHaveLength(1);
		expect(listed[0].headers.authorization).toBe(`Bearer ${GOOD_KEY}`);
		expect(listed[0].counted).toBe(false);
		expect(gateway!.dailyUsed).toBe(0);
	});
});

describe("gateway loopback: explicit openai-completions contract", () => {
	it("streams over /v1/chat/completions and never probes another wire API", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({
			kind: "stream",
			stream: { reasoning: ["thinking"], text: ["hello", " world"], usage: { input: 60, output: 10 } },
		});

		const result = await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();

		expect(result.stopReason).toBe("stop");
		expect(
			result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join(""),
		).toBe("hello world");
		expect(result.content.some(block => block.type === "thinking")).toBe(true);
		expect(chatRecords()).toHaveLength(1);
		expect(gateway!.recordsFor("/v1/responses")).toHaveLength(0);
		expect(gateway!.recordsFor("/v1/messages")).toHaveLength(0);
		const sent = lastChat().body!;
		expect(sent.model).toBe(MODEL_ID);
		expect(sent.stream).toBe(true);
		expect(sent.stream_options).toEqual({ include_usage: true });
	});

	it("carries a tool call and its arguments back through the adapter", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({
			kind: "stream",
			stream: {
				toolCall: { id: "call_1", name: "read", argumentsJson: '{"path":"README.md"}' },
				usage: { input: 60, output: 10 },
			},
		});

		const result = await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();

		const call = result.content.find(block => block.type === "toolCall");
		expect(call?.type).toBe("toolCall");
		if (call?.type !== "toolCall") throw new Error("no tool call in the assistant message");
		expect(call.name).toBe("read");
		expect(call.arguments).toEqual({ path: "README.md" });
		expect(result.stopReason).toBe("toolUse");
	});

	it("transfers reasoning_effort for an advertised level", async () => {
		const { model, apiKey } = await connect();
		await streamSimple(model, userContext(), {
			apiKey,
			requestMaxRetries: 0,
			reasoning: "medium" as Effort,
		}).result();
		expect(lastChat().body?.reasoning_effort).toBe("medium");
	});

	it("clamps an effort the gateway never advertised down to the nearest advertised one", async () => {
		const { model, apiKey } = await connect();
		// `high` is absent from the hint's level set; the core clamp picks `medium`.
		const clamped = clampThinkingLevelForModel(model, "high" as Effort);
		expect(String(clamped)).toBe("medium");

		await streamSimple(model, userContext(), {
			apiKey,
			requestMaxRetries: 0,
			reasoning: clamped as Effort,
		}).result();
		expect(lastChat().body?.reasoning_effort).toBe("medium");
	});

	it("agrees with the gateway's metered row on the final usage chunk", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({ kind: "stream", stream: { text: ["ok"], usage: { input: 60, output: 10 } } });

		const result = await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();

		expect(result.usage.input).toBe(60);
		expect(result.usage.output).toBe(10);
		// `ok` is produced only by the fixture's metering path, never by default.
		expect(lastChat().outcome).toBe("ok");
		expect(lastChat().accounted).toEqual({ input: 60, output: 10 });
		expect(gateway!.dailyUsed).toBe(70);
	});
});

describe("gateway loopback: credentials", () => {
	it("stops a wrong key at the gateway and recovers after a key switch", async () => {
		// The catalog was discovered while the key still worked; the key that
		// signs the request is the one that has since gone stale.
		const { model } = await connect();
		process.env[KEY_ENV] = "wrong-key";

		let rotated: string | undefined;
		const result = await streamSimple(model, userContext(), {
			apiKey: "wrong-key",
			requestMaxRetries: 0,
			onAuthError: async (_provider, oldKey) => {
				rotated = oldKey;
				process.env[KEY_ENV] = GOOD_KEY;
				// The rotated credential comes back through the real registry lookup.
				return registry!.getApiKey(model);
			},
		}).result();

		expect(rotated).toBe("wrong-key");
		expect(result.stopReason).toBe("stop");
		const chats = chatRecords();
		expect(chats).toHaveLength(2);
		expect(chats[0].outcome).toBe("unauthorized");
		// The rejected key never produced upstream work.
		expect(chats[0].reachedUpstream).toBe(false);
		expect(chats[1].outcome).toBe("ok");
		expect(chats[1].reachedUpstream).toBe(true);
		expect(gateway!.upstreamCalls).toBe(1);
		expect(gateway!.dailyUsed).toBe(70);
	});

	it("presents the key only as a bearer header, never in the request body", async () => {
		const { model, apiKey } = await connect();
		await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();
		expect(lastChat().headers.authorization).toBe(`Bearer ${GOOD_KEY}`);
		expect(JSON.stringify(lastChat().body)).not.toContain(GOOD_KEY);
	});
});

describe("gateway loopback: session recording", () => {
	it("files the request under the real session id when sendSessionHeaders is on", async () => {
		const { model, apiKey } = await connect({ sendSessionHeaders: true });
		await streamSimple(model, userContext(), {
			apiKey,
			requestMaxRetries: 0,
			sessionId: "session-abc",
		}).result();

		expect(lastChat().headers["x-session-id"]).toBe("session-abc");
		expect(lastChat().sessionId).toBe("session-abc");
	});

	it("files the request under no-session when the opt-in is absent", async () => {
		const { model, apiKey } = await connect();
		await streamSimple(model, userContext(), {
			apiKey,
			requestMaxRetries: 0,
			sessionId: "session-abc",
		}).result();

		expect(lastChat().headers["x-session-id"]).toBeUndefined();
		expect(lastChat().sessionId).toBe("no-session");
	});

	it("files the request under no-session when the opt-in is explicitly off", async () => {
		const { model, apiKey } = await connect({ sendSessionHeaders: false });
		await streamSimple(model, userContext(), {
			apiKey,
			requestMaxRetries: 0,
			sessionId: "session-abc",
		}).result();
		expect(lastChat().sessionId).toBe("no-session");
	});
});

describe("gateway loopback: cancellation", () => {
	it("releases the gateway slot when the client aborts mid-stream", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({
			kind: "stream",
			stream: {
				text: ["one", "two", "three", "four"],
				usage: { input: 60, output: 10 },
				chunkDelayMs: 5,
				holdAfterChunks: 2,
			},
		});

		const controller = new AbortController();
		const stream = streamSimple(model, userContext(), {
			apiKey,
			requestMaxRetries: 0,
			signal: controller.signal,
		});
		// Abort once the stream is genuinely open, not before the request left.
		for await (const event of stream) {
			if (event.type === "text_delta" || event.type === "text_start") {
				controller.abort();
				break;
			}
		}

		const deadline = Date.now() + 5_000;
		while (gateway!.inflight !== 0 && Date.now() < deadline) await Bun.sleep(10);

		expect(gateway!.inflight).toBe(0);
		expect(lastChat().outcome).toBe("aborted");
		// The upstream really started, and really stopped before the fourth delta.
		expect(lastChat().upstreamChunks).toBeGreaterThanOrEqual(1);
		expect(lastChat().upstreamChunks).toBeLessThan(4);
		// An aborted call is not metered.
		expect(lastChat().accounted).toBeUndefined();
		expect(gateway!.dailyUsed).toBe(0);
	});
});

describe("gateway loopback: quota and congestion facts", () => {
	it("delivers the three daily headers and the queue headers to onResponse", async () => {
		await gateway!.stop();
		gateway = await startFakeGateway({
			keys: [GOOD_KEY],
			models: [MODELS_LIST_ENTRY],
			dailyLimit: 5_000,
			dailyUsed: 1_000,
			queueDepth: 2,
			queuedMs: 37,
		});
		const { model, apiKey } = await connect();

		const seen: ProviderResponseMetadata[] = [];
		await streamSimple(model, userContext(), {
			apiKey,
			requestMaxRetries: 0,
			onResponse: response => {
				seen.push(response);
			},
		}).result();

		expect(seen).toHaveLength(1);
		const headers = seen[0].headers;
		expect(headers["x-vug-daily-limit"]).toBe("5000");
		expect(headers["x-vug-daily-used"]).toBe("1000");
		// Observed at admission: this call's own 70 tokens are not subtracted yet.
		expect(headers["x-vug-daily-remaining"]).toBe("4000");
		expect(headers["x-vug-queue-depth"]).toBe("2");
		expect(headers["x-vug-queued-ms"]).toBe("37");
		expect(headers["x-vug-inflight"]).toBeDefined();
		// No reset header is configured, and the client must not invent one.
		expect(headers["x-vug-daily-reset"]).toBeUndefined();
	});

	it("classifies a daily_token_limit 429 the way dev classifies it today", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({ kind: "daily_token_limit" });

		const result = await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();

		expect(lastChat().outcome).toBe("daily_token_limit");
		// The rejection is an admission decision: no upstream work was done.
		expect(gateway!.upstreamCalls).toBe(0);
		expect(result.transportFailure?.status).toBe(429);
		expect(result.transportFailure?.providerCode).toBe("daily_token_limit");
		// Today `daily_token_limit` is not a quota code, so a daily limit reads as
		// an ordinary 12-hour rate limit. #12 turns this into `quota`.
		expect(classifyFallbackTrigger(result.transportFailure)).toEqual({
			class: "rate_limit",
			retryAfterMs: 43_200_000,
		});
		// Facts keep only the retry allowlist; the daily headers are dropped today.
		expect(result.transportFailure?.headers).toEqual({ "retry-after": "43200" });
		expect(() => structuredClone(result.transportFailure)).not.toThrow();
	});

	it("classifies a queue_timeout 503 as a server failure with the gateway's own code", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({ kind: "queue_timeout" });

		const result = await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();

		expect(lastChat().outcome).toBe("queue_timeout");
		expect(gateway!.upstreamCalls).toBe(0);
		expect(result.transportFailure?.status).toBe(503);
		expect(result.transportFailure?.providerCode).toBe("queue_timeout");
		expect(classifyFallbackTrigger(result.transportFailure)).toEqual({ class: "server", retryAfterMs: 5_000 });
	});

	it("classifies a queue_full 503 the same way, distinguished only by the code", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({ kind: "queue_full" });

		const result = await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();

		expect(lastChat().outcome).toBe("queue_full");
		expect(result.transportFailure?.status).toBe(503);
		expect(result.transportFailure?.openaiErrorCode).toBe("queue_full");
		expect(classifyFallbackTrigger(result.transportFailure)).toEqual({ class: "server", retryAfterMs: 5_000 });
	});

	// The remaining checklist items in #16 need work that is not on dev yet.
	// Each body asserts the target behaviour, so `bun test --todo` reports these
	// as still pending rather than as unexpectedly passing, and the day the
	// dependency lands the fix is to delete `.todo`.
	it.todo("retains x-vug-daily-* on transport facts and classifies daily_token_limit as quota: waits for #12", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({ kind: "daily_token_limit" });
		const result = await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();
		expect(classifyFallbackTrigger(result.transportFailure).class).toBe("quota");
		expect(result.transportFailure?.headers).toMatchObject({
			"x-vug-daily-limit": expect.any(String),
			"x-vug-daily-used": expect.any(String),
			"x-vug-daily-remaining": expect.any(String),
		});
	});

	it.todo("retains x-vug-queue-depth/inflight on 503 transport facts: waits for #12", async () => {
		const { model, apiKey } = await connect();
		gateway!.scriptChat({ kind: "queue_timeout" });
		const result = await streamSimple(model, userContext(), { apiKey, requestMaxRetries: 0 }).result();
		expect(result.transportFailure?.headers).toMatchObject({
			"x-vug-queue-depth": expect.any(String),
			"x-vug-inflight": expect.any(String),
		});
	});

	it.todo("updates the gateway quota observer from success and failure headers: waits for #13", () => {
		// #13 adds the observer that reads x-vug-daily-* off onResponse and off
		// the #12 failure facts. There is no such module on dev to import yet, so
		// this body cannot be written against a real API.
		throw new Error("no gateway quota observer exists on dev yet; see #13");
	});
});

describe("fake-gateway self-check: /v1/responses passthrough", () => {
	// NOT client coverage. This case exercises no vib code at all: it drives the
	// fixture with a plain request and asserts the fixture's own accounting.
	//
	// It is here because the fixture has to reproduce the shape #8 §5 recorded —
	// a non-captured path answering 200 with a usage block while the gateway's
	// token total does not move — and that property is what the client-facing
	// cases above rely on when they assert nothing but `/v1/chat/completions` is
	// ever metered. The client holds an explicit `openai-completions` contract
	// for this provider and has no path that emits a Responses request, so there
	// is no client path to drive here. A 200 is not evidence that the Responses
	// wire API is supported.
	it("fixture: answers 200 with usage yet adds nothing to the daily total", async () => {
		await connect();
		const before = gateway!.dailyUsed;

		const response = await fetch(`${gateway!.url}/responses`, {
			method: "POST",
			headers: { authorization: `Bearer ${GOOD_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({ model: MODEL_ID, input: "hello" }),
		});
		const payload = (await response.json()) as { usage: { total_tokens: number } };

		expect(response.status).toBe(200);
		expect(payload.usage.total_tokens).toBe(70);
		expect(gateway!.dailyUsed).toBe(before);
		expect(gateway!.recordsFor("/v1/responses")[0].counted).toBe(false);
	});
});
