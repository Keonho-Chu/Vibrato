import { describe, expect, it } from "bun:test";
import {
	fingerprintCredential,
	GATEWAY_QUOTA_HEADER_NAMES,
	type GatewayQuotaKey,
	GatewayQuotaObserver,
	gatewayQuotaWindow,
	hasGatewayQuotaHeaders,
} from "../src/session/gateway-quota-observer";

const KEY: GatewayQuotaKey = {
	provider: "vug",
	baseUrl: "https://gateway.internal/v1",
	credentialId: "session-a",
	sessionId: "session-a",
};

const AT = Date.UTC(2026, 8, 8, 12, 0, 0);

function observer(): GatewayQuotaObserver {
	return new GatewayQuotaObserver();
}

describe("gateway quota observer: success responses", () => {
	it("records the window budget, reset instant, and last queue wait", () => {
		const o = observer();
		const changed = o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: {
				"x-vug-daily-limit": "1000000",
				"x-vug-daily-remaining": "400000",
				"x-vug-daily-reset": String(Math.floor(AT / 1000) + 3600),
				"x-vug-queued-ms": "1250",
			},
			at: AT,
		});

		expect(changed).toBe(true);
		expect(o.state).toMatchObject({
			observedAt: AT,
			limit: 1_000_000,
			remaining: 400_000,
			resetAt: AT + 3_600_000,
			lastQueuedMs: 1250,
		});
		expect(o.state?.busy).toBeUndefined();
		expect(o.state?.exhausted).toBeUndefined();
	});

	it("accepts either header casing", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "X-VUG-Daily-Limit": "100", "X-Vug-Daily-Remaining": "25" },
			at: AT,
		});

		expect(o.state?.limit).toBe(100);
		expect(o.state?.remaining).toBe(25);
	});

	it("ignores a response that carries none of the selected headers", () => {
		const o = observer();
		const changed = o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: {
				"x-request-id": "abc",
				"retry-after": "5",
				"x-vug-unrelated": "99",
				"content-type": "application/json",
			},
			at: AT,
		});

		expect(changed).toBe(false);
		expect(o.state).toBeNull();
	});

	it("leaves an existing observation intact when a later response carries no gateway header", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "100", "x-vug-daily-remaining": "60" },
			at: AT,
		});

		const changed = o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "content-type": "application/json" },
			at: AT + 1000,
		});

		expect(changed).toBe(false);
		expect(o.state?.remaining).toBe(60);
		expect(o.state?.observedAt).toBe(AT);
	});

	it("drops malformed counts instead of coercing them", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1e6", "x-vug-daily-remaining": "-5", "x-vug-queued-ms": "12" },
			at: AT,
		});

		expect(o.state?.limit).toBeUndefined();
		expect(o.state?.remaining).toBeUndefined();
		expect(o.state?.lastQueuedMs).toBe(12);
	});

	it("never decrements the observed remaining locally", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "700" },
			at: AT,
		});
		// A second response that reports only a queue wait must not move the budget.
		o.observe({ key: KEY, kind: "success", status: 200, headers: { "x-vug-queued-ms": "40" }, at: AT + 5_000 });

		expect(o.state?.remaining).toBe(700);
	});
});

describe("gateway quota observer: reset instants", () => {
	const cases: Array<[string, string, number | undefined]> = [
		["epoch seconds", String(Math.floor(AT / 1000)), AT],
		["epoch milliseconds", String(AT), AT],
		["ISO-8601 with Z", "2026-09-09T00:00:00Z", Date.parse("2026-09-09T00:00:00Z")],
		["ISO-8601 with offset", "2026-09-09T09:00:00+09:00", Date.parse("2026-09-09T09:00:00+09:00")],
		["bare local datetime", "2026-09-09T00:00:00", undefined],
		["bare date", "2026-09-09", undefined],
		["small integer", "3600", undefined],
		["garbage", "midnight KST", undefined],
	];

	for (const [name, raw, expected] of cases) {
		it(`${expected === undefined ? "rejects" : "accepts"} ${name}`, () => {
			const o = observer();
			o.observe({
				key: KEY,
				kind: "success",
				status: 200,
				headers: { "x-vug-daily-limit": "10", "x-vug-daily-remaining": "4", "x-vug-daily-reset": raw },
				at: AT,
			});

			expect(o.state?.resetAt).toBe(expected as number | undefined);
		});
	}
});

