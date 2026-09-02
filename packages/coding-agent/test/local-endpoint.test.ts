import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@vib-rato/utils";
import { YAML } from "bun";
import {
	discoverLoopbackEndpoints,
	type LocalEndpointProbeOptions,
	normalizeLocalEndpointInput,
	probeLocalEndpoint,
	registerLocalEndpoint,
} from "../src/setup/local-endpoint";

const DISCOVERY_ENV_NAMES = [
	"OLLAMA_BASE_URL",
	"LM_STUDIO_BASE_URL",
	"LLAMA_CPP_BASE_URL",
	"OMLX_BASE_URL",
	"VLLM_BASE_URL",
	"SGLANG_BASE_URL",
] as const;

const savedEnv = new Map<string, string | undefined>();

function setDiscoveryEnv(values: Partial<Record<(typeof DISCOVERY_ENV_NAMES)[number], string>>): void {
	for (const name of DISCOVERY_ENV_NAMES) {
		if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
		const value = values[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

afterEach(() => {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	savedEnv.clear();
});

function expectBaseUrl(raw: string): string {
	const result = normalizeLocalEndpointInput(raw);
	if ("error" in result) throw new Error(`expected '${raw}' to normalize, got: ${result.error}`);
	return result.baseUrl;
}

function expectError(raw: string): string {
	const result = normalizeLocalEndpointInput(raw);
	if (!("error" in result)) throw new Error(`expected '${raw}' to be rejected, got: ${result.baseUrl}`);
	return result.error;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("normalizeLocalEndpointInput", () => {
	it("infers plain http for a private-network host given as host:port", () => {
		expect(expectBaseUrl("192.168.0.10:8000")).toBe("http://192.168.0.10:8000/v1");
		expect(expectBaseUrl("10.0.0.5:8000")).toBe("http://10.0.0.5:8000/v1");
		expect(expectBaseUrl("172.16.4.4:8000")).toBe("http://172.16.4.4:8000/v1");
		expect(expectBaseUrl("169.254.1.2:8000")).toBe("http://169.254.1.2:8000/v1");
	});

	it("infers plain http for loopback, bare, and LAN-suffixed hosts", () => {
		expect(expectBaseUrl("127.0.0.1:8000")).toBe("http://127.0.0.1:8000/v1");
		expect(expectBaseUrl("localhost:1234")).toBe("http://localhost:1234/v1");
		expect(expectBaseUrl("gpu-box:8000")).toBe("http://gpu-box:8000/v1");
		expect(expectBaseUrl("gpu-box.local:8000")).toBe("http://gpu-box.local:8000/v1");
		expect(expectBaseUrl("gpu-box.internal:8000")).toBe("http://gpu-box.internal:8000/v1");
		expect(expectBaseUrl("gpu-box.lan:8000")).toBe("http://gpu-box.lan:8000/v1");
	});

	it("infers https for a public host", () => {
		expect(expectBaseUrl("llm.example.com")).toBe("https://llm.example.com/v1");
		expect(expectBaseUrl("llm.example.com:8443")).toBe("https://llm.example.com:8443/v1");
	});

	it("keeps an explicit scheme", () => {
		expect(expectBaseUrl("http://gpu-box:8000")).toBe("http://gpu-box:8000/v1");
		expect(expectBaseUrl("https://llm.example.com")).toBe("https://llm.example.com/v1");
	});

	it("appends /v1 only when no path was given", () => {
		expect(expectBaseUrl("http://gpu-box:8000")).toBe("http://gpu-box:8000/v1");
		expect(expectBaseUrl("http://gpu-box:8000/")).toBe("http://gpu-box:8000/v1");
		expect(expectBaseUrl("http://gpu-box:8000/v1")).toBe("http://gpu-box:8000/v1");
		expect(expectBaseUrl("http://gpu-box:8000/v1/")).toBe("http://gpu-box:8000/v1");
		expect(expectBaseUrl("http://gpu-box:8000/openai/v1")).toBe("http://gpu-box:8000/openai/v1");
		expect(expectBaseUrl("gpu-box:8000/api/v3")).toBe("http://gpu-box:8000/api/v3");
	});

	it("trims surrounding whitespace and drops a query string or fragment", () => {
		expect(expectBaseUrl("  192.168.0.10:8000  ")).toBe("http://192.168.0.10:8000/v1");
		expect(expectBaseUrl("http://gpu-box:8000/v1?debug=1#top")).toBe("http://gpu-box:8000/v1");
	});

	it("rejects empty input", () => {
		expect(expectError("")).toMatch(/server address/i);
		expect(expectError("   ")).toMatch(/server address/i);
	});

	it("rejects an unparseable address", () => {
		expect(expectError("http://")).toMatch(/not a valid server address/i);
		expect(expectError(":::")).toMatch(/not a valid server address/i);
	});

	it("rejects a non-http scheme", () => {
		expect(expectError("ftp://gpu-box:8000")).toMatch(/http/i);
	});

	it("rejects plain http for a public host", () => {
		const error = expectError("http://llm.example.com:8000/v1");
		expect(error).toMatch(/https/i);
		expect(error).toContain("llm.example.com");
	});
});

describe("probeLocalEndpoint", () => {
	it("requests /models with the Accept header and no Authorization when keyless", async () => {
		let seenUrl: string | undefined;
		let seenHeaders: Headers | undefined;
		const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
			seenUrl = String(input);
			seenHeaders = new Headers(init?.headers);
			return jsonResponse({ data: [{ id: "qwen3" }] });
		}) as unknown as typeof fetch;

		const probe = await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl });

		expect(probe).toEqual({ status: "ok", models: [{ id: "qwen3" }] });
		expect(seenUrl).toBe("http://gpu-box:8000/v1/models");
		expect(seenHeaders?.get("accept")).toBe("application/json");
		expect(seenHeaders?.has("authorization")).toBe(false);
	});

	it("sends a Bearer header only for a non-empty key", async () => {
		const seen: (string | null)[] = [];
		const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("authorization"));
			return jsonResponse({ data: [{ id: "qwen3" }] });
		}) as unknown as typeof fetch;

		await probeLocalEndpoint("http://gpu-box:8000/v1", "sk-local", { fetchImpl });
		await probeLocalEndpoint("http://gpu-box:8000/v1", "   ", { fetchImpl });

		expect(seen).toEqual(["Bearer sk-local", null]);
	});

	it("parses the context length from the OpenAI-compatible field variants", async () => {
		const fetchImpl = (async () =>
			jsonResponse({
				data: [
					{ id: "vllm-model", max_model_len: 131072 },
					{ id: "openrouter-style", context_length: 65536 },
					{ id: "lmstudio-style", details: { n_ctx: 8192 } },
					{ id: "meta-style", meta: { n_ctx_train: 4096 } },
					{ id: "string-valued", max_context_length: "32768" },
					{ id: "completion-only", max_completion_tokens: 2048 },
					{ id: "unknown-window" },
					{ id: "non-positive", context_length: 0 },
				],
			})) as unknown as typeof fetch;

		const probe = await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl });

		expect(probe).toEqual({
			status: "ok",
			models: [
				{ id: "vllm-model", contextLength: 131072 },
				{ id: "openrouter-style", contextLength: 65536 },
				{ id: "lmstudio-style", contextLength: 8192 },
				{ id: "meta-style", contextLength: 4096 },
				{ id: "string-valued", contextLength: 32768 },
				{ id: "completion-only", contextLength: 2048 },
				{ id: "unknown-window" },
				{ id: "non-positive" },
			],
		});
	});

	it("prefers max_model_len over the other window fields", async () => {
		const fetchImpl = (async () =>
			jsonResponse({
				data: [{ id: "qwen3", max_model_len: 40960, context_length: 8192, max_completion_tokens: 1024 }],
			})) as unknown as typeof fetch;

		const probe = await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl });

		expect(probe).toEqual({ status: "ok", models: [{ id: "qwen3", contextLength: 40960 }] });
	});

	it("drops unusable entries and deduplicates ids", async () => {
		const fetchImpl = (async () =>
			jsonResponse({
				data: [{ id: "qwen3" }, { id: "qwen3", max_model_len: 4096 }, { id: "" }, { id: 7 }, "nonsense"],
			})) as unknown as typeof fetch;

		const probe = await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl });

		expect(probe).toEqual({ status: "ok", models: [{ id: "qwen3" }] });
	});

	it("reports no-models for an empty list", async () => {
		const fetchImpl = (async () => jsonResponse({ object: "list", data: [] })) as unknown as typeof fetch;

		expect(await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl })).toEqual({
			status: "no-models",
		});
	});

	it("reports unauthorized for 401 and 403", async () => {
		const status401 = (async () => jsonResponse({ error: "no key" }, 401)) as unknown as typeof fetch;
		const status403 = (async () => jsonResponse({ error: "forbidden" }, 403)) as unknown as typeof fetch;

		expect(await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl: status401 })).toEqual({
			status: "unauthorized",
		});
		expect(await probeLocalEndpoint("http://gpu-box:8000/v1", "sk-wrong", { fetchImpl: status403 })).toEqual({
			status: "unauthorized",
		});
	});

	it("reports unreachable for another failing status", async () => {
		const fetchImpl = (async () =>
			new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;

		const probe = await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl });

		expect(probe.status).toBe("unreachable");
		expect(probe.status === "unreachable" && probe.detail).toContain("500");
	});

	it("reports unreachable when the connection fails", async () => {
		const fetchImpl = (async () => {
			throw new Error("connect ECONNREFUSED 192.168.0.10:8000");
		}) as unknown as typeof fetch;

		const probe = await probeLocalEndpoint("http://192.168.0.10:8000/v1", undefined, { fetchImpl });

		expect(probe.status).toBe("unreachable");
		expect(probe.status === "unreachable" && probe.detail).toContain("ECONNREFUSED");
	});

	it("reports unreachable when the body is not JSON", async () => {
		const fetchImpl = (async () => new Response("<html>login</html>", { status: 200 })) as unknown as typeof fetch;

		const probe = await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl });

		expect(probe.status).toBe("unreachable");
		expect(probe.status === "unreachable" && probe.detail).toMatch(/json/i);
	});

	it("reports unreachable when the payload carries no model list", async () => {
		const fetchImpl = (async () => jsonResponse({ object: "list" })) as unknown as typeof fetch;

		const probe = await probeLocalEndpoint("http://gpu-box:8000/v1", undefined, { fetchImpl });

		expect(probe.status).toBe("unreachable");
		expect(probe.status === "unreachable" && probe.detail).toMatch(/model list/i);
	});

	it("aborts a hanging request at the timeout and reports it", async () => {
		const fetchImpl = ((_input: string | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
			})) as unknown as typeof fetch;

		const started = Date.now();
		const probe = await probeLocalEndpoint("http://192.168.0.10:8000/v1", undefined, {
			fetchImpl,
			timeoutMs: 25,
		});

		expect(probe.status).toBe("unreachable");
		expect(probe.status === "unreachable" && probe.detail).toContain("25 ms");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("normalizes a trailing slash on the base URL", async () => {
		let seenUrl: string | undefined;
		const fetchImpl = (async (input: string | URL) => {
			seenUrl = String(input);
			return jsonResponse({ data: [{ id: "qwen3" }] });
		}) as unknown as typeof fetch;

		await probeLocalEndpoint("http://gpu-box:8000/v1/", undefined, { fetchImpl });

		expect(seenUrl).toBe("http://gpu-box:8000/v1/models");
	});
});

