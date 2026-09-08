import { afterAll, describe, expect, it } from "bun:test";
import { type Api, closeModelCache, type Model, writeModelCache } from "@vib-rato/ai";
import { formatDiscoveryErrorHint } from "../src/config/discovery-failure-message";
import { ModelDiscoveryManager } from "../src/config/model-discovery-manager";

/**
 * Issue #14 policy 4 — a gateway that has spent its quota-window allowance answers
 * `/v1/models` with 429 exactly as it answers a completion (issue #8 §4).
 * Discovery must then keep serving what is already approved and cached, and the
 * message the user reads must name the limit rather than the key.
 */

const PROVENANCE = "issue-14-discovery-provenance";

function model(id: string): Model<Api> {
	return {
		provider: "gateway",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://gateway.example.com/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 1,
		maxTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

describe("issue #14 policy 4 — /v1/models 429", () => {
	const cacheDbPath = `${Bun.env.TMPDIR ?? "/tmp"}/issue-14-discovery-${crypto.randomUUID()}.db`;

	afterAll(() => {
		closeModelCache(cacheDbPath);
	});

	it("keeps serving the valid discovery cache when the models list is rate limited", async () => {
		const provider = { provider: "gateway" };
		writeModelCache(
			"gateway",
			Date.now(),
			[model("gateway-large")],
			true,
			"",
			cacheDbPath,
			["gateway-large"],
			PROVENANCE,
		);

		const manager = new ModelDiscoveryManager<typeof provider>();
		manager.setProviders([provider]);
		const result = await manager.discover(provider, "online", {
			cacheDbPath,
			cacheDynamicModelProvenance: PROVENANCE,
			requiresAuth: () => false,
			peekApiKey: async () => undefined,
			isAuthenticated: () => true,
			fetchModels: async () => {
				throw new Error("HTTP 429 from https://gateway.example.com/v1/models");
			},
		});

		// The models the user already had stay available; the failure is reported
		// as a stale catalog, never as an empty or unauthenticated provider.
		expect(result.models.map(entry => entry.id)).toEqual(["gateway-large"]);
		expect(result.state.status).toBe("cached");
		expect(result.state.status).not.toBe("unauthenticated");
		expect(result.state.error).toContain("HTTP 429");
	});

	it("tells the user the limit was reached instead of blaming the key", () => {
		const hint = formatDiscoveryErrorHint("HTTP 429 from https://gateway.example.com/v1/models");
		expect(hint).toContain("Usage limit reached");
		expect(hint).toContain("https://gateway.example.com/v1/models");
		// The two readings the message must not invite: a rejected credential, or a
		// model that has been removed from the provider.
		expect(hint).toContain("Configured and cached models stay available");
		expect(hint).not.toContain("Discovery failed");
		expect(hint?.toLowerCase()).not.toContain("credential");
		expect(hint?.toLowerCase()).not.toContain("apikey");
	});

	it("leaves the other discovery messages exactly as they were", () => {
		expect(formatDiscoveryErrorHint("HTTP 404 from https://gateway.example.com/models")).toBe(
			"  Discovery endpoint https://gateway.example.com/models returned 404. Point baseUrl at the host that serves /models (usually .../v1).",
		);
		expect(formatDiscoveryErrorHint("HTTP 500 from https://gateway.example.com/v1/models")).toBe(
			"  Discovery failed: HTTP 500 from https://gateway.example.com/v1/models",
		);
		expect(formatDiscoveryErrorHint("connection refused")).toBeUndefined();
		expect(formatDiscoveryErrorHint(undefined)).toBeUndefined();
	});
});