describe("gateway quota observer: token limit rejection", () => {
	it("records used, limit, and reset from a 429 and clears the stale remaining", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "40" },
			at: AT,
		});

		const changed = o.observe({
			key: KEY,
			kind: "failure",
			status: 429,
			headers: {
				"x-vug-daily-limit": "1000",
				"x-vug-daily-used": "1000",
				"x-vug-daily-reset": String(AT + 7_200_000),
				"retry-after": "43200",
			},
			at: AT + 1_000,
		});

		expect(changed).toBe(true);
		expect(o.state?.exhausted).toEqual({ used: 1000, limit: 1000, resetAt: AT + 7_200_000 });
		expect(o.state?.remaining).toBeUndefined();
		expect(o.state?.busy).toBeUndefined();
	});

	it("ignores a 429 that carries no gateway quota headers", () => {
		const o = observer();
		const changed = o.observe({ key: KEY, kind: "failure", status: 429, headers: { "retry-after": "60" }, at: AT });

		expect(changed).toBe(false);
		expect(o.state).toBeNull();
	});

	it("clears the exhaustion once the gateway serves a request again", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "failure",
			status: 429,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-used": "1000" },
			at: AT,
		});
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "1000" },
			at: AT + 60_000,
		});

		expect(o.state?.exhausted).toBeUndefined();
		expect(o.state?.remaining).toBe(1000);
	});
});

describe("gateway quota observer: admission rejection", () => {
	it("records queue depth, inflight, and retry-after from a 503", () => {
		const o = observer();
		const changed = o.observe({
			key: KEY,
			kind: "failure",
			status: 503,
			headers: { "x-vug-queue-depth": "12", "x-vug-inflight": "4", "retry-after": "5" },
			at: AT,
		});

		expect(changed).toBe(true);
		expect(o.state?.busy).toEqual({ code: 503, queueDepth: 12, inflight: 4, retryAfterMs: 5000 });
	});

	it("reads an HTTP-date retry-after as a delay from the observation instant", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "failure",
			status: 503,
			headers: { "x-vug-queue-depth": "3", "retry-after": new Date(AT + 8_000).toUTCString() },
			at: AT,
		});

		expect(o.state?.busy?.retryAfterMs).toBe(8000);
	});

	it("keeps the observed budget and drops a stale exhaustion when congestion follows", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "failure",
			status: 429,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-used": "1000" },
			at: AT,
		});
		o.observe({ key: KEY, kind: "failure", status: 503, headers: { "x-vug-queue-depth": "7" }, at: AT + 1000 });

		expect(o.state?.exhausted).toBeUndefined();
		expect(o.state?.busy).toEqual({ code: 503, queueDepth: 7 });
		expect(o.state?.limit).toBe(1000);
	});

	it("ignores a 503 with no gateway admission headers", () => {
		const o = observer();
		const changed = o.observe({ key: KEY, kind: "failure", status: 503, headers: { "retry-after": "5" }, at: AT });

		expect(changed).toBe(false);
		expect(o.state).toBeNull();
	});

	it("clears congestion after the next served request", () => {
		const o = observer();
		o.observe({ key: KEY, kind: "failure", status: 503, headers: { "x-vug-queue-depth": "7" }, at: AT });
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "10", "x-vug-daily-remaining": "9" },
			at: AT + 1000,
		});

		expect(o.state?.busy).toBeUndefined();
	});
});

describe("gateway quota observer: statuses that report no quota", () => {
	const gatewayHeaders = { "x-vug-daily-limit": "10", "x-vug-daily-remaining": "1", "x-vug-queue-depth": "3" };

	for (const kind of ["success", "failure"] as const) {
		for (const status of [401, 404, 500]) {
			it(`ignores a ${kind} ${status} even when it carries gateway headers`, () => {
				const o = observer();
				const changed = o.observe({ key: KEY, kind, status, headers: gatewayHeaders, at: AT });

				expect(changed).toBe(false);
				expect(o.state).toBeNull();
			});
		}
	}

	it("ignores a status-less failure instead of reading it as a served request", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "failure",
			status: 429,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-used": "1000" },
			at: AT,
		});

		// A socket error or a typed provider code inside an HTTP 200 envelope
		// reaches the failure path with no status at all. It proves nothing about
		// the budget, so the standing limit-reached note must survive it.
		const changed = o.observe({ key: KEY, kind: "failure", headers: gatewayHeaders, at: AT + 1000 });

		expect(changed).toBe(false);
		expect(o.state?.exhausted).toEqual({ used: 1000, limit: 1000 });
	});

	it("ignores a status-less success for the same reason", () => {
		const o = observer();
		o.observe({ key: KEY, kind: "failure", status: 503, headers: { "x-vug-queue-depth": "7" }, at: AT });

		const changed = o.observe({ key: KEY, kind: "success", headers: gatewayHeaders, at: AT + 1000 });

		expect(changed).toBe(false);
		expect(o.state?.busy).toEqual({ code: 503, queueDepth: 7 });
	});

	it("does not let a 429 arriving on the success path clear a congestion note", () => {
		const o = observer();
		o.observe({ key: KEY, kind: "failure", status: 503, headers: { "x-vug-queue-depth": "7" }, at: AT });

		const changed = o.observe({ key: KEY, kind: "success", status: 429, headers: gatewayHeaders, at: AT + 1000 });

		expect(changed).toBe(false);
		expect(o.state?.busy).toEqual({ code: 503, queueDepth: 7 });
	});
});

