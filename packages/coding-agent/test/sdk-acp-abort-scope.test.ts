import { expect, test } from "bun:test";
import { resolveAcpAbortScope } from "../src/modes/acp/abort-scope";

test("resolveAcpAbortScope defaults to turn for an external client turn-end", () => {
	expect(resolveAcpAbortScope(undefined, {})).toBe("turn");
	expect(resolveAcpAbortScope(null, {})).toBe("turn");
	expect(resolveAcpAbortScope({}, {})).toBe("turn");
	expect(resolveAcpAbortScope({ vib: {} }, {})).toBe("turn");
});

test("resolveAcpAbortScope honors _meta.vib.abortScope over the environment", () => {
	expect(resolveAcpAbortScope({ vib: { abortScope: "turn" } }, { VIB_ACP_ABORT_SCOPE: "owned" })).toBe("turn");
	expect(resolveAcpAbortScope({ vib: { abortScope: "owned" } }, { VIB_ACP_ABORT_SCOPE: "turn" })).toBe("owned");
});

test("resolveAcpAbortScope falls back to VIB_ACP_ABORT_SCOPE when _meta is absent", () => {
	expect(resolveAcpAbortScope(undefined, { VIB_ACP_ABORT_SCOPE: "turn" })).toBe("turn");
	expect(resolveAcpAbortScope({}, { VIB_ACP_ABORT_SCOPE: "owned" })).toBe("owned");
});

test("resolveAcpAbortScope rejects malformed metadata and env values safely to turn", () => {
	expect(resolveAcpAbortScope({ vib: { abortScope: "everything" } }, {})).toBe("turn");
	expect(resolveAcpAbortScope({ vib: { abortScope: 42 } }, { VIB_ACP_ABORT_SCOPE: "turn" })).toBe("turn");
	expect(resolveAcpAbortScope(undefined, { VIB_ACP_ABORT_SCOPE: "invalid" })).toBe("turn");
});
