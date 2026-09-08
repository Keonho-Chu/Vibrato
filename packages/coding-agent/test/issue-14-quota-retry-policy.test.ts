import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentOptions } from "@vib-rato/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@vib-rato/ai";
import { AssistantMessageEventStream } from "@vib-rato/ai/utils/event-stream";
import { classifyFallbackTrigger } from "@vib-rato/ai/utils/fallback-transport";
import * as oauth from "@vib-rato/ai/utils/oauth";
import type { OAuthCredentials } from "@vib-rato/ai/utils/oauth/types";
import { ModelRegistry } from "@vib-rato/coding-agent/config/model-registry";
import { Settings } from "@vib-rato/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@vib-rato/coding-agent/session/agent-session";
import { AuthStorage } from "@vib-rato/coding-agent/session/auth-storage";
import { effectiveFallbackDelay } from "@vib-rato/coding-agent/session/fallback-chain-controller";
import { SessionManager } from "@vib-rato/coding-agent/session/session-manager";
import { TempDir } from "@vib-rato/utils";

/**
 * Issue #14 — token-limit retry, credential-rotation, and fallback policy.
 *
 * The scenario is a shared gateway (issue #8) that answers with 429 and a
 * Retry-After measured in hours once its quota window's allowance is spent.
 * The window length is operator-configured (`VUG_QUOTA_WINDOW_HOURS`, 24 by
 * default and 3 in production), so these tests assert on the shape of the
 * failure rather than on any particular window. Every test
 * here drives that with a fake transport and asserts on the number of upstream
 * requests, because "one more request" is the only observable form the forbidden
 * behaviors take: a same-model retry, or a retry carrying a different stored
 * credential for the same baseUrl.
 *
 * No test waits real time. The hold is asserted through the recorded
 * suppression window and the surfaced reset instant, never by sleeping.
 */

/** A hold measured in hours, expressed the way a gateway sends it: `retry-after` in seconds. */
const QUOTA_RETRY_AFTER_SECONDS = 43_200;
const QUOTA_RETRY_AFTER_MS = QUOTA_RETRY_AFTER_SECONDS * 1000;
const QUOTA_ERROR_MESSAGE = "Token allowance exhausted for this key";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;

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

/**
 * 429 + `insufficient_quota` + a multi-hour `retry-after`. `insufficient_quota`
 * is an existing quota code; issue #12 adds `daily_token_limit` to the same
 * class, so this scenario keeps holding once that lands. The wire contract
 * keeps its "daily" names even though the gateway's window is configurable.
 */
function quotaStream(model: Model): AssistantMessageEventStream {
	return errorStream(model, QUOTA_ERROR_MESSAGE, 429, {
		kind: "transport",
		status: 429,
		providerCode: "insufficient_quota",
		headers: { "retry-after": String(QUOTA_RETRY_AFTER_SECONDS) },
	});
}

function successStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected trailing assistant message");
	return message as AssistantMessage;
}

/** Stand-in for the reason the session records; the exact wording is asserted elsewhere. */
function describeHold(): string {
	return "token limit reached; resets at (expired)";
}

/** Assert the error names its reset instant once, and return that instant. */
function expectSingleRetryableAt(errorMessage: string): number {
	const matches = [...errorMessage.matchAll(/retryable at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/g)];
	expect(matches).toHaveLength(1);
	return Date.parse(matches[0]![1]!);
}