describe("discoverLoopbackEndpoints", () => {
	function recordingFetch(models: Record<string, readonly string[]>): {
		fetchImpl: typeof fetch;
		urls: string[];
		maxInFlight: () => number;
	} {
		const urls: string[] = [];
		let inFlight = 0;
		let peak = 0;
		const fetchImpl = (async (input: string | URL) => {
			const url = String(input);
			urls.push(url);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			try {
				await new Promise(resolve => setTimeout(resolve, 20));
				const ids = models[url];
				if (!ids) throw new Error("connect ECONNREFUSED");
				return jsonResponse({ data: ids.map(id => ({ id })) });
			} finally {
				inFlight -= 1;
			}
		}) as unknown as typeof fetch;
		return { fetchImpl, urls, maxInFlight: () => peak };
	}

	it("returns only the endpoints that answered with at least one model", async () => {
		setDiscoveryEnv({});
		const { fetchImpl } = recordingFetch({
			"http://127.0.0.1:11434/v1/models": ["llama3"],
			"http://127.0.0.1:8000/v1/models": ["qwen3", "gemma3"],
		});

		const found = await discoverLoopbackEndpoints({ fetchImpl });

		expect(found).toEqual([
			{ baseUrl: "http://127.0.0.1:11434/v1", label: "Ollama", models: [{ id: "llama3" }] },
			{
				baseUrl: "http://127.0.0.1:8000/v1",
				label: "vLLM",
				models: [{ id: "qwen3" }, { id: "gemma3" }],
			},
		]);
	});

	it("skips an endpoint that answers with an empty model list", async () => {
		setDiscoveryEnv({});
		const { fetchImpl } = recordingFetch({ "http://127.0.0.1:1234/v1/models": [] });

		expect(await discoverLoopbackEndpoints({ fetchImpl })).toEqual([]);
	});

	it("probes every default port concurrently, bounded by one timeout", async () => {
		setDiscoveryEnv({});
		const { fetchImpl, urls, maxInFlight } = recordingFetch({});

		const started = Date.now();
		const found = await discoverLoopbackEndpoints({ fetchImpl, timeoutMs: 500 });
		const elapsed = Date.now() - started;

		expect(found).toEqual([]);
		expect(urls.sort()).toEqual(
			[
				"http://127.0.0.1:1234/v1/models",
				"http://127.0.0.1:11434/v1/models",
				"http://127.0.0.1:30000/v1/models",
				"http://127.0.0.1:8000/v1/models",
				"http://127.0.0.1:8080/v1/models",
			].sort(),
		);
		expect(maxInFlight()).toBe(5);
		expect(elapsed).toBeLessThan(500);
	});

	it("honors the env base URLs and normalizes shorthand", async () => {
		setDiscoveryEnv({ VLLM_BASE_URL: "192.168.0.10:8000", OLLAMA_BASE_URL: "http://gpu-box:11434" });
		const { fetchImpl, urls } = recordingFetch({
			"http://192.168.0.10:8000/v1/models": ["qwen3"],
		});

		const found = await discoverLoopbackEndpoints({ fetchImpl });

		expect(found).toEqual([{ baseUrl: "http://192.168.0.10:8000/v1", label: "vLLM", models: [{ id: "qwen3" }] }]);
		expect(urls).toContain("http://gpu-box:11434/v1/models");
		expect(urls).not.toContain("http://127.0.0.1:8000/v1/models");
		expect(urls).not.toContain("http://127.0.0.1:11434/v1/models");
	});

	it("deduplicates candidates that resolve to the same base URL", async () => {
		setDiscoveryEnv({
			LLAMA_CPP_BASE_URL: "http://127.0.0.1:8080",
			OMLX_BASE_URL: "http://127.0.0.1:8080/v1/",
			SGLANG_BASE_URL: "127.0.0.1:8080",
		});
		const { fetchImpl, urls } = recordingFetch({ "http://127.0.0.1:8080/v1/models": ["mlx-model"] });

		const found = await discoverLoopbackEndpoints({ fetchImpl });

		expect(urls.filter(url => url === "http://127.0.0.1:8080/v1/models")).toHaveLength(1);
		expect(found).toEqual([
			{ baseUrl: "http://127.0.0.1:8080/v1", label: "llama.cpp / oMLX", models: [{ id: "mlx-model" }] },
		]);
	});

	it("falls back to the loopback default when an env base URL is unusable", async () => {
		setDiscoveryEnv({ VLLM_BASE_URL: "http://llm.example.com:8000" });
		const { fetchImpl, urls } = recordingFetch({});

		await discoverLoopbackEndpoints({ fetchImpl });

		expect(urls).toContain("http://127.0.0.1:8000/v1/models");
		expect(urls).not.toContain("http://llm.example.com:8000/v1/models");
	});

	it("never throws when every probe fails", async () => {
		setDiscoveryEnv({});
		const fetchImpl = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const options: LocalEndpointProbeOptions = { fetchImpl, timeoutMs: 50 };

		expect(await discoverLoopbackEndpoints(options)).toEqual([]);
	});
});

