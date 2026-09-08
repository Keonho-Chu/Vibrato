import { beforeAll, describe, expect, it } from "bun:test";
import {
	describeReset,
	LocalEndpointConnectComponent,
	type LocalEndpointConnectDeps,
	type LocalEndpointConnection,
	type LocalEndpointProbeOutcome,
	type LocalEndpointSuggestion,
} from "@vib-rato/coding-agent/modes/components/local-endpoint-connect";
import {
	formatModelContextLength,
	type LocalModelChoice,
	LocalModelPickerComponent,
} from "@vib-rato/coding-agent/modes/components/local-model-picker";
import { initTheme } from "@vib-rato/coding-agent/modes/theme/theme";
import { normalizeLocalEndpointInput } from "@vib-rato/coding-agent/setup/local-endpoint";

beforeAll(async () => {
	await initTheme(false);
});

function visibleText(component: { render(width: number): string[] }): string {
	return Bun.stripANSI(component.render(160).join("\n"));
}

function typeText(component: { handleInput(input: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

/** Let the injected probe/discovery promises settle. */
async function flush(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

interface Harness {
	component: LocalEndpointConnectComponent;
	connections: LocalEndpointConnection[];
	cancels: number;
	probes: Array<{ baseUrl: string; apiKey: string | undefined }>;
}

function createHarness(options: {
	probe?: (baseUrl: string, apiKey?: string) => Promise<LocalEndpointProbeOutcome>;
	discover?: () => Promise<LocalEndpointSuggestion[]>;
}): Harness {
	const connections: LocalEndpointConnection[] = [];
	const probes: Array<{ baseUrl: string; apiKey: string | undefined }> = [];
	const harness = { connections, cancels: 0, probes } as Harness;
	const deps: LocalEndpointConnectDeps = {
		normalize: normalizeLocalEndpointInput,
		probe: async (baseUrl, apiKey) => {
			probes.push({ baseUrl, apiKey });
			return (await options.probe?.(baseUrl, apiKey)) ?? { status: "unreachable", detail: "no stub" };
		},
		discover: options.discover ?? (async () => []),
	};
	harness.component = new LocalEndpointConnectComponent(
		deps,
		connection => {
			connections.push(connection);
		},
		() => {
			harness.cancels += 1;
		},
	);
	return harness;
}

describe("local endpoint connect screen", () => {
	it("takes the address immediately and never waits on loopback discovery", async () => {
		const discovery = Promise.withResolvers<LocalEndpointSuggestion[]>();
		const harness = createHarness({
			discover: () => discovery.promise,
			probe: async () => ({ status: "ok", models: [{ id: "qwen3-coder", contextLength: 262144 }] }),
		});

		// The input is usable on the very first frame, while the scan is pending.
		const opening = visibleText(harness.component);
		expect(opening).toContain("Connect a local LLM endpoint");
		expect(opening).toContain("Server address");
		// The address is the primary path: a remote example, and no prefilled
		// loopback URL to delete before typing.
		expect(opening).toContain("e.g. 192.168.0.10:8000 or gpu-server.lan:8000");
		expect(opening).toContain("usually another machine on your network");
		expect(opening).toContain("http:// is assumed for private and .local addresses");
		expect(opening).not.toContain("127.0.0.1:8000/v1");
		expect(opening).toContain("Also checking this machine for a local server");
		// One screen only: no confirm step and no unprompted API key field.
		expect(opening).not.toContain("Confirm");
		expect(opening).not.toContain("API key");

		typeText(harness.component, "192.168.0.10:8000");
		expect(visibleText(harness.component)).toContain("192.168.0.10:8000");

		discovery.resolve([
			{ baseUrl: "http://127.0.0.1:11434/v1", label: "Ollama", models: [{ id: "llama3", contextLength: 128000 }] },
		]);
		await flush();

		const withRows = visibleText(harness.component);
		// Loopback rows are secondary: a muted heading below the input, and the
		// cursor stays on the address field rather than moving onto a row.
		expect(withRows).toContain("Also found on this machine");
		expect(withRows.indexOf("Server address")).toBeLessThan(withRows.indexOf("Also found on this machine"));
		expect(withRows).toContain("Ollama");
		expect(withRows).toContain("http://127.0.0.1:11434/v1");
		expect(withRows).toContain("llama3 (128K context)");
		// The address the user typed survives the late-arriving rows.
		expect(withRows).toContain("192.168.0.10:8000");
	});

	it("connects a host:port address and hands over the discovered models", async () => {
		const harness = createHarness({
			probe: async () => ({
				status: "ok",
				models: [{ id: "qwen3-coder", contextLength: 262144 }, { id: "gpt-oss-120b" }],
			}),
		});

		typeText(harness.component, "192.168.0.10:8000");
		harness.component.handleInput("\n");
		expect(visibleText(harness.component)).toContain("Connecting to http://192.168.0.10:8000/v1");
		await flush();

		expect(harness.probes).toEqual([{ baseUrl: "http://192.168.0.10:8000/v1", apiKey: undefined }]);
		expect(harness.connections).toEqual([
			{
				baseUrl: "http://192.168.0.10:8000/v1",
				models: [{ id: "qwen3-coder", contextLength: 262144 }, { id: "gpt-oss-120b" }],
			},
		]);
	});

	it("reveals the API key field on the same screen only after a 401", async () => {
		const harness = createHarness({
			probe: async (_baseUrl, apiKey) =>
				apiKey === "sk-lan-secret"
					? { status: "ok", models: [{ id: "served-model" }] }
					: { status: "unauthorized" },
		});

		typeText(harness.component, "gpu-box:8000");
		harness.component.handleInput("\n");
		await flush();

		const challenged = visibleText(harness.component);
		expect(challenged).toContain("The server requires an API key.");
		expect(challenged).toContain("API key");
		// The typed address is kept, so the user does not retype it.
		expect(challenged).toContain("gpu-box:8000");

		typeText(harness.component, "sk-lan-secret");
		expect(visibleText(harness.component)).not.toContain("sk-lan-secret");
		harness.component.handleInput("\n");
		await flush();

		expect(harness.probes).toEqual([
			{ baseUrl: "http://gpu-box:8000/v1", apiKey: undefined },
			{ baseUrl: "http://gpu-box:8000/v1", apiKey: "sk-lan-secret" },
		]);
		expect(harness.connections).toEqual([
			{ baseUrl: "http://gpu-box:8000/v1", apiKey: "sk-lan-secret", models: [{ id: "served-model" }] },
		]);
	});

	it("reports a rejected key inline instead of leaving the screen", async () => {
		const harness = createHarness({ probe: async () => ({ status: "unauthorized" }) });

		typeText(harness.component, "10.0.0.5:8000");
		harness.component.handleInput("\n");
		await flush();
		typeText(harness.component, "wrong-key");
		harness.component.handleInput("\n");
		await flush();

		expect(visibleText(harness.component)).toContain("The server rejected that API key.");
		expect(harness.connections).toEqual([]);
	});

	it("shows an unreachable endpoint inline and lets the user edit and retry", async () => {
		let attempt = 0;
		const harness = createHarness({
			probe: async () => {
				attempt += 1;
				return attempt === 1
					? { status: "unreachable", detail: "connection refused" }
					: { status: "ok", models: [{ id: "served-model" }] };
			},
		});

		typeText(harness.component, "192.168.0.10:9999");
		harness.component.handleInput("\n");
		await flush();

		const failed = visibleText(harness.component);
		expect(failed).toContain("Could not reach http://192.168.0.10:9999/v1: connection refused");
		// No confirm screen, no key prompt: the address field is still there.
		expect(failed).toContain("Server address");
		expect(failed).not.toContain("API key");
		expect(harness.connections).toEqual([]);

		for (let i = 0; i < 4; i++) harness.component.handleInput("\x7f");
		typeText(harness.component, "8000");
		harness.component.handleInput("\n");
		await flush();

		expect(harness.connections).toEqual([
			{ baseUrl: "http://192.168.0.10:8000/v1", models: [{ id: "served-model" }] },
		]);
	});

	it("explains an endpoint that answers with no models", async () => {
		const harness = createHarness({ probe: async () => ({ status: "no-models" }) });

		typeText(harness.component, "192.168.0.10:8000");
		harness.component.handleInput("\n");
		await flush();

		expect(visibleText(harness.component)).toContain("answered but serves no models");
		expect(harness.connections).toEqual([]);
	});

	it("moves between the address field and the discovered rows with the arrow keys", async () => {
		const harness = createHarness({
			discover: async () => [
				{ baseUrl: "http://127.0.0.1:11434/v1", label: "Ollama", models: [{ id: "llama3" }] },
				{ baseUrl: "http://127.0.0.1:1234/v1", label: "LM Studio", models: [{ id: "mlx-model" }] },
			],
		});
		await flush();

		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\n");

		// Discovery already listed the models, so selecting a row does not re-probe.
		expect(harness.probes).toEqual([]);
		expect(harness.connections).toEqual([{ baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "mlx-model" }] }]);
	});

	it("never preselects a discovered loopback row", async () => {
		const harness = createHarness({
			discover: async () => [{ baseUrl: "http://127.0.0.1:11434/v1", label: "Ollama", models: [{ id: "llama3" }] }],
		});
		await flush();

		// Enter with the cursor untouched acts on the address field, so a loopback
		// server is never connected just because the scan found one.
		harness.component.handleInput("\n");
		expect(harness.connections).toEqual([]);
		expect(visibleText(harness.component)).toContain("Enter the server address first.");
	});

	it("rejects an address that is not a URL without probing", () => {
		const harness = createHarness({});

		typeText(harness.component, "not a url");
		harness.component.handleInput("\n");

		expect(harness.probes).toEqual([]);
		expect(visibleText(harness.component)).not.toContain("Connecting to");
	});

	it("cancels to the caller on Esc", () => {
		const harness = createHarness({});
		harness.component.handleInput("\x1b");
		expect(harness.cancels).toBe(1);
		expect(harness.connections).toEqual([]);
	});

	it("ignores a second Enter while the connection is being registered", async () => {
		const pending = Promise.withResolvers<void>();
		const connections: LocalEndpointConnection[] = [];
		const component = new LocalEndpointConnectComponent(
			{
				normalize: normalizeLocalEndpointInput,
				probe: async () => ({ status: "ok", models: [{ id: "served-model" }] }),
				discover: async () => [],
			},
			connection => {
				connections.push(connection);
				return pending.promise;
			},
			() => undefined,
		);

		typeText(component, "192.168.0.10:8000");
		component.handleInput("\n");
		await flush();
		component.handleInput("\n");
		await flush();

		expect(connections).toHaveLength(1);
	});
});

describe("local endpoint connect gateway summary", () => {
	const GATEWAY_MODELS: LocalModelChoice[] = [
		{ id: "/models/Qwen3.8-27B", contextLength: 262144 },
		{ id: "gpt-oss-120b" },
	];

	it("holds an announcing endpoint on a summary instead of jumping to model selection", async () => {
		const harness = createHarness({
			probe: async () => ({ status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 2 } }),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();

		// The models arrived, but nothing has been handed over yet.
		expect(harness.connections).toEqual([]);
		const summary = visibleText(harness.component);
		expect(summary).toContain("http://10.240.1.240:8788/v1");
		expect(summary).toContain("2 available, 2 described by the server");
		// The address field is gone: the summary owns the screen while it is up.
		expect(summary).not.toContain("Server address");
	});

	it("does not call a hint-only endpoint a metering gateway", async () => {
		// A `vibrato` hint is the general server-advertised model hint protocol,
		// open to any server in front of a model, so it is evidence that the
		// server described its models and no evidence at all that it counts a
		// key. Since the gateway attaches no quota headers to a successful model
		// list, this is the case production actually hits.
		const harness = createHarness({
			probe: async () => ({ status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 2 } }),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();

		const summary = visibleText(harness.component);
		expect(summary).toContain("Server-described models");
		expect(summary).toContain("describes what its models support");
		expect(summary).not.toContain("Usage gateway");
		expect(summary).not.toContain("meters requests per key");
	});

	it("calls the endpoint a metering gateway only once a quota header proved it", async () => {
		const harness = createHarness({
			probe: async () => ({
				status: "ok",
				models: GATEWAY_MODELS,
				gateway: { hintedModels: 2, quota: { limit: 200_000 } },
			}),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();

		const summary = visibleText(harness.component);
		expect(summary).toContain("Usage gateway");
		expect(summary).toContain("meters requests per key");
		expect(summary).not.toContain("Server-described models");
	});

	it("continues to model selection on Enter, with the connection the probe produced", async () => {
		const harness = createHarness({
			probe: async () => ({
				status: "ok",
				models: GATEWAY_MODELS,
				gateway: { hintedModels: 0, quota: { limit: 1 } },
			}),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();
		harness.component.handleInput("\n");
		await flush();

		expect(harness.connections).toEqual([{ baseUrl: "http://10.240.1.240:8788/v1", models: GATEWAY_MODELS }]);
		// Exactly one probe: the summary is drawn from the response already read.
		expect(harness.probes).toHaveLength(1);
	});

	it("leaves a plain endpoint's flow untouched", async () => {
		const harness = createHarness({
			probe: async () => ({ status: "ok", models: [{ id: "qwen3-coder" }] }),
		});

		typeText(harness.component, "192.168.0.10:8000");
		harness.component.handleInput("\n");
		await flush();

		expect(harness.connections).toEqual([
			{ baseUrl: "http://192.168.0.10:8000/v1", models: [{ id: "qwen3-coder" }] },
		]);
		expect(visibleText(harness.component)).not.toContain("Usage gateway");
	});

	it("shows the reported budget and reset without naming a window length", async () => {
		const now = Date.now();
		const harness = createHarness({
			probe: async () => ({
				status: "ok",
				models: GATEWAY_MODELS,
				gateway: {
					hintedModels: 0,
					quota: { limit: 200_000, remaining: 142_350, resetAt: now + 9_000_000 },
				},
			}),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();

		const summary = visibleText(harness.component);
		expect(summary).toContain("142,350 of 200,000 tokens left");
		expect(summary).toMatch(/Resets\s+2h 30m \(\d{2}[-:]\d{2}/);
		// The gateway's window is an operator setting it never sends, so no
		// wording here may imply a day, a date boundary, or a fixed length.
		for (const forbidden of ["daily", "today", "midnight", "per day", "24 hour", "24-hour"]) {
			expect(summary.toLowerCase()).not.toContain(forbidden);
		}
	});

	it("says where the budget will appear when nothing reported one", async () => {
		const harness = createHarness({
			probe: async () => ({ status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 1 } }),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();

		const summary = visibleText(harness.component);
		// Conditional, because a hint is no evidence that this server meters.
		expect(summary).toContain("No token budget was reported");
		expect(summary).toContain("If this server meters your key");
		expect(summary).toContain("status line once the first request comes back");
		expect(summary).not.toContain("Token budget ");
	});

	it("still explains the missing budget when a metering gateway sent no usable figure", async () => {
		const harness = createHarness({
			probe: async () => ({
				status: "ok",
				models: GATEWAY_MODELS,
				// Quota headers arrived, so the endpoint meters, but a lone
				// `remaining` describes no budget and produces no row.
				gateway: { hintedModels: 0, quota: { remaining: 142_350 } },
			}),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();

		const summary = visibleText(harness.component);
		expect(summary).toContain("Usage gateway");
		expect(summary).toContain("The model list carried no budget figures");
		expect(summary).not.toContain("142,350");
	});

	it("names the key without ever showing it", async () => {
		const harness = createHarness({
			probe: async (_baseUrl, apiKey) =>
				apiKey === "vug_secret"
					? { status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 1, quota: { limit: 200_000 } } }
					: { status: "unauthorized" },
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();
		typeText(harness.component, "vug_secret");
		harness.component.handleInput("\n");
		await flush();

		const summary = visibleText(harness.component);
		expect(summary).toContain("accepted by the gateway");
		expect(summary).not.toContain("vug_secret");
	});

	it("credits a hint-only server rather than a gateway for accepting the key", async () => {
		const harness = createHarness({
			probe: async (_baseUrl, apiKey) =>
				apiKey === "sk-lan"
					? { status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 1 } }
					: { status: "unauthorized" },
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();
		typeText(harness.component, "sk-lan");
		harness.component.handleInput("\n");
		await flush();

		const summary = visibleText(harness.component);
		expect(summary).toContain("accepted by the server");
		expect(summary).not.toContain("accepted by the gateway");
	});

	it("swallows every key but Enter while the summary is up", async () => {
		const harness = createHarness({
			probe: async () => ({ status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 1 } }),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();

		typeText(harness.component, "zzz");
		harness.component.handleInput("\x1b[B");
		const summary = visibleText(harness.component);
		expect(summary).not.toContain("zzz");
		expect(summary).toContain("Server-described models");
		expect(harness.connections).toEqual([]);
	});

	it("steps back to the address field on Esc without emitting or keeping anything", async () => {
		const harness = createHarness({
			probe: async () => ({ status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 1 } }),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();
		harness.component.handleInput("\x1b");

		const shown = visibleText(harness.component);
		// Back a step, not out of the screen: the address survives for editing.
		expect(harness.cancels).toBe(0);
		expect(harness.connections).toEqual([]);
		expect(shown).toContain("Server address");
		expect(shown).toContain("10.240.1.240:8788");
		expect(shown).not.toContain("Server-described models");

		// The dropped summary cannot be handed over by a later Enter. Enter now
		// belongs to the address field again, so it reprobes rather than emitting
		// the connection the user just backed out of.
		harness.component.handleInput("\n");
		await flush();
		expect(harness.probes).toHaveLength(2);
		expect(harness.connections).toEqual([]);
	});

	it("still leaves for the other providers on Esc from the address field", async () => {
		const harness = createHarness({
			probe: async () => ({ status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 1 } }),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();
		// First Esc dismisses the summary, second leaves the screen: the step
		// borrows Esc for one press only.
		harness.component.handleInput("\x1b");
		expect(harness.cancels).toBe(0);
		harness.component.handleInput("\x1b");
		expect(harness.cancels).toBe(1);
	});

	it("reports a spent token budget as a valid key rather than a dead server", async () => {
		const now = Date.now();
		const harness = createHarness({
			probe: async () => ({
				status: "quota-exhausted",
				quota: { limit: 200_000, used: 200_450, resetAt: now + 9_000_000 },
			}),
		});

		typeText(harness.component, "10.240.1.240:8788");
		harness.component.handleInput("\n");
		await flush();

		const shown = visibleText(harness.component);
		expect(shown).toContain("The key is valid; its token budget for this window is spent (200,450/200,000).");
		expect(shown).toMatch(/It comes back in 2h 30m \(\d{2}[-:]\d{2}/);
		// An editable address field, not a summary and not a key challenge.
		expect(shown).toContain("Server address");
		expect(shown).not.toContain("API key");
		expect(harness.connections).toEqual([]);
	});

	it("summarizes a discovered loopback server without claiming it meters", async () => {
		const harness = createHarness({
			discover: async () => [
				{
					baseUrl: "http://127.0.0.1:8788/v1",
					label: "vLLM",
					models: [{ id: "qwen3" }],
					gateway: { hintedModels: 1 },
				},
			],
		});
		await flush();

		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\n");

		expect(harness.connections).toEqual([]);
		const summary = visibleText(harness.component);
		expect(summary).toContain("Server-described models");
		// Loopback discovery probes unauthenticated, so "no key required" here
		// must not sit under a claim that the endpoint counts one.
		expect(summary).toContain("not required by this endpoint");
		expect(summary).not.toContain("Usage gateway");
		expect(summary).not.toContain("meters requests per key");

		harness.component.handleInput("\n");
		expect(harness.connections).toEqual([{ baseUrl: "http://127.0.0.1:8788/v1", models: [{ id: "qwen3" }] }]);
	});

	it("shows the accepted Enter as progress so a second one is not a dead key", async () => {
		const pending = Promise.withResolvers<void>();
		const connections: LocalEndpointConnection[] = [];
		const component = new LocalEndpointConnectComponent(
			{
				normalize: normalizeLocalEndpointInput,
				probe: async () => ({ status: "ok", models: GATEWAY_MODELS, gateway: { hintedModels: 1 } }),
				discover: async () => [],
			},
			connection => {
				connections.push(connection);
				return pending.promise;
			},
			() => undefined,
		);

		typeText(component, "10.240.1.240:8788");
		component.handleInput("\n");
		await flush();
		component.handleInput("\n");
		await flush();

		const shown = visibleText(component);
		// The footer gave way to a progress line, so the screen reads as busy
		// rather than leaving the summary looking like it ignored the key.
		expect(shown).toContain("Setting up http://10.240.1.240:8788/v1");
		expect(shown).not.toContain("[Enter to continue");

		// A second Enter is refused, and refused without disturbing the state.
		component.handleInput("\n");
		await flush();
		expect(connections).toHaveLength(1);
		expect(visibleText(component)).toBe(shown);

		pending.resolve();
	});
});

describe("describeReset", () => {
	it("pairs a countdown with the instant it lands on", () => {
		const now = Date.parse("2026-09-08T10:00:00Z");
		expect(describeReset(now + 9_000_000, now)).toMatch(/^2h 30m \(\d{2}[-:]\d{2}/);
		expect(describeReset(now + 25 * 60_000, now)).toMatch(/^25m \(\d{2}[-:]\d{2}/);
	});

	it("reports nothing for a reset that is missing or already past", () => {
		const now = Date.parse("2026-09-08T10:00:00Z");
		expect(describeReset(undefined, now)).toBeUndefined();
		expect(describeReset(now, now)).toBeUndefined();
		expect(describeReset(now - 60_000, now)).toBeUndefined();
		expect(describeReset(Number.NaN, now)).toBeUndefined();
	});

	it("dates the instant when the reset falls on another local day", () => {
		const now = Date.now();
		const tomorrow = new Date(now);
		tomorrow.setDate(tomorrow.getDate() + 1);
		expect(describeReset(tomorrow.getTime(), now)).toMatch(/\(\d{2}-\d{2} \d{2}:\d{2}\)$/);
	});
});

describe("local model picker", () => {
	it("formats context lengths the way a reader states them", () => {
		expect(formatModelContextLength(262144)).toBe("262K context");
		expect(formatModelContextLength(1_000_000)).toBe("1M context");
		expect(formatModelContextLength(512)).toBe("512 tokens context");
		expect(formatModelContextLength(undefined)).toBeNull();
	});

	it("lists every model with its context length and selects on Enter", () => {
		const picked: LocalModelChoice[] = [];
		const picker = new LocalModelPickerComponent(
			[
				{ id: "qwen3-coder", contextLength: 262144 },
				{ id: "gpt-oss-120b", contextLength: 128000 },
				{ id: "bare-model" },
			],
			"http://192.168.0.10:8000/v1",
			model => {
				picked.push(model);
			},
			() => undefined,
		);

		const rendered = visibleText(picker);
		expect(rendered).toContain("Choose a model");
		expect(rendered).toContain("3 model(s) served by http://192.168.0.10:8000/v1");
		expect(rendered).toContain("qwen3-coder  262K context");
		expect(rendered).toContain("gpt-oss-120b  128K context");
		expect(rendered).toContain("bare-model");

		picker.handleInput("\x1b[B");
		picker.handleInput("\n");
		expect(picked).toEqual([{ id: "gpt-oss-120b", contextLength: 128000 }]);
	});

	it("cancels on Esc", () => {
		let cancelled = 0;
		const picker = new LocalModelPickerComponent(
			[{ id: "only-model" }],
			"http://127.0.0.1:8000/v1",
			() => undefined,
			() => {
				cancelled += 1;
			},
		);
		picker.handleInput("\x1b");
		expect(cancelled).toBe(1);
	});
});
