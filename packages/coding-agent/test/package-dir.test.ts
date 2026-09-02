import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getPackageDir } from "@vib-rato/coding-agent/config";

const ORIGINAL_VIB_PACKAGE_DIR = process.env.VIB_PACKAGE_DIR;
const ORIGINAL_PI_PACKAGE_DIR = process.env.PI_PACKAGE_DIR;

describe("getPackageDir", () => {
	afterEach(() => {
		process.env.VIB_PACKAGE_DIR = ORIGINAL_VIB_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = ORIGINAL_PI_PACKAGE_DIR;
	});

	it("prefers VIB_PACKAGE_DIR over legacy PI_PACKAGE_DIR", () => {
		const vibPackageDir = path.join(os.tmpdir(), "vib-package-dir");
		const legacyPackageDir = path.join(os.tmpdir(), "legacy-pi-package-dir");

		process.env.VIB_PACKAGE_DIR = vibPackageDir;
		process.env.PI_PACKAGE_DIR = legacyPackageDir;

		expect(getPackageDir()).toBe(vibPackageDir);
	});

	it("keeps PI_PACKAGE_DIR as a legacy fallback", () => {
		const legacyPackageDir = path.join(os.tmpdir(), "legacy-pi-package-dir");

		delete process.env.VIB_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = legacyPackageDir;

		expect(getPackageDir()).toBe(legacyPackageDir);
	});
});