describe("gateway quota observer: account and session boundaries", () => {
	const success = { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "250" };

	const rotations: Array<[string, GatewayQuotaKey]> = [
		["credential", { ...KEY, credentialId: "session-b" }],
		["session", { ...KEY, sessionId: "session-b" }],
		["gateway base url", { ...KEY, baseUrl: "https://other.internal/v1" }],
		["provider", { ...KEY, provider: "vug-secondary" }],
	];

	for (const [what, rotated] of rotations) {
		it(`discards the previous state when the ${what} changes`, () => {
			const o = observer();
			o.observe({ key: KEY, kind: "success", status: 200, headers: success, at: AT });
			o.observe({ key: rotated, kind: "success", status: 200, headers: { "x-vug-queued-ms": "5" }, at: AT + 1000 });

			expect(o.state?.key).toEqual(rotated);
			expect(o.state?.limit).toBeUndefined();
			expect(o.state?.remaining).toBeUndefined();
			expect(o.state?.lastQueuedMs).toBe(5);
		});
	}

	it("clears everything on request", () => {
		const o = observer();
		o.observe({ key: KEY, kind: "success", status: 200, headers: success, at: AT });
		o.clear();

		expect(o.state).toBeNull();
	});
});

describe("gateway quota observer: concurrent responses", () => {
	it("keeps the latest observation when responses complete out of order", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "300" },
			at: AT + 5_000,
		});
		// An in-flight request that started earlier lands afterwards. Its sample
		// is older, so it must not roll the display back.
		const changed = o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "800" },
			at: AT,
		});

		expect(changed).toBe(false);
		expect(o.state?.remaining).toBe(300);
		expect(o.state?.observedAt).toBe(AT + 5_000);
	});

	it("lets a same-instant observation apply so equal timestamps still land", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "300" },
			at: AT,
		});
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "290" },
			at: AT,
		});

		expect(o.state?.remaining).toBe(290);
	});

	it("does not let a stale failure overwrite a newer success", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "300" },
			at: AT + 5_000,
		});
		o.observe({ key: KEY, kind: "failure", status: 503, headers: { "x-vug-queue-depth": "9" }, at: AT });

		expect(o.state?.busy).toBeUndefined();
		expect(o.state?.remaining).toBe(300);
	});
});

