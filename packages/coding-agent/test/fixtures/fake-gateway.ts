/**
 * A loopback stand-in for the LIG usage gateway (VUG), for client-contract tests.
 *
 * WHAT IT MIMICS — only the wire contract the vib client is entitled to rely on,
 * as recorded in Keonho-Chu/Vibrato#8 §1–§6 and refined by #12/#13:
 *
 * - `POST /v1/chat/completions`: OpenAI chat-completions SSE, reasoning/text/tool
 *   deltas and a final `usage` chunk. The request body is recorded verbatim so a
 *   test can assert `reasoning_effort`, `stream_options.include_usage`, the model
 *   id and the message shape that actually left the client.
 * - `GET /v1/models`: an OpenAI models list whose entries may carry the operator
 *   `vibrato` hint object (`DiscoveredModelHintSchema`). Per #8 §3 this path is
 *   NOT a captured path, so it carries no quota headers.
 * - Key check before any upstream work: an unaccepted bearer is answered 401 and
 *   the fake upstream is never called (`reachedUpstream: false` on the record).
 * - Session recording: `x-session-id` / `session_id` header, or a `session_id`
 *   body field. Absent all three the request is filed under `no-session`, which
 *   is what the gateway records when `compat.sendSessionHeaders` is off (#8 §2).
 * - Quota headers on a captured success: `x-vug-daily-limit`, `x-vug-daily-used`,
 *   `x-vug-daily-remaining`, and `x-vug-daily-reset` when configured. `remaining`
 *   is the value observed at request admission, before this call's own tokens are
 *   accounted — the "observation point" semantics of #8 §3.
 * - Congestion facts on every chat response: `x-vug-queue-depth`, `x-vug-inflight`,
 *   `x-vug-queued-ms`.
 * - `429` with error code `daily_token_limit`, the daily headers and `retry-after`
 *   (the code the gateway adopts in VIB-Gateway#1; see #12).
 * - `503` with error code `queue_timeout` or `queue_full`, `retry-after: 5` and
 *   the queue headers.
 * - Cancellation: a client abort stops the fake upstream mid-stream and releases
 *   the slot, so `inflight` returns to zero and the record ends `aborted` with
 *   fewer chunks produced than the script asked for.
 * - `POST /v1/responses`: authenticated passthrough that answers 200 with a usage
 *   block but is NOT a captured path, so nothing is added to the daily total.
 *   Asserting this is diagnostic: passing does not mean Responses is supported.
 *
 * WHAT IT DOES NOT MIMIC — do not read a passing test here as evidence for any
 * of it: the real VUG admission queue and its timing, SQLite request rows and
 * their schema, key issuance/expiry, `/metrics`, `/admin`, `/healthz`, `/readyz`,
 * upstream key substitution beyond the `upstreamAuthorization` field recorded
 * below, retry policy, and any real model inference. The gateway's own handler is
 * tested in its own repository; this fixture deliberately has no dependency on
 * that source, so a change on either side has to be reflected here by hand.
 *
 * Hermetic by construction: `Bun.serve` on 127.0.0.1 with an ephemeral port, no
 * DNS, no outbound socket. `stop()` must run in `afterAll`/`afterEach`.
 */

/** How the gateway should answer the next captured chat request. */
export type ChatOutcomeScript =
	| { kind: "stream"; stream?: ChatStreamScript }
	| { kind: "daily_token_limit" }
	| { kind: "queue_timeout" }
	| { kind: "queue_full" };

/** What the fake upstream produces for one streamed completion. */
export interface ChatStreamScript {
	/** Reasoning deltas, emitted on the configured reasoning content field. */
	reasoning?: string[];
	/** Assistant text deltas. */
	text?: string[];
	/** A single tool call, emitted as one complete arguments delta. */
	toolCall?: { id: string; name: string; argumentsJson: string };
	/** The final usage chunk. This is what the gateway meters. */
	usage?: { input: number; output: number; cachedInput?: number };
	finishReason?: string;
	/** Delay before each chunk; lets a test observe an abort mid-stream. */
	chunkDelayMs?: number;
	/**
	 * After this many chunks the fake upstream waits for the abort signal
	 * instead of continuing. Used by the cancellation case.
	 */
	holdAfterChunks?: number;
}

