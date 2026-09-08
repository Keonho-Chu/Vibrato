/**
 * The `fallback` exhaustion notice carries its structure alongside the string.
 *
 * `Model fallback chain exhausted; models tried: …` is a stable contract: the
 * SDK, ACP, print mode and the session's own retry admission all match on it, so
 * it is emitted unchanged. The interactive TUI needs the same facts in a form it
 * can lay out, so the notice now also carries `fallbackExhaustion`.
 *
 * What is asserted: the string is byte-for-byte what it always was, the
 * structure describes the SAME attempts and skips, `formatFallbackExhaustionMessage`
 * rebuilds the string from the structure (so the two cannot drift), and the
 * quota flag plus the reset instant come from real session state rather than
 * from parsing any prose.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentOptions } from "@vib-rato/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@vib-rato/ai";
import { AssistantMessageEventStream } from "@vib-rato/ai/utils/event-stream";
import { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import { Settings } from "@vib-rato/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@vib-rato/coding-agent/session/agent-session";
import { AuthStorage } from "@vib-rato/coding-agent/session/auth-storage";
import {
	FALLBACK_EXHAUSTION_MESSAGE_PREFIX,
	formatFallbackExhaustionMessage,
} from "@vib-rato/coding-agent/session/fallback-exhaustion";
import { SessionManager } from "@vib-rato/coding-agent/session/session-manager";
import { TempDir } from "@vib-rato/utils";

type NoticeEvent = Extract<AgentSessionEvent, { type: "notice" }>;

/** A hold measured in hours, expressed the way the gateway sends it. */
const QUOTA_RETRY_AFTER_SECONDS = 43_200;
const QUOTA_ERROR_MESSAGE = "Token allowance exhausted for this key";

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function errorStream(
	model: Model,
	errorMessage: string,
	errorStatus: number,
	transportFailure: AssistantMessage["transportFailure"],
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage,
			errorStatus,
			timestamp: Date.now(),
			transportFailure,
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

/** 429 with the gateway's token-limit code and a multi-hour Retry-After. */
function quotaStream(model: Model): AssistantMessageEventStream {
	return errorStream(model, QUOTA_ERROR_MESSAGE, 429, {
		kind: "transport",
		status: 429,
		providerCode: "daily_token_limit",
		headers: { "retry-after": String(QUOTA_RETRY_AFTER_SECONDS) },
	});
}

/** 500, so the chain exhausts for a reason that is NOT a spent allowance. */
function serverErrorStream(model: Model): AssistantMessageEventStream {
	return errorStream(model, "upstream exploded", 500, { kind: "transport", status: 500 });
}

/**
 * A bare 429: rate-limit class, and deliberately NO `retry-after`.
 *
 * Without that header nothing suppresses a selector, so the registry scan finds
 * no reset instant. The credential pool still records one when it runs out, and
 * that instant is stamped onto the message — which is exactly the case where a
 * renderer reading only the suppression window would show less than the line.
 */
function bareRateLimitStream(model: Model): AssistantMessageEventStream {
	return errorStream(model, "too many requests", 429, { kind: "transport", status: 429 });
}

describe("fallback exhaustion notice structure", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	const fallback = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!primary || !fallback) throw new Error("Expected bundled Anthropic test models");

	beforeEach(async () => {
		tempDir = TempDir.createSync("@fallback-exhaustion-notice-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		chain: readonly Model[],
		streamFn: AgentOptions["streamFn"],
		settingsOverrides: Record<string, unknown> = {},
	): AgentSession {
		const head = chain[0];
		if (!head) throw new Error("Expected at least one chain entry");
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: head, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, ...settingsOverrides });
		settings.setModelRole("default", selector(head));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setConfiguredModelChain("default", chain.map(selector), "test");
		return session;
	}

	function collectFallbackNotices(live: AgentSession): NoticeEvent[] {
		const notices: NoticeEvent[] = [];
		live.subscribe(event => {
			if (event.type === "notice" && event.source === "fallback") notices.push(event);
		});
		return notices;
	}

	it("emits the unchanged string and the same facts as structure for a spent allowance", async () => {
		await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
		const live = createSession([primary, fallback], model => quotaStream(model));
		const notices = collectFallbackNotices(live);
		const before = Date.now();

		await live.prompt("token limit reached on every chain entry");
		await live.waitForIdle();

		expect(notices).toHaveLength(1);
		const notice = notices[0];
		if (!notice) throw new Error("Expected one fallback notice");

		// The contract other surfaces match on is untouched.
		expect(notice.message.startsWith(FALLBACK_EXHAUSTION_MESSAGE_PREFIX)).toBe(true);
		expect(notice.message).toContain(`models tried: ${selector(primary)} (`);
		expect(notice.message).toContain(selector(fallback));

		const details = notice.fallbackExhaustion;
		if (!details) throw new Error("Expected the notice to carry fallbackExhaustion");

		// Same attempts, in the same order, with the machine code alongside the raw text.
		expect(details.tried.map(entry => entry.selector)).toEqual([selector(primary), selector(fallback)]);
		expect(details.tried.every(entry => entry.triggerClass === "quota")).toBe(true);
		expect(details.tried.every(entry => entry.reason.includes(QUOTA_ERROR_MESSAGE))).toBe(true);
		expect(details.quota).toBe(true);

		// The string is rebuildable from the structure, so the two cannot drift.
		expect(notice.message.startsWith(formatFallbackExhaustionMessage(details))).toBe(true);

		// The reset instant comes from the recorded suppression window, not from prose.
		const holdMs = QUOTA_RETRY_AFTER_SECONDS * 1000;
		expect(details.resetAtMs).toBeGreaterThanOrEqual(before + holdMs);
		expect(details.resetAtMs).toBeLessThanOrEqual(Date.now() + holdMs);
		expect(details.resetAtMs).toBe(modelRegistry.getSelectorSuppressionUntil(selector(primary)));
	});

	it("reports quota false and no reset instant when the chain exhausts on server errors", async () => {
		await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
		const live = createSession([primary, fallback], model => serverErrorStream(model), {
			"fallback.maxAttempts": 1,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 1,
		});
		const notices = collectFallbackNotices(live);

		await live.prompt("every chain entry fails with a server error");
		await live.waitForIdle();

		expect(notices).toHaveLength(1);
		const details = notices[0]?.fallbackExhaustion;
		if (!details) throw new Error("Expected the notice to carry fallbackExhaustion");

		expect(details.tried.map(entry => entry.selector)).toEqual([selector(primary), selector(fallback)]);
		expect(details.tried.every(entry => entry.triggerClass === "server")).toBe(true);
		expect(details.quota).toBe(false);
		expect(details.resetAtMs).toBeUndefined();
		expect(notices[0]?.message.startsWith(formatFallbackExhaustionMessage(details))).toBe(true);
	});

	it("leaves the machine-readable message identical to what the structure rebuilds", async () => {
		await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
		const live = createSession([primary, fallback], model => serverErrorStream(model), {
			"fallback.maxAttempts": 1,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 1,
		});
		const notices = collectFallbackNotices(live);

		await live.prompt("exhaust the chain");
		await live.waitForIdle();

		const notice = notices[0];
		if (!notice?.fallbackExhaustion) throw new Error("Expected one structured fallback notice");
		expect(notice.message).toBe(formatFallbackExhaustionMessage(notice.fallbackExhaustion));

		// Comparing against the producer proves the two agree but not WHAT they
		// say, so the contract is also pinned to a literal here — both halves,
		// including `models skipped:`, which out-of-process consumers parse.
		expect(notice.message).toBe(
			"Model fallback chain exhausted; " +
				`models tried: ${selector(primary)} (upstream exploded), ${selector(fallback)} (upstream exploded); ` +
				"models skipped: none",
		);
	});

	it("carries a reset instant the message names but no suppression recorded", async () => {
		await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
		const live = createSession([primary, fallback], model => bareRateLimitStream(model), {
			"fallback.maxAttempts": 1,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 1,
		});
		const notices = collectFallbackNotices(live);

		await live.prompt("exhaust the credential pool on a bare 429");
		await live.waitForIdle();

		const notice = notices[0];
		if (!notice?.fallbackExhaustion) throw new Error("Expected one structured fallback notice");

		// Nothing suppressed a selector, so this is the instant the credential
		// pool contributed and the message stamped.
		for (const failure of notice.fallbackExhaustion.tried) {
			expect(modelRegistry.getSelectorSuppressionUntil(failure.selector)).toBeUndefined();
		}
		const stamped = /retryable at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(notice.message);
		if (!stamped?.[1]) throw new Error(`Expected a retryable-at stamp in: ${notice.message}`);

		// The regression: the block renders only the structure, so a structure
		// without this instant would silently drop a reset time the one-line
		// message states.
		expect(notice.fallbackExhaustion.resetAtMs).toBe(Date.parse(stamped[1]));
	});

	it("names a skipped entry in both halves of the literal contract string", async () => {
		await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
		// `unknown/not-a-model` cannot resolve, so the chain records it as a SKIP
		// rather than an attempt: this is the shape that exercises the second half.
		const live = createSession([primary, fallback], model => serverErrorStream(model), {
			"fallback.maxAttempts": 1,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 1,
		});
		live.setConfiguredModelChain("default", [selector(primary), "unknown/not-a-model", selector(fallback)], "test");
		const notices = collectFallbackNotices(live);

		await live.prompt("skip the middle entry");
		await live.waitForIdle();

		const notice = notices[0];
		if (!notice?.fallbackExhaustion) throw new Error("Expected one structured fallback notice");
		expect(notice.fallbackExhaustion.skipped).toEqual([{ selector: "unknown/not-a-model", reason: "unknown_model" }]);
		expect(notice.message).toBe(
			"Model fallback chain exhausted; " +
				`models tried: ${selector(primary)} (upstream exploded), ${selector(fallback)} (upstream exploded); ` +
				"models skipped: unknown/not-a-model (unknown_model)",
		);
		expect(notice.message).toBe(formatFallbackExhaustionMessage(notice.fallbackExhaustion));
	});
});