describe("gateway quota window projection", () => {
	it("returns nothing when the gateway was never observed", () => {
		expect(gatewayQuotaWindow(null)).toBeNull();
	});

	it("returns nothing when only a queue wait was observed", () => {
		const o = observer();
		o.observe({ key: KEY, kind: "success", status: 200, headers: { "x-vug-queued-ms": "900" }, at: AT });

		expect(gatewayQuotaWindow(o.state, AT)).toBeNull();
	});

	it("projects the used share of the window budget", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-remaining": "250" },
			at: AT,
		});

		expect(gatewayQuotaWindow(o.state, AT)).toEqual({ label: "vug", percent: 75 });
	});

	it("adds a relative reset only when the gateway sent one", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: {
				"x-vug-daily-limit": "1000",
				"x-vug-daily-remaining": "250",
				"x-vug-daily-reset": String(AT + 90 * 60_000),
			},
			at: AT,
		});

		expect(gatewayQuotaWindow(o.state, AT)).toEqual({
			label: "vug",
			percent: 75,
			resetValue: 90,
			resetUnit: "m",
		});
	});

	it("omits the percent when only half of the used/limit pair was observed", () => {
		const o = observer();
		o.observe({ key: KEY, kind: "success", status: 200, headers: { "x-vug-daily-limit": "1000" }, at: AT });

		expect(gatewayQuotaWindow(o.state, AT)).toBeNull();
	});

	it("marks a limit-reached gateway with its reset", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "failure",
			status: 429,
			headers: {
				"x-vug-daily-limit": "1000",
				"x-vug-daily-used": "1000",
				"x-vug-daily-reset": String(AT + 11 * 3_600_000),
			},
			at: AT,
		});

		expect(gatewayQuotaWindow(o.state, AT)).toEqual({
			label: "vug",
			percent: 100,
			resetValue: 660,
			resetUnit: "m",
			note: "limit reached",
		});
	});

	it("marks congestion with the queue depth", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "failure",
			status: 503,
			headers: { "x-vug-queue-depth": "12", "x-vug-inflight": "4" },
			at: AT,
		});

		expect(gatewayQuotaWindow(o.state, AT)).toEqual({ label: "vug", note: "busy queue 12" });
	});

	it("falls back to a plain congestion note when no depth was reported", () => {
		const o = observer();
		o.observe({ key: KEY, kind: "failure", status: 503, headers: { "x-vug-inflight": "4" }, at: AT });

		expect(gatewayQuotaWindow(o.state, AT)).toEqual({ label: "vug", note: "busy" });
	});

	it("stops reporting a limit once its own reset instant has passed", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "failure",
			status: 429,
			headers: {
				"x-vug-daily-limit": "1000",
				"x-vug-daily-used": "1000",
				"x-vug-daily-reset": String(AT + 60 * 60_000),
			},
			at: AT,
		});

		// Just before the reset the note still stands, with a real countdown.
		expect(gatewayQuotaWindow(o.state, AT + 59 * 60_000)).toMatchObject({
			note: "limit reached",
			resetValue: 1,
			resetUnit: "m",
		});
		// After it, an idle session must not keep asserting the limit, and must
		// never freeze on a `(0m)` countdown that reads as "any moment now".
		expect(gatewayQuotaWindow(o.state, AT + 60 * 60_000)).toBeNull();
		expect(gatewayQuotaWindow(o.state, AT + 5 * 3_600_000)).toBeNull();
	});

	it("keeps reporting a limit that came without a reset instant", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "failure",
			status: 429,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-used": "1000" },
			at: AT,
		});

		// Nothing said when this clears, so there is no basis for expiring it.
		expect(gatewayQuotaWindow(o.state, AT + 5 * 3_600_000)).toEqual({
			label: "vug",
			percent: 100,
			note: "limit reached",
		});
	});

	it("drops a stale countdown from a served observation but keeps the share", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: {
				"x-vug-daily-limit": "1000",
				"x-vug-daily-remaining": "250",
				"x-vug-daily-reset": String(AT + 60_000),
			},
			at: AT,
		});

		expect(gatewayQuotaWindow(o.state, AT + 120_000)).toEqual({ label: "vug", percent: 75 });
	});

	it("drops a stale countdown from a congestion note but keeps the note", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: {
				"x-vug-daily-limit": "1000",
				"x-vug-daily-remaining": "250",
				"x-vug-daily-reset": String(AT + 60_000),
			},
			at: AT,
		});
		o.observe({ key: KEY, kind: "failure", status: 503, headers: { "x-vug-queue-depth": "4" }, at: AT + 1000 });

		expect(gatewayQuotaWindow(o.state, AT + 120_000)).toEqual({
			label: "vug",
			percent: 75,
			note: "busy queue 4",
		});
	});

	it("never projects the previous request's queue wait", () => {
		const o = observer();
		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { "x-vug-daily-limit": "100", "x-vug-daily-remaining": "50", "x-vug-queued-ms": "9000" },
			at: AT,
		});

		const window = gatewayQuotaWindow(o.state, AT);
		expect(o.state?.lastQueuedMs).toBe(9000);
		expect(JSON.stringify(window)).not.toContain("9000");
		expect(window?.note).toBeUndefined();
	});
});