describe("registerLocalEndpoint", () => {
	const originalAgentDir = getAgentDir();
	let tempRoot: string | undefined;

	async function useTempAgentDir(): Promise<string> {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-local-endpoint-"));
		// A literal apiKey routes through AuthStorage at getAgentDbPath(); without this
		// the test writes real credential rows into the developer's ~/.vib/agent/agent.db.
		setAgentDir(path.join(tempRoot, "agent"));
		return path.join(getAgentDir(), "models.yml");
	}

	afterEach(async () => {
		setAgentDir(originalAgentDir);
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
			tempRoot = undefined;
		}
	});

	it("writes the keyless optional-credential form of the local preset", async () => {
		const modelsPath = await useTempAgentDir();

		const result = await registerLocalEndpoint({ baseUrl: "http://192.168.0.10:8000/v1" });

		expect(result.providerId).toBe("local");
		expect(result.preset).toBe("local");
		expect(result.baseUrl).toBe("http://192.168.0.10:8000/v1");
		expect(result.apiKeyOptional).toBe(true);
		expect(YAML.parse(await Bun.file(modelsPath).text())).toEqual({
			providers: {
				local: { openaiCompat: { baseUrl: "http://192.168.0.10:8000/v1", apiKeyEnv: "LOCAL_LLM_API_KEY" } },
			},
		});
	});

	it("stores a pasted key as a literal credential instead", async () => {
		await useTempAgentDir();

		const result = await registerLocalEndpoint({ baseUrl: "http://gpu-box:8000/v1", apiKey: "  sk-local-1234  " });

		expect(result.credentialSource).toBe("literal");
		expect(result.apiKeyOptional).toBeUndefined();
		expect(result.redactedApiKey).not.toContain("sk-local-1234");
	});

	it("treats a blank key as keyless", async () => {
		await useTempAgentDir();

		const result = await registerLocalEndpoint({ baseUrl: "http://gpu-box:8000/v1", apiKey: "   " });

		expect(result.credentialSource).toBe("env");
		expect(result.apiKeyOptional).toBe(true);
	});

	it("replaces an existing local provider so reconnecting to another box works", async () => {
		const modelsPath = await useTempAgentDir();
		await registerLocalEndpoint({ baseUrl: "http://127.0.0.1:8000/v1" });

		const result = await registerLocalEndpoint({ baseUrl: "http://192.168.0.10:8000/v1" });

		expect(result.baseUrl).toBe("http://192.168.0.10:8000/v1");
		expect(await Bun.file(modelsPath).text()).toContain("192.168.0.10");
	});
});
