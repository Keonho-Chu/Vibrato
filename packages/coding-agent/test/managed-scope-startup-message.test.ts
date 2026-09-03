import { describe, expect, it } from "bun:test";
import {
	managedScopeStartupErrorMessage,
	managedScopeStartupRecoveryMessage,
} from "../src/session/managed-scope-startup-message";

function ownerMismatchStartupError(): Error {
	return new Error(managedScopeStartupErrorMessage("prepare", "owner_mismatch: prepare:root_authority"), {
		cause: { classification: "owner_mismatch", diagnostic: "prepare:root_authority" },
	});
}

describe("managedScopeStartupErrorMessage", () => {
	it("renders the path-free startup messages the session manager throws", () => {
		expect(managedScopeStartupErrorMessage("prepare", "acl_denied: prepare:tombstones_directory")).toBe(
			"Could not prepare managed session scope (acl_denied: prepare:tombstones_directory).",
		);
		expect(managedScopeStartupErrorMessage("resolve", "")).toBe("Could not resolve managed session scope.");
	});
});

describe("managedScopeStartupRecoveryMessage", () => {
	it("explains a Windows owner mismatch with the agent directory and the recovery steps", () => {
		const message = managedScopeStartupRecoveryMessage(
			ownerMismatchStartupError(),
			"C:\\Users\\someone\\.vib\\agent",
			"win32",
		);
		expect(message).toBeDefined();
		expect(message).toContain("Could not prepare managed session scope (owner_mismatch: prepare:root_authority).");
		expect(message).toContain("C:\\Users\\someone\\.vib\\agent");
		expect(message).toContain("Run as administrator");
		expect(message).toContain('takeown /F "C:\\Users\\someone\\.vib\\agent" /R /D Y');
		expect(message).toContain("S-1-16-12288");
	});

	it("explains a POSIX owner mismatch in terms of sudo and chown", () => {
		const message = managedScopeStartupRecoveryMessage(
			ownerMismatchStartupError(),
			"/home/someone/.vib/agent",
			"linux",
		);
		expect(message).toContain("sudo");
		expect(message).toContain('chown -R "$(id -u)" "/home/someone/.vib/agent"');
		expect(message).not.toContain("takeown");
	});

	it("also recognizes the resolve-phase startup error", () => {
		const error = new Error(managedScopeStartupErrorMessage("resolve", ""), {
			cause: { classification: "owner_mismatch" },
		});
		expect(managedScopeStartupRecoveryMessage(error, "/agent", "darwin")).toContain("owned by a different user");
	});

	it("stays silent for every other startup failure", () => {
		const aclDenied = new Error(
			"Could not prepare managed session scope (acl_denied: prepare:tombstones_directory).",
			{
				cause: { classification: "acl_denied", diagnostic: "prepare:tombstones_directory" },
			},
		);
		expect(managedScopeStartupRecoveryMessage(aclDenied, "/agent", "win32")).toBeUndefined();
		expect(managedScopeStartupRecoveryMessage(new Error("owner_mismatch"), "/agent", "win32")).toBeUndefined();
		expect(managedScopeStartupRecoveryMessage("owner_mismatch", "/agent", "win32")).toBeUndefined();
		expect(managedScopeStartupRecoveryMessage(undefined, "/agent", "win32")).toBeUndefined();
	});
});