export interface FakeGatewayOptions {
	/** Bearer values the gateway accepts. Anything else is 401. */
	keys: string[];
	/** `/v1/models` entries, passed through verbatim (hints included). */
	models?: Array<Record<string, unknown>>;
	/** Daily token budget reported in the `x-vug-daily-*` headers. */
	dailyLimit?: number;
	/** Tokens already spent before the test starts. */
	dailyUsed?: number;
	/** Value for `x-vug-daily-reset`; omitted from responses when unset. */
	dailyReset?: string;
	/** Reported in `x-vug-queue-depth`. */
	queueDepth?: number;
	/** Reported in `x-vug-queued-ms`: the previous request's wait, per #8 §6. */
	queuedMs?: number;
	/** `retry-after` seconds on a `daily_token_limit` 429. */
	dailyRetryAfterSeconds?: number;
	/** Field the fake upstream puts reasoning text on. */
	reasoningContentField?: "reasoning" | "reasoning_content" | "reasoning_text";
	/** The key the gateway would present to the real model server. */
	upstreamKey?: string;
	/** Default script when the outcome queue is empty. */
	defaultStream?: ChatStreamScript;
}

/** One request as the gateway saw it. Tests assert on these, not on logs. */
export interface GatewayRequestRecord {
	method: string;
	path: string;
	headers: Record<string, string>;
	body?: Record<string, unknown>;
	/** `no-session` when the client sent no session id anywhere. */
	sessionId: string;
	outcome: "ok" | "aborted" | "unauthorized" | "daily_token_limit" | "queue_timeout" | "queue_full" | "not_found";
	/** False when the key check rejected the request before any upstream work. */
	reachedUpstream: boolean;
	/** True only for a captured path that adds to the daily total. */
	counted: boolean;
	/** Tokens the gateway metered from the final usage chunk. */
	accounted?: { input: number; output: number };
	/** SSE chunks the fake upstream actually produced. */
	upstreamChunks: number;
	/** The Authorization the gateway would have sent upstream, never the client's. */
	upstreamAuthorization?: string;
	/** The daily remaining observed at admission, before this call was metered. */
	remainingAtAdmission?: number;
}

export interface FakeGateway {
	/** Base URL for `models.yml`, e.g. `http://127.0.0.1:1234/v1`. */
	readonly url: string;
	readonly records: readonly GatewayRequestRecord[];
	/** Requests that got past the key check and reached the fake upstream. */
	readonly upstreamCalls: number;
	/** Slots currently held. Must be 0 once every request has settled. */
	readonly inflight: number;
	readonly dailyUsed: number;
	readonly dailyLimit: number;
	/** Queue an outcome for the next captured chat request. */
	scriptChat(outcome: ChatOutcomeScript): void;
	/** Replace the `/v1/models` payload between refreshes. */
	setModels(models: Array<Record<string, unknown>>): void;
	recordsFor(path: string): GatewayRequestRecord[];
	stop(): Promise<void>;
}

const encoder = new TextEncoder();

function sse(payload: unknown): Uint8Array {
	return encoder.encode(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

function headerRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key.toLowerCase()] = value;
	});
	return record;
}

function bearer(headers: Headers): string | undefined {
	const value = headers.get("authorization");
	if (!value) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(value.trim());
	return match ? match[1] : undefined;
}

function errorBody(message: string, code: string | undefined, type: string): string {
	return JSON.stringify({ error: { message, type, ...(code === undefined ? {} : { code }) } });
}

