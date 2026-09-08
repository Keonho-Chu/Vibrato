import { beforeAll, describe, expect, it } from "bun:test";
import {
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
