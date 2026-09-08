import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runLocalProviderDiscover,
	runLocalProviderDiscoverCommand,
	runLocalProviderSmoke,
	runLocalProviderStatus,
	runLocalProviderStatusCommand,
} from "@vib-rato/coding-agent/cli/local-provider-smoke";
import { hookFetch } from "@vib-rato/utils/hook-fetch";
import { LOCAL_PROVIDER_ACTIONS, LOCAL_PROVIDER_DEFAULT_ACTION } from "../src/commands/local-provider";

describe("local provider streaming smoke", () => {
	let tempDir: string;
	let modelsPath: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `vib-local-provider-smoke-${crypto.randomUUID()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("reports a clear configuration failure when local openaiCompat is not configured", async () => {
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }));

		const result = await runLocalProviderSmoke({ modelsPath, model: "local-model" });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("No local OpenAI-compatible endpoint configured");
	});

	test("discovers configured local OpenAI-compatible models without a chat completion request", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		const requestedUrls: string[] = [];
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url !== "http://127.0.0.1:1234/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			expect(init?.method ?? "GET").toBe("GET");
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer local-key");
			return new Response(JSON.stringify({ data: [{ id: "z-local" }, { id: "a-local" }, { id: "a-local" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await runLocalProviderDiscover({ modelsPath });

		expect(result.ok).toBe(true);
		expect(result.provider).toBe("local");
		expect(result.baseUrl).toBe("http://127.0.0.1:1234/v1");
		expect(result.models).toEqual(["a-local", "z-local"]);
		expect(requestedUrls).toEqual(["http://127.0.0.1:1234/v1/models"]);
	});

	test("prints local discovery provider, base URL, and model ids", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ data: [{ id: "local-alpha" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const captured: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;
		try {
			await runLocalProviderDiscoverCommand({ modelsPath });
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("provider=local");
		expect(output).toContain("baseUrl=http://127.0.0.1:1234/v1");
		expect(output).toContain("local-alpha");
	});

	test("keeps bare local-provider command defaulting to status while exposing diagnostics actions", () => {
		expect(LOCAL_PROVIDER_DEFAULT_ACTION).toBe("status");
		expect(LOCAL_PROVIDER_ACTIONS).toEqual(["status", "diagnose", "discover", "models", "smoke"]);
	});

	test("reports status without streaming smoke and without mutating config", async () => {
		const configText = JSON.stringify({
			providers: {
				local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234/", apiKey: "local-key" } },
			},
		});
		fs.writeFileSync(modelsPath, configText);
		const requestedUrls: string[] = [];
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requestedUrls.push(url);
			expect(init?.method ?? "GET").toBe("GET");
			return new Response(JSON.stringify({ data: [{ id: "local-alpha" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await runLocalProviderStatus({ modelsPath });

		expect(result.ok).toBe(true);
		expect(result.baseUrl).toBe("http://127.0.0.1:1234/v1");
		expect(result.models).toEqual(["local-alpha"]);
		expect(result.checks.map(check => [check.name, check.status])).toEqual([
			["config", "ok"],
			["models", "ok"],
			["chat_stream", "skipped"],
		]);
		expect(requestedUrls).toEqual(["http://127.0.0.1:1234/v1/models"]);
		expect(fs.readFileSync(modelsPath, "utf8")).toBe(configText);
	});

	test("runs optional status streaming smoke against the discovered model", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		const requestedUrls: string[] = [];
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.endsWith("/models")) {
				return new Response(JSON.stringify({ data: [{ id: "local-alpha" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
			const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean };
			expect(body.model).toBe("local-alpha");
			expect(body.stream).toBe(true);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						controller.close();
					},
				}),
				{ status: 200 },
			);
		});

		const result = await runLocalProviderStatus({ modelsPath, smoke: true });

		expect(result.ok).toBe(true);
		expect(result.model).toBe("local-alpha");
		expect(result.checks.map(check => [check.name, check.status])).toEqual([
			["config", "ok"],
			["models", "ok"],
			["chat_stream", "ok"],
		]);
		expect(requestedUrls).toEqual(["http://127.0.0.1:1234/v1/models", "http://127.0.0.1:1234/v1/chat/completions"]);
	});

	test("classifies status authentication failures from /v1/models", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "bad-key" } },
				},
			}),
		);
		using _hook = hookFetch(() => new Response("unauthorized", { status: 401 }));

		const result = await runLocalProviderStatus({ modelsPath, smoke: true });

		expect(result.ok).toBe(false);
		expect(result.checks.find(check => check.name === "models")?.category).toBe("auth");
		expect(result.checks.find(check => check.name === "chat_stream")?.status).toBe("skipped");
	});

	test("classifies streaming smoke not-ready failures", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.endsWith("/models")) {
				return new Response(JSON.stringify({ data: [{ id: "local-alpha" }] }), { status: 200 });
			}
			return new Response("model is loading", { status: 503 });
		});

		const result = await runLocalProviderStatus({ modelsPath, smoke: true });

		expect(result.ok).toBe(false);
		const streamCheck = result.checks.find(check => check.name === "chat_stream");
		expect(streamCheck?.status).toBe("error");
		expect(streamCheck?.category).toBe("not_ready");
	});

	test("reports local discovery network failures clearly", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:65535/v1", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(() => {
			throw new Error("connection refused");
		});

		const result = await runLocalProviderDiscover({ modelsPath, timeoutMs: 25 });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("model discovery failed");
		expect(result.baseUrl).toBe("http://127.0.0.1:65535/v1");
		expect(result.error).toContain("connection refused");
	});

	test("reports malformed local discovery JSON clearly", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(() => new Response("not json", { status: 200 }));

		const result = await runLocalProviderDiscover({ modelsPath });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("Failed to parse /models JSON");
	});

	test("reports malformed local discovery response shape clearly", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(
			() => new Response(JSON.stringify({ models: [{ id: "not-openai-shape" }] }), { status: 200 }),
		);

		const result = await runLocalProviderDiscover({ modelsPath });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("/models response did not include a data array");
	});

	test("does not throw when the configured local endpoint cannot be reached", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:65535/v1", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(() => {
			throw new Error("connection refused");
		});

		const result = await runLocalProviderSmoke({ modelsPath, model: "local-model", timeoutMs: 25 });

		expect(result.ok).toBe(false);
		expect(result.category).toBe("unreachable");
		expect(result.message).toContain("could not reach");
		expect(result.error).toContain("connection refused");
	});

	test("sends a streaming chat completion request to the configured endpoint", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url !== "http://127.0.0.1:1234/v1/chat/completions") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			expect(init?.method).toBe("POST");
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer local-key");
			const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean };
			expect(body.model).toBe("local-model");
			expect(body.stream).toBe(true);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						controller.close();
					},
				}),
				{ status: 200 },
			);
		});

		const result = await runLocalProviderSmoke({ modelsPath, model: "local-model" });

		expect(result.ok).toBe(true);
		expect(result.baseUrl).toBe("http://127.0.0.1:1234/v1");
		expect(result.model).toBe("local-model");
	});
});

describe("local provider gateway facts and hidden providers", () => {
	let tempDir: string;
	let modelsPath: string;
	let previousVllmKey: string | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `vib-local-provider-gateway-${crypto.randomUUID()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		// `vllm` has a built-in VLLM_API_KEY fallback that authenticates the
		// fixture provider, so the hidden-provider cases would be vacuous on a
		// machine that happens to have it set.
		previousVllmKey = Bun.env.VLLM_API_KEY;
		delete Bun.env.VLLM_API_KEY;
	});

	afterEach(() => {
		if (previousVllmKey === undefined) delete Bun.env.VLLM_API_KEY;
		else Bun.env.VLLM_API_KEY = previousVllmKey;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function writeLocalConfig(): void {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:8788", apiKey: "vug-key" } },
				},
			}),
		);
	}

	function modelsResponse(): Response {
		return new Response(JSON.stringify({ data: [{ id: "vug-model" }] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	function emptyStream(headers: Record<string, string>): Response {
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
					controller.close();
				},
			}),
			{ status: 200, headers },
		);
	}

	async function captureStatusOutput(cmd: { modelsPath: string; smoke?: boolean }): Promise<string> {
		const captured: string[] = [];
		const originalStdout = process.stdout.write;
		const originalStderr = process.stderr.write;
		const originalExitCode = process.exitCode;
		process.stdout.write = ((chunk: string) => {
			captured.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => {
			captured.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await runLocalProviderStatusCommand(cmd);
		} finally {
			process.stdout.write = originalStdout;
			process.stderr.write = originalStderr;
			// The command sets `process.exitCode = 1` on a failing diagnostic, which
			// would otherwise fail the whole bun process after every test here.
			// `process.exitCode = undefined` does not clear it in bun 1.4.0, so an
			// unset original has to be restored as an explicit 0.
			process.exitCode = originalExitCode ?? 0;
		}
		return captured.join("");
	}

	test("reports the gateway budget, reset countdown and queue wait from the smoke response", async () => {
		writeLocalConfig();
		const resetAt = new Date(Date.now() + 2.5 * 60 * 60 * 1000);
		using _hook = hookFetch(input => {
			if (String(input).endsWith("/models")) return modelsResponse();
			return emptyStream({
				"x-vug-daily-limit": "200000",
				"x-vug-daily-remaining": "187655",
				"x-vug-daily-reset": resetAt.toISOString(),
				"x-vug-queued-ms": "1200",
			});
		});

		const result = await runLocalProviderStatus({ modelsPath, smoke: true });

		expect(result.ok).toBe(true);
		expect(result.gateway).toEqual({
			limit: 200000,
			remaining: 187655,
			used: 12345,
			resetAt: resetAt.toISOString(),
			resetInMs: expect.any(Number),
			queuedMs: 1200,
		});
	});

	test("prints the gateway facts as their own status lines", async () => {
		writeLocalConfig();
		const resetAt = new Date(Date.now() + 2.5 * 60 * 60 * 1000);
		using _hook = hookFetch(input => {
			if (String(input).endsWith("/models")) return modelsResponse();
			return emptyStream({
				"x-vug-daily-limit": "200000",
				"x-vug-daily-remaining": "187655",
				"x-vug-daily-reset": resetAt.toISOString(),
			});
		});

		const output = await captureStatusOutput({ modelsPath, smoke: true });

		expect(output).toContain("gateway tokens: limit 200000, used 12345, remaining 187655");
		expect(output).toContain(`gateway resets: in 2h 30m (${resetAt.toISOString()})`);
		expect(output).not.toContain("daily");
		expect(output).not.toContain("vug-key");
	});

	test("prints no gateway line for an endpoint that sends no gateway headers", async () => {
		writeLocalConfig();
		using _hook = hookFetch(input => {
			if (String(input).endsWith("/models")) return modelsResponse();
			return emptyStream({ "content-type": "text/event-stream" });
		});

		const result = await runLocalProviderStatus({ modelsPath, smoke: true });
		const output = await captureStatusOutput({ modelsPath, smoke: true });

		expect(result.ok).toBe(true);
		expect(result.gateway).toBeUndefined();
		expect(output).not.toContain("gateway");
	});

	test("reports no gateway facts when no smoke request was made", async () => {
		writeLocalConfig();
		using _hook = hookFetch(() => {
			// The gateway does not attach quota headers to /v1/models, but even if an
			// endpoint did, a status run without a smoke must report nothing.
			return new Response(JSON.stringify({ data: [{ id: "vug-model" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json", "x-vug-daily-limit": "200000" },
			});
		});

		const result = await runLocalProviderStatus({ modelsPath });

		expect(result.checks.find(check => check.name === "chat_stream")?.status).toBe("skipped");
		expect(result.gateway).toBeUndefined();
	});

	test("classifies a token-limit rejection with the reset countdown", async () => {
		writeLocalConfig();
		const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
		using _hook = hookFetch(input => {
			if (String(input).endsWith("/models")) return modelsResponse();
			return new Response(
				JSON.stringify({
					error: { message: "token limit reached", type: "rate_limit_error", code: "daily_token_limit" },
				}),
				{
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "7200",
						"x-vug-daily-limit": "200000",
						"x-vug-daily-used": "200000",
						"x-vug-daily-reset": resetAt.toISOString(),
					},
				},
			);
		});

		const result = await runLocalProviderStatus({ modelsPath, smoke: true });
		const streamCheck = result.checks.find(check => check.name === "chat_stream");

		expect(result.ok).toBe(false);
		expect(streamCheck?.category).toBe("token_limit");
		expect(streamCheck?.message).toContain("token limit reached; resets in 2h");
		expect(result.gateway?.limit).toBe(200000);
		expect(result.gateway?.used).toBe(200000);
		expect(result.gateway?.resetAt).toBe(resetAt.toISOString());
	});

	test("classifies a queue rejection as a busy gateway carrying the queue depth", async () => {
		writeLocalConfig();
		using _hook = hookFetch(input => {
			if (String(input).endsWith("/models")) return modelsResponse();
			return new Response(
				JSON.stringify({ error: { message: "gateway busy", type: "overloaded_error", code: "queue_timeout" } }),
				{
					status: 503,
					headers: {
						"content-type": "application/json",
						"retry-after": "5",
						"x-vug-queue-depth": "3",
						"x-vug-inflight": "8",
					},
				},
			);
		});

		const result = await runLocalProviderStatus({ modelsPath, smoke: true });
		const streamCheck = result.checks.find(check => check.name === "chat_stream");

		expect(result.ok).toBe(false);
		expect(streamCheck?.category).toBe("gateway_busy");
		expect(streamCheck?.message).toContain("gateway busy (queue 3)");
		expect(streamCheck?.action).toContain("Retry in 5s");
		expect(result.gateway?.queueDepth).toBe(3);
		expect(result.gateway?.inflight).toBe(8);
		expect(result.gateway?.retryAfterMs).toBe(5000);
	});

	test("leaves a plain local 503 on the existing not-ready classification", async () => {
		writeLocalConfig();
		using _hook = hookFetch(input => {
			if (String(input).endsWith("/models")) return modelsResponse();
			return new Response("model is loading", { status: 503 });
		});

		const result = await runLocalProviderStatus({ modelsPath, smoke: true });

		expect(result.checks.find(check => check.name === "chat_stream")?.category).toBe("not_ready");
		expect(result.gateway).toBeUndefined();
	});

	test("names a provider whose apiKeyEnv variable is unset, even with no local endpoint", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					vllm: { baseUrl: "http://10.240.1.240:8788/v1", apiKeyEnv: "VIB_TEST_UNSET_GATEWAY_KEY" },
				},
			}),
		);

		const result = await runLocalProviderStatus({ modelsPath });
		const output = await captureStatusOutput({ modelsPath });

		expect(result.hiddenProviders).toEqual([{ provider: "vllm", envName: "VIB_TEST_UNSET_GATEWAY_KEY" }]);
		expect(output).toContain('provider "vllm": VIB_TEST_UNSET_GATEWAY_KEY is not set, its models are hidden');
	});

	test("says nothing about a provider whose apiKeyEnv variable is set", async () => {
		const envName = "VIB_TEST_SET_GATEWAY_KEY";
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { vllm: { baseUrl: "http://10.240.1.240:8788/v1", apiKeyEnv: envName } } }),
		);
		const previous = Bun.env[envName];
		Bun.env[envName] = "vug_live_value";
		try {
			const result = await runLocalProviderStatus({ modelsPath });
			expect(result.hiddenProviders).toEqual([]);
		} finally {
			if (previous === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previous;
		}
	});
});