export async function startFakeGateway(options: FakeGatewayOptions): Promise<FakeGateway> {
	const keys = new Set(options.keys);
	const dailyLimit = options.dailyLimit ?? 100_000;
	const queueDepth = options.queueDepth ?? 0;
	const queuedMs = options.queuedMs ?? 12;
	const reasoningField = options.reasoningContentField ?? "reasoning";
	const upstreamKey = options.upstreamKey ?? "fixture-upstream-key";
	const defaultStream: ChatStreamScript = options.defaultStream ?? {
		text: ["ok"],
		usage: { input: 60, output: 10 },
	};

	let models = options.models ?? [];
	let dailyUsed = options.dailyUsed ?? 0;
	let inflight = 0;
	let upstreamCalls = 0;
	const records: GatewayRequestRecord[] = [];
	const scripted: ChatOutcomeScript[] = [];

	const quotaHeaders = (remaining: number): Record<string, string> => ({
		"x-vug-daily-limit": String(dailyLimit),
		"x-vug-daily-used": String(dailyLimit - remaining),
		"x-vug-daily-remaining": String(Math.max(0, remaining)),
		...(options.dailyReset === undefined ? {} : { "x-vug-daily-reset": options.dailyReset }),
	});

	const congestionHeaders = (): Record<string, string> => ({
		"x-vug-queue-depth": String(queueDepth),
		"x-vug-inflight": String(inflight),
		"x-vug-queued-ms": String(queuedMs),
	});

	const unauthorized = (record: GatewayRequestRecord): Response => {
		record.outcome = "unauthorized";
		return new Response(errorBody("invalid gateway key", undefined, "invalid_request_error"), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	};

	/**
	 * The fake upstream. It exists only past the key check and past admission,
	 * so a 401 or a rejected admission provably never reaches it.
	 */
	function upstreamStream(
		script: ChatStreamScript,
		modelId: string,
		signal: AbortSignal,
		record: GatewayRequestRecord,
	): ReadableStream<Uint8Array> {
		upstreamCalls += 1;
		record.reachedUpstream = true;
		record.upstreamAuthorization = `Bearer ${upstreamKey}`;
		const chunks: unknown[] = [];
		const envelope = (delta: Record<string, unknown>, finishReason?: string) => ({
			id: "chatcmpl-fake-gateway",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
		});
		for (const piece of script.reasoning ?? []) chunks.push(envelope({ [reasoningField]: piece }));
		for (const piece of script.text ?? []) chunks.push(envelope({ content: piece }));
		if (script.toolCall) {
			chunks.push(
				envelope({
					tool_calls: [
						{
							index: 0,
							id: script.toolCall.id,
							type: "function",
							function: { name: script.toolCall.name, arguments: script.toolCall.argumentsJson },
						},
					],
				}),
			);
		}
		chunks.push(envelope({}, script.finishReason ?? (script.toolCall ? "tool_calls" : "stop")));
		const usage = script.usage;
		if (usage) {
			chunks.push({
				id: "chatcmpl-fake-gateway",
				object: "chat.completion.chunk",
				created: 0,
				model: modelId,
				choices: [],
				usage: {
					prompt_tokens: usage.input,
					completion_tokens: usage.output,
					total_tokens: usage.input + usage.output,
					...(usage.cachedInput === undefined
						? {}
						: { prompt_tokens_details: { cached_tokens: usage.cachedInput } }),
				},
			});
		}

		const delay = script.chunkDelayMs ?? 0;
		const holdAfter = script.holdAfterChunks;
		let released = false;
		const release = (aborted: boolean): void => {
			if (released) return;
			released = true;
			inflight -= 1;
			if (aborted) {
				record.outcome = "aborted";
				return;
			}
			record.outcome = "ok";
			if (usage) {
				record.accounted = { input: usage.input, output: usage.output };
				dailyUsed += usage.input + usage.output;
			}
		};

		return new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					for (const [index, chunk] of chunks.entries()) {
						if (signal.aborted) break;
						if (holdAfter !== undefined && index >= holdAfter) {
							// The real gateway holds the slot while the upstream is
							// still generating; the abort is what frees it.
							await new Promise<void>(resolve => {
								if (signal.aborted) return resolve();
								signal.addEventListener("abort", () => resolve(), { once: true });
							});
							break;
						}
						if (delay > 0) await Bun.sleep(delay);
						if (signal.aborted) break;
						controller.enqueue(sse(chunk));
						record.upstreamChunks += 1;
					}
					if (!signal.aborted) controller.enqueue(sse("[DONE]"));
				} catch {
					// A closed consumer is an abort, not a fixture failure.
				} finally {
					release(signal.aborted);
					try {
						controller.close();
					} catch {
						// Already closed by the aborted consumer.
					}
				}
			},
			cancel() {
				release(true);
			},
		});
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 30,
		async fetch(request) {
			const url = new URL(request.url);
			const record: GatewayRequestRecord = {
				method: request.method,
				path: url.pathname,
				headers: headerRecord(request.headers),
				sessionId: "no-session",
				outcome: "ok",
				reachedUpstream: false,
				counted: false,
				upstreamChunks: 0,
			};
			records.push(record);

			let body: Record<string, unknown> | undefined;
			if (request.method === "POST") {
				const raw = await request.text();
				try {
					body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
				} catch {
					body = undefined;
				}
				record.body = body;
			}
			const sessionId =
				record.headers["x-session-id"] ??
				record.headers.session_id ??
				(typeof body?.session_id === "string" ? body.session_id : undefined);
			if (sessionId) record.sessionId = sessionId;

			const key = bearer(request.headers);
			if (key === undefined || !keys.has(key)) return unauthorized(record);

			if (url.pathname === "/v1/models" && request.method === "GET") {
				// Not a captured path: no quota headers here (#8 §3).
				return Response.json({ object: "list", data: models });
			}

			if (url.pathname === "/v1/responses" && request.method === "POST") {
				// Authenticated passthrough. 200 with usage, and deliberately not
				// metered — HTTP success is not gateway accounting (#8 §5).
				record.reachedUpstream = true;
				record.counted = false;
				return Response.json(
					{
						id: "resp_fake_gateway",
						object: "response",
						model: typeof body?.model === "string" ? body.model : "unknown",
						output: [],
						usage: { input_tokens: 60, output_tokens: 10, total_tokens: 70 },
					},
					{ headers: congestionHeaders() },
				);
			}

			if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
				record.outcome = "not_found";
				return new Response(errorBody("unknown path", undefined, "invalid_request_error"), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}

			record.counted = true;
			const remainingAtAdmission = dailyLimit - dailyUsed;
			record.remainingAtAdmission = remainingAtAdmission;
			const outcome: ChatOutcomeScript = scripted.shift() ?? { kind: "stream" };

			if (outcome.kind === "daily_token_limit") {
				record.outcome = "daily_token_limit";
				return new Response(errorBody("daily token limit reached", "daily_token_limit", "rate_limit_error"), {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": String(options.dailyRetryAfterSeconds ?? 43_200),
						...quotaHeaders(0),
						...congestionHeaders(),
					},
				});
			}
			if (outcome.kind === "queue_timeout" || outcome.kind === "queue_full") {
				record.outcome = outcome.kind;
				return new Response(errorBody("gateway is busy", outcome.kind, "server_error"), {
					status: 503,
					headers: {
						"content-type": "application/json",
						"retry-after": "5",
						...congestionHeaders(),
					},
				});
			}

			inflight += 1;
			const stream = upstreamStream(
				outcome.stream ?? defaultStream,
				typeof body?.model === "string" ? body.model : "unknown",
				request.signal,
				record,
			);
			return new Response(stream, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-store",
					...quotaHeaders(remainingAtAdmission),
					...congestionHeaders(),
				},
			});
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		records,
		get upstreamCalls() {
			return upstreamCalls;
		},
		get inflight() {
			return inflight;
		},
		get dailyUsed() {
			return dailyUsed;
		},
		dailyLimit,
		scriptChat(outcome) {
			scripted.push(outcome);
		},
		setModels(next) {
			models = next;
		},
		recordsFor(path) {
			return records.filter(record => record.path === path);
		},
		async stop() {
			await server.stop(true);
		},
	};
}