describe("issue #14 token-limit retry, rotation, and fallback policy", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	const fallback = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!primary || !fallback) throw new Error("Expected bundled Anthropic test models");

	beforeEach(async () => {
		tempDir = TempDir.createSync("@issue-14-quota-policy-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	/**
	 * One session over `chain`, with `streamFn` standing in for every upstream request.
	 *
	 * The base settings deliberately set NO `retry.*` key. Setting any of them
	 * makes `legacyRetryConfigured` true, which routes the failure past the
	 * bare-default admission gate — so a suite that always set a retry delay
	 * would never exercise the default configuration these policies exist for.
	 * Tests that want the legacy budget ask for it explicitly.
	 */
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
		const settings = Settings.isolated({
			"compaction.enabled": false,
			...settingsOverrides,
		});
		settings.setModelRole("default", selector(head));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setConfiguredModelChain("default", chain.map(selector), "test");
		return session;
	}

	describe("policy 1 — a long quota hold ends the turn instead of retrying the same model", () => {
		it("makes zero same-model retries even with a legacy retry budget configured", async () => {
			await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
			const calls: string[] = [];
			// `retry.maxRetries` is what makes this a regression test: with a legacy
			// budget configured, the quota failure used to be retried up to four
			// times, each after `retry.maxDelayMs` rather than the hours the gateway
			// asked for. The hold now ends the turn on the first failure.
			const live = createSession(
				[primary],
				model => {
					calls.push(selector(model));
					return quotaStream(model);
				},
				{ "retry.maxRetries": 3 },
			);

			const retryStarts: AutoRetryStartEvent[] = [];
			live.subscribe(event => {
				if (event.type === "auto_retry_start") retryStarts.push(event);
			});

			await live.prompt("token limit reached");
			await live.waitForIdle();

			expect(calls).toEqual([selector(primary)]);
			expect(retryStarts).toEqual([]);
			expect(lastAssistant(live).stopReason).toBe("error");
		});

		it("applies the whole policy in the DEFAULT configuration, with no retry.* key set", async () => {
			// The bare-default admission gate surfaces a content-free 429 immediately
			// and returns before the rest of `#handleRetryableError`. Everything this
			// issue adds therefore has to run above that gate, or it would never
			// reach the one deployment shape it was written for: a stock install
			// talking to one gateway.
			await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
			const calls: string[] = [];
			const before = Date.now();
			const live = createSession([primary], model => {
				calls.push(selector(model));
				return quotaStream(model);
			});

			await live.prompt("token limit reached on a stock install");
			await live.waitForIdle();
			const after = Date.now();

			expect(calls).toEqual([selector(primary)]);
			expect(modelRegistry.getSelectorSuppressionStatus(selector(primary))).toBe("active");
			expect(modelRegistry.getSelectorSuppressionReason(selector(primary))).toContain("token limit reached");
			const errorMessage = lastAssistant(live).errorMessage ?? "";
			expect(errorMessage).toContain(QUOTA_ERROR_MESSAGE);
			expect(errorMessage).toContain("token limit reached");
			const resetAtMs = expectSingleRetryableAt(errorMessage);
			expect(resetAtMs).toBeGreaterThanOrEqual(before + QUOTA_RETRY_AFTER_MS - 5_000);
			expect(resetAtMs).toBeLessThanOrEqual(after + QUOTA_RETRY_AFTER_MS + 5_000);
		});

		it("names the token limit and its reset instant exactly once on the surfaced error", async () => {
			await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
			const before = Date.now();
			const live = createSession([primary], model => quotaStream(model), { "retry.maxRetries": 3 });

			await live.prompt("token limit reached");
			await live.waitForIdle();
			const after = Date.now();

			const errorMessage = lastAssistant(live).errorMessage ?? "";
			expect(errorMessage).toContain(QUOTA_ERROR_MESSAGE);
			// The user must read "the limit is spent until <instant>", not a bare 429
			// that looks like a rejected key.
			expect(errorMessage).toContain("token limit reached");
			// The hold hint and the pre-existing retryable-at hint name the same
			// instant, so exactly one of them may land.
			const resetAtMs = expectSingleRetryableAt(errorMessage);
			expect(resetAtMs).toBeGreaterThanOrEqual(before + QUOTA_RETRY_AFTER_MS - 5_000);
			expect(resetAtMs).toBeLessThanOrEqual(after + QUOTA_RETRY_AFTER_MS + 5_000);
		});

		it("advances only to the next entry the user configured, one request per entry", async () => {
			await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
			const calls: string[] = [];
			// `fallback.maxAttempts: 3` is the budget the hold must NOT spend: three
			// requests per entry would be six upstream requests against a gateway
			// that already said the day is over.
			const live = createSession(
				[primary, fallback],
				model => {
					calls.push(selector(model));
					return quotaStream(model);
				},
				{ "fallback.maxAttempts": 3 },
			);

			await live.prompt("token limit reached on every chain entry");
			await live.waitForIdle();

			expect(calls).toEqual([selector(primary), selector(fallback)]);
			// Structural restatement of "never to a provider or endpoint the user did
			// not list": advance walks the configured chain and nothing else.
			const configured = new Set([selector(primary), selector(fallback)]);
			for (const call of calls) expect(configured.has(call)).toBe(true);
		});
	});

	describe("policy 2 — no credential rotation across the same gateway on a quota failure", () => {
		it("does not retry with the second stored credential of the same provider", async () => {
			// Two keys, one provider, therefore one baseUrl: rotating between them
			// retries the same gateway allowance under a different identity, which is
			// exactly the audit and quota bypass issue #8 forbids.
			await authStorage.set("anthropic", [
				{ type: "api_key", key: "gateway-key-1" },
				{ type: "api_key", key: "gateway-key-2" },
			]);
			const calls: string[] = [];
			const live = createSession([primary], model => {
				calls.push(selector(model));
				return quotaStream(model);
			});

			await live.prompt("token limit reached with two keys stored");
			await live.waitForIdle();

			expect(calls).toEqual([selector(primary)]);
		});

		it("keeps the SAME key on the next turn instead of rotating one turn later", async () => {
			// Declining to report a rotation is not enough on its own. Blocking the
			// failed row leaves it in place but makes API-key selection skip it, so
			// the next turn silently reaches the same gateway under the second key.
			// The stored row must therefore be left untouched entirely.
			await authStorage.set("anthropic", [
				{ type: "api_key", key: "gateway-key-1" },
				{ type: "api_key", key: "gateway-key-2" },
			]);
			const calls: string[] = [];
			const live = createSession([primary], model => {
				calls.push(selector(model));
				return quotaStream(model);
			});

			const keyBefore = await modelRegistry.getApiKey(primary, live.credentialSessionId);
			expect(keyBefore).toBeDefined();

			await live.prompt("token limit reached");
			await live.waitForIdle();
			const keyAfterFirstTurn = await modelRegistry.getApiKey(primary, live.credentialSessionId);

			await live.prompt("second turn on the same held gateway");
			await live.waitForIdle();
			const keyAfterSecondTurn = await modelRegistry.getApiKey(primary, live.credentialSessionId);

			expect(keyAfterFirstTurn).toBe(keyBefore);
			expect(keyAfterSecondTurn).toBe(keyBefore);
			// Two turns, one upstream request each, neither of them a rotation.
			expect(calls).toEqual([selector(primary), selector(primary)]);
			// Nothing was blocked, which is why the next turn could not be handed
			// to the second key. The OAuth test below is the deliberate contrast.
			expect(authStorage.getEarliestUnblockAt("anthropic", live.credentialSessionId)).toBeUndefined();
		});

		it("still reports the reset instant even though no credential row is blocked", async () => {
			// The reset instant used to be a side effect of blocking the row. It now
			// lives on the session, and this pins that the signal survived the move.
			await authStorage.set("anthropic", [
				{ type: "api_key", key: "gateway-key-1" },
				{ type: "api_key", key: "gateway-key-2" },
			]);
			const before = Date.now();
			const live = createSession([primary], model => quotaStream(model));

			await live.prompt("token limit reached");
			await live.waitForIdle();
			const after = Date.now();

			expect(authStorage.getEarliestUnblockAt("anthropic", live.credentialSessionId)).toBeUndefined();
			const resetAtMs = expectSingleRetryableAt(lastAssistant(live).errorMessage ?? "");
			expect(resetAtMs).toBeGreaterThanOrEqual(before + QUOTA_RETRY_AFTER_MS - 5_000);
			expect(resetAtMs).toBeLessThanOrEqual(after + QUOTA_RETRY_AFTER_MS + 5_000);
		});

		it("leaves an OAuth pool rotating on a usage limit, because those are separate quotas", async () => {
			// The hold is scoped to API-key pools, which all leave through one
			// provider baseUrl and are therefore one gateway identity. Several OAuth
			// rows are several subscription accounts the operator owns; their quotas
			// are separate and never traverse the gateway, so switching between them
			// is an existing feature rather than the bypass issue #8 forbids.
			const oauthTempDir = TempDir.createSync("@issue-14-oauth-pool-");
			// No ranking strategy, so `markUsageLimitReached` takes no usage-report
			// path and the test needs no network.
			const oauthStorage = await AuthStorage.create(path.join(oauthTempDir.path(), "auth.db"), {
				rankingStrategyResolver: () => undefined,
			});
			try {
				vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => credential);
				vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
					const credential = credentials.anthropic as OAuthCredentials | undefined;
					return credential
						? { apiKey: `oauth-key-${credential.accountId ?? "unknown"}`, newCredentials: credential }
						: null;
				});
				await oauthStorage.set("anthropic", [
					{
						type: "oauth",
						access: "access-1",
						refresh: "refresh-1",
						expires: Date.now() + 3_600_000,
						accountId: "acct-1",
					},
					{
						type: "oauth",
						access: "access-2",
						refresh: "refresh-2",
						expires: Date.now() + 3_600_000,
						accountId: "acct-2",
					},
				]);

				modelRegistry = new ModelRegistry(oauthStorage);
				const calls: string[] = [];
				const live = createSession([primary], model => {
					calls.push(selector(model));
					return quotaStream(model);
				});

				expect(await modelRegistry.getApiKey(primary, live.credentialSessionId)).toBeDefined();
				await live.prompt("subscription account hits its usage limit");
				await live.waitForIdle();

				// Rotation is what produces extra attempts on ONE model: the session
				// switched accounts and tried again, stopping only once the pool was
				// spent. The identical scenario on an API-key pool makes exactly one
				// request, which the two tests above assert.
				expect(calls).toEqual([selector(primary), selector(primary), selector(primary)]);
				// A row is blocked in storage, which is the `markUsageLimitReached`
				// path this scope deliberately leaves alone; the API-key pool blocks
				// nothing at all.
				expect(oauthStorage.getEarliestUnblockAt("anthropic", live.credentialSessionId)).toBeDefined();
			} finally {
				await session?.dispose();
				session = undefined;
				oauthStorage.close();
				oauthTempDir.removeSync();
			}
		});

		it("restores rotation only when the operator opts in explicitly", async () => {
			await authStorage.set("anthropic", [
				{ type: "api_key", key: "gateway-key-1" },
				{ type: "api_key", key: "gateway-key-2" },
			]);
			const calls: string[] = [];
			const live = createSession(
				[primary],
				model => {
					calls.push(selector(model));
					return quotaStream(model);
				},
				{ "retry.rotateCredentialsOnQuota": true },
			);

			await live.prompt("token limit reached with rotation opted in");
			await live.waitForIdle();

			// The second request is the rotated credential. It exists only because the
			// operator asked for it; the default above makes exactly one request.
			expect(calls.length).toBeGreaterThan(1);
			expect(new Set(calls)).toEqual(new Set([selector(primary)]));
		});
	});

	describe("policy 3 — the held selector is suppressed until reset, with a reason", () => {
		it("suppresses the failed selector for the full Retry-After and records why", async () => {
			await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
			const live = createSession([primary], model => quotaStream(model));

			await live.prompt("token limit reached");
			await live.waitForIdle();

			expect(modelRegistry.getSelectorSuppressionStatus(selector(primary))).toBe("active");
			const reason = modelRegistry.getSelectorSuppressionReason(selector(primary));
			expect(reason).toContain("token limit reached");
			expect(reason).toMatch(/resets at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
		});

		it("reports the reason while the window is active", () => {
			modelRegistry.suppressSelector(selector(primary), Date.now() + 60_000, "token limit reached");
			expect(modelRegistry.getSelectorSuppressionReason(selector(primary))).toBe("token limit reached");
		});

		it("reading the reason does not consume the one-shot expiry the revert policy needs", () => {
			// `retry.fallbackRevertPolicy: cooldown-expiry` reverts to the head model
			// on the single "expired" that `getSelectorSuppressionStatus` reports
			// before deleting the entry. A read-only reason lookup from the UI must
			// not swallow that observation. Expiry is read from the recorded instant,
			// so no test waits for it.
			modelRegistry.suppressSelector(selector(primary), Date.now() - 1, "token limit reached");

			expect(modelRegistry.getSelectorSuppressionReason(selector(primary))).toBeUndefined();
			expect(modelRegistry.getSelectorSuppressionReason(selector(primary))).toBeUndefined();

			// Still available, and consumed by the status accessor rather than by the reason one.
			expect(modelRegistry.getSelectorSuppressionStatus(selector(primary))).toBe("expired");
			expect(modelRegistry.getSelectorSuppressionStatus(selector(primary))).toBe("none");
		});

		it("keeps the chain on the fallback until the hold expires, then probes the head again", async () => {
			// Quota suppression feeds `retry.fallbackRevertPolicy: cooldown-expiry`,
			// which reverts to the head model on the single "expired" the suppression
			// reports. This is strictly better than before the policy existed: quota
			// suppressed nothing, so the head never reported "expired" and a session
			// that fell back stayed on the fallback model for good.
			await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
			const turns: string[][] = [];
			let current: string[] = [];
			const live = createSession([primary, fallback], model => {
				current.push(selector(model));
				return selector(model) === selector(primary) ? quotaStream(model) : successStream(model);
			});

			const runTurn = async (prompt: string) => {
				current = [];
				await live.prompt(prompt);
				await live.waitForIdle();
				turns.push(current);
			};

			await runTurn("head hits its token limit");
			await runTurn("second turn while the head is still held");

			// Turn 1 advanced past the held head; turn 2 stayed on the fallback
			// because the head's suppression is still active.
			expect(turns[0]).toEqual([selector(primary), selector(fallback)]);
			expect(turns[1]).toEqual([selector(fallback)]);
			expect(modelRegistry.getSelectorSuppressionStatus(selector(primary))).toBe("active");

			// Expire the window by rewriting the recorded instant rather than waiting.
			modelRegistry.suppressSelector(selector(primary), Date.now() - 1, describeHold());
			await runTurn("third turn after the limit reset");

			// The head is probed again exactly once the window is gone.
			expect(turns[2]?.[0]).toBe(selector(primary));
		});

		it("leaves a reasonless rate-limit suppression exactly as it was", () => {
			modelRegistry.suppressSelector(selector(primary), Date.now() + 60_000);
			expect(modelRegistry.isSelectorSuppressed(selector(primary))).toBe(true);
			expect(modelRegistry.getSelectorSuppressionReason(selector(primary))).toBeUndefined();
		});
	});

	describe("policy 5 — 503 queue pressure keeps the server class and the existing budget", () => {
		it("classifies queue_timeout and queue_full as server failures carrying retry-after", () => {
			for (const providerCode of ["queue_timeout", "queue_full"]) {
				expect(
					classifyFallbackTrigger({
						status: 503,
						providerCode,
						headers: { "retry-after": "5" },
					}),
				).toEqual({ class: "server", retryAfterMs: 5_000 });
			}
		});

		it("honors a 5s retry-after in the managed fallback delay without capping it away", () => {
			// `effectiveFallbackDelay` is the managed-path formula. The hint is a floor,
			// not something `retry.maxDelayMs` may shorten.
			expect(effectiveFallbackDelay(2_000, 30_000, 1, 5_000, () => 0)).toBe(5_000);
			expect(effectiveFallbackDelay(2_000, 1_000, 3, 5_000, () => 1)).toBe(5_000);
			// With no hint the ordinary capped-exponential budget is unchanged.
			expect(effectiveFallbackDelay(2_000, 30_000, 1, undefined, () => 1)).toBe(2_000);
		});

		it("still retries a 503 queue timeout and recovers within the budget", async () => {
			await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
			const calls: string[] = [];
			const live = createSession(
				[primary],
				model => {
					calls.push(selector(model));
					if (calls.length === 1) {
						return errorStream(model, "Gateway queue wait exceeded", 503, {
							kind: "transport",
							status: 503,
							providerCode: "queue_timeout",
							headers: { "retry-after": "5" },
						});
					}
					return successStream(model);
				},
				{ "retry.maxRetries": 2, "retry.baseDelayMs": 5, "retry.maxDelayMs": 20 },
			);

			await live.prompt("queue timeout then recovery");
			await live.waitForIdle();

			expect(calls).toHaveLength(2);
			expect(lastAssistant(live).stopReason).toBe("stop");
		});

		it("keeps the configured retry budget for a 503 that never recovers", async () => {
			await authStorage.set("anthropic", [{ type: "api_key", key: "gateway-key-1" }]);
			const calls: string[] = [];
			const live = createSession(
				[primary],
				model => {
					calls.push(selector(model));
					return errorStream(model, "Gateway queue is full", 503, {
						kind: "transport",
						status: 503,
						providerCode: "queue_full",
						headers: { "retry-after": "5" },
					});
				},
				{ "retry.maxRetries": 2, "retry.baseDelayMs": 5, "retry.maxDelayMs": 20 },
			);

			await live.prompt("queue full for the whole budget");
			await live.waitForIdle();

			// One initial request plus `retry.maxRetries` retries — the budget the
			// quota policy must not have touched.
			expect(calls).toHaveLength(3);
			expect(lastAssistant(live).stopReason).toBe("error");
		});
	});
});
