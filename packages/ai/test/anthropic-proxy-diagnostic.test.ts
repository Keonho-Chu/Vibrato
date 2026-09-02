import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { diagnoseAnthropicContextManagementInjection, streamAnthropic } from "@vib-rato/ai/providers/anthropic";
import type { Context, Model } from "@vib-rato/ai/types";
import type { RawHttpRequestDump } from "@vib-rato/ai/utils/http-inspector";
import { getConfigRootDir, setAgentDir } from "@vib-rato/utils";

const REJECTION =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"`clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive"}}';

const context: Context = {
	messages: [{ role: "user", content: "reply with pong", timestamp: Date.now() }],
};

function model(baseUrl: string): Model<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	};
}

function error(status = 400, message = REJECTION): Error {
	return Object.assign(new Error(message), { status });
}

function dump(baseUrl: string, body: Record<string, unknown>): RawHttpRequestDump {
	return {
		provider: "anthropic",
		api: "anthropic-messages",
		model: "claude-haiku-4-5",
		method: "POST",
		url: `${baseUrl}/v1/messages?api_key=synthetic-query-secret`,
		body,
	};
}

let previousAgentDir: string | undefined;
let previousPiConfigDir: string | undefined;
let previousVibConfigDir: string | undefined;
let tempConfigRoot: string | undefined;

async function useTempAgentDir(): Promise<void> {
	previousAgentDir = getConfigRootDir();
	previousPiConfigDir = process.env.PI_CONFIG_DIR;
	previousVibConfigDir = process.env.VIB_CONFIG_DIR;
	tempConfigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-anthropic-proxy-diagnostic-"));
	process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempConfigRoot);
	delete process.env.VIB_CONFIG_DIR;
	setAgentDir(path.join(tempConfigRoot, "agent"));
}

afterEach(async () => {
	if (previousPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = previousPiConfigDir;
	if (previousVibConfigDir === undefined) delete process.env.VIB_CONFIG_DIR;
	else process.env.VIB_CONFIG_DIR = previousVibConfigDir;
	if (previousAgentDir) setAgentDir(previousAgentDir);
	if (tempConfigRoot) await fs.rm(tempConfigRoot, { recursive: true, force: true });
	previousAgentDir = undefined;
	previousPiConfigDir = undefined;
	previousVibConfigDir = undefined;
	tempConfigRoot = undefined;
});

describe("Anthropic proxy-injected context-management diagnostic (#4380)", () => {
	it("classifies a non-streaming clean body only on a custom base URL", () => {
		const diagnostic = diagnoseAnthropicContextManagementInjection(
			error(),
			dump("https://proxy.example.test/anthropic", {
				model: "claude-haiku-4-5",
				messages: [],
				stream: false,
			}),
		);

		expect(diagnostic?.strategy).toBe("clear_thinking_20251015");
		expect(diagnostic?.message).toContain("likely injected");
		expect(diagnostic?.message).toContain("https://proxy.example.test/anthropic");
		expect(diagnostic?.message).toContain("Enable thinking explicitly");
		expect(diagnostic?.message).toContain("fix/replace the intermediary");
		expect(diagnostic?.message).not.toContain("synthetic-query-secret");
	});

	it.each([
		["thinking", { thinking: { type: "enabled", budget_tokens: 1024 } }],
		["context_management", { context_management: { edits: [{ type: "clear_thinking_20251015" }] } }],
	])("does not classify when the outgoing body contains %s", (_field, extraBody) => {
		expect(
			diagnoseAnthropicContextManagementInjection(
				error(),
				dump("https://proxy.example.test", { model: "claude-haiku-4-5", messages: [], ...extraBody }),
			),
		).toBeUndefined();
	});

	it("does not blame an intermediary on the official Anthropic endpoint", () => {
		expect(
			diagnoseAnthropicContextManagementInjection(
				error(),
				dump("https://api.anthropic.com", { model: "claude-haiku-4-5", messages: [], stream: false }),
			),
		).toBeUndefined();
	});

	it.each([
		[422, REJECTION],
		[400, "400 invalid_request_error: context_management is malformed"],
		[400, "400 invalid_request_error: clear_thinking_20251015 is unknown"],
		[400, "400 api_error: clear_thinking_20251015 strategy requires thinking"],
	])("rejects false positives for status %s and message %s", (status, message) => {
		expect(
			diagnoseAnthropicContextManagementInjection(
				error(status, message),
				dump("https://proxy.example.test", { model: "claude-haiku-4-5", messages: [] }),
			),
		).toBeUndefined();
	});

	it("surfaces the streaming diagnostic once, does not retry, and annotates the sanitized capture", async () => {
		await useTempAgentDir();
		const requestBodies: unknown[] = [];
		const create = ((body: unknown) => {
			requestBodies.push(body);
			return {
				async withResponse() {
					throw error();
				},
			};
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(
			model("https://user:password@proxy.example.test/anthropic?token=secret"),
			context,
			{
				client,
				streamMaxRetries: 3,
			},
		).result();

		expect(requestBodies).toHaveLength(1);
		expect(requestBodies[0]).toMatchObject({ stream: true });
		expect(requestBodies[0]).not.toHaveProperty("thinking");
		expect(requestBodies[0]).not.toHaveProperty("context_management");
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("clear_thinking_20251015");
		expect(result.errorMessage).toContain("likely injected");
		expect(result.errorMessage).toContain("https://proxy.example.test/anthropic");
		expect(result.errorMessage).not.toContain("user:password");
		expect(result.errorMessage).not.toContain("token=secret");
		expect(result.errorMessage).toContain("did not auto-enable thinking or retry");

		const capturePath = /raw-http-request=(.+)$/m.exec(result.errorMessage ?? "")?.[1];
		expect(capturePath).toBeDefined();
		const capture = JSON.parse(await fs.readFile(capturePath ?? "", "utf8")) as Record<string, unknown>;
		expect(capture.url).toBe("https://proxy.example.test/anthropic");
		expect(capture.body).not.toHaveProperty("thinking");
		expect(capture.body).not.toHaveProperty("context_management");
		expect(capture.diagnostics).toMatchObject({
			anthropicContextManagement: {
				strategy: "clear_thinking_20251015",
			},
		});
		expect(JSON.stringify(capture)).not.toContain("password");
		expect(JSON.stringify(capture)).not.toContain("token=secret");
	});
});
