// Issue #4794 e2e fixture: recursive force removal of an owned temporary
// directory inside the allowed temp root. The test preload's deletion guard
// must let this pass. Run only via scripts/safe-cleanup-guard.test.ts.
import { expect, test } from "bun:test";
import * as fs from "node:fs";

const probe = process.env.VIB_GUARD_PROBE_DIR;
test("guard allows owned in-root recursive removal", async () => {
	if (!probe) throw new Error("VIB_GUARD_PROBE_DIR is required");
	await fs.promises.rm(probe, { recursive: true, force: true });
	expect(fs.existsSync(probe)).toBe(false);
});
