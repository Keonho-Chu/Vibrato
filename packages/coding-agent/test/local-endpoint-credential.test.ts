import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, hookFetch, setAgentDir } from "@vib-rato/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";
import { registerLocalEndpoint } from "../src/setup/local-endpoint";

let tempRoot: string | undefined;
const originalAgentDir = getAgentDir();

async function tempAgent(): Promise<string> {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vib-local-endpoint-credential-"));
	setAgentDir(path.join(tempRoot, "agent"));
	return path.join(tempRoot, "agent", "models.yml");
}

afterEach(async () => {
	setAgentDir(originalAgentDir);
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

const BASE_URL = "http://10.0.0.9:8788/v1";

/** A gateway that lists its model only to a caller presenting the issued key. */
function keyedUpstream(headersSeen: Array<string | undefined>) {
	return hookFetch((input, init) => {
		if (String(input) !== `${BASE_URL}/models`) return new Response(null, { status: 404 });
		const headers = init?.headers as Headers | Record<string, string> | undefined;
		const auth = (headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization) ?? undefined;
		headersSeen.push(auth);
		if (auth !== "Bearer vug_issued-key") return new Response(JSON.stringify({ error: "no key" }), { status: 401 });
		return new Response(JSON.stringify({ data: [{ id: "VIB", max_model_len: 212144 }] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
}

describe("local endpoint key persistence", () => {
	it("a fresh process sends the key the connect screen registered", async () => {
		const modelsPath = await tempAgent();
		await registerLocalEndpoint({ baseUrl: BASE_URL, apiKey: "vug_issued-key" });
		const headersSeen: Array<string | undefined> = [];
		using _hook = keyedUpstream(headersSeen);
		const authStorage = await AuthStorage.create(getAgentDbPath());
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			await registry.refreshProvider("local");
			expect(headersSeen).toEqual(["Bearer vug_issued-key"]);
			expect(registry.getProviderDiscoveryState("local")?.status).toBe("ok");
			expect(registry.getAvailable().map(model => `${model.provider}/${model.id}`)).toEqual(["local/VIB"]);
			expect(await registry.getApiKeyForProvider("local")).toBe("vug_issued-key");
		} finally {
			authStorage.close();
		}
	});

	it("the running session that registered the endpoint sends the key on its next refresh", async () => {
		const modelsPath = await tempAgent();
		// The TUI's registry and auth storage exist before the connect screen runs. The key has
		// to be written through that store: a private store writes the same row, but this
		// registry never rereads the database and would keep the provider unauthenticated.
		const authStorage = await AuthStorage.create(getAgentDbPath());
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			await registerLocalEndpoint({ baseUrl: BASE_URL, apiKey: "vug_issued-key", authStorage });
			const headersSeen: Array<string | undefined> = [];
			using _hook = keyedUpstream(headersSeen);
			await registry.refresh("online");
			expect(headersSeen).toEqual(["Bearer vug_issued-key"]);
			expect(registry.getProviderDiscoveryState("local")?.status).toBe("ok");
			expect(registry.getAvailable().map(model => `${model.provider}/${model.id}`)).toEqual(["local/VIB"]);
			expect(await registry.getApiKeyForProvider("local")).toBe("vug_issued-key");
		} finally {
			authStorage.close();
		}
	});

	it("a key written through the session's store is also on disk for the next process", async () => {
		const modelsPath = await tempAgent();
		const session = await AuthStorage.create(getAgentDbPath());
		try {
			await registerLocalEndpoint({ baseUrl: BASE_URL, apiKey: "vug_issued-key", authStorage: session });
		} finally {
			session.close();
		}
		expect(await Bun.file(modelsPath).text()).not.toContain("vug_issued-key");
		const headersSeen: Array<string | undefined> = [];
		using _hook = keyedUpstream(headersSeen);
		const next = await AuthStorage.create(getAgentDbPath());
		try {
			const registry = new ModelRegistry(next, modelsPath);
			await registry.refreshProvider("local");
			expect(headersSeen).toEqual(["Bearer vug_issued-key"]);
			expect(registry.getProviderDiscoveryState("local")?.status).toBe("ok");
		} finally {
			next.close();
		}
	});
});