describe("credential fingerprint", () => {
	it("gives the same credential the same identity and different credentials different ones", () => {
		expect(fingerprintCredential("sk-alpha", "scope")).toBe(fingerprintCredential("sk-alpha", "scope"));
		expect(fingerprintCredential("sk-alpha", "scope")).not.toBe(fingerprintCredential("sk-beta", "scope"));
	});

	it("never contains the credential itself", () => {
		const secret = "sk-live-super-secret-token";

		const fingerprint = fingerprintCredential(secret, "scope");

		expect(fingerprint).not.toContain(secret);
		expect(fingerprint).not.toContain("super");
		expect(fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
	});

	it("falls back to the session scope so unauthenticated sessions stay separate", () => {
		expect(fingerprintCredential(undefined, "session-a")).toBe("scope:session-a");
		expect(fingerprintCredential("", "session-a")).toBe("scope:session-a");
		expect(fingerprintCredential(undefined, "session-a")).not.toBe(fingerprintCredential(undefined, "session-b"));
	});

	it("discards observed state when the credential rotates under a fixed session scope", () => {
		const o = observer();
		const scope = "one-session";
		const before: GatewayQuotaKey = { ...KEY, credentialId: fingerprintCredential("sk-old", scope) };
		const after: GatewayQuotaKey = { ...KEY, credentialId: fingerprintCredential("sk-new", scope) };
		o.observe({
			key: before,
			kind: "failure",
			status: 429,
			headers: { "x-vug-daily-limit": "1000", "x-vug-daily-used": "1000" },
			at: AT,
		});

		o.observe({
			key: after,
			kind: "success",
			status: 200,
			headers: { "x-vug-queued-ms": "12" },
			at: AT + 1000,
		});

		// The exhausted key's budget must not follow the rotation onto the new one.
		expect(o.state?.key.credentialId).toBe(after.credentialId);
		expect(o.state?.exhausted).toBeUndefined();
		expect(o.state?.limit).toBeUndefined();
	});
});

describe("gateway response detection", () => {
	it("recognises a response by any of the gateway's own headers", () => {
		for (const name of GATEWAY_QUOTA_HEADER_NAMES.filter(header => header !== "retry-after")) {
			expect(hasGatewayQuotaHeaders({ [name]: "1" })).toBe(true);
			expect(hasGatewayQuotaHeaders({ [name.toUpperCase()]: "1" })).toBe(true);
		}
	});

	it("does not treat retry-after as evidence that the gateway answered", () => {
		// Any provider may send it, so on its own it says nothing about who
		// answered — and treating it as a gateway signal would make an ordinary
		// 503 pay for a credential lookup.
		expect(hasGatewayQuotaHeaders({ "retry-after": "5" })).toBe(false);
		expect(hasGatewayQuotaHeaders({ "retry-after-ms": "5000" })).toBe(false);
	});

	it("returns false for ordinary responses and for nothing at all", () => {
		expect(hasGatewayQuotaHeaders(undefined)).toBe(false);
		expect(hasGatewayQuotaHeaders({})).toBe(false);
		expect(hasGatewayQuotaHeaders({ "content-type": "application/json", "x-request-id": "abc" })).toBe(false);
		expect(hasGatewayQuotaHeaders({ "x-vug-something-else": "1" })).toBe(false);
	});

	it("ignores a header whose value is not a string", () => {
		expect(hasGatewayQuotaHeaders({ "x-vug-daily-limit": undefined })).toBe(false);
	});
});

describe("gateway quota header read set", () => {
	it("names exactly the headers this module reads", () => {
		expect([...GATEWAY_QUOTA_HEADER_NAMES]).toEqual([
			"x-vug-daily-limit",
			"x-vug-daily-remaining",
			"x-vug-daily-reset",
			"x-vug-daily-used",
			"x-vug-queued-ms",
			"x-vug-queue-depth",
			"x-vug-inflight",
			"retry-after",
		]);
	});

	it("reads nothing outside that set, whatever else the response carries", () => {
		const o = observer();
		const noise = Object.fromEntries(
			[
				"authorization",
				"x-api-key",
				"set-cookie",
				"x-vug-internal-secret",
				"x-vug-operator-note",
				"x-forwarded-for",
			].map(name => [name, "must-not-be-read"]),
		);

		o.observe({
			key: KEY,
			kind: "success",
			status: 200,
			headers: { ...noise, "x-vug-daily-limit": "100", "x-vug-daily-remaining": "40" },
			at: AT,
		});

		expect(JSON.stringify(o.state)).not.toContain("must-not-be-read");
		expect(o.state).toMatchObject({ limit: 100, remaining: 40 });
	});
});
