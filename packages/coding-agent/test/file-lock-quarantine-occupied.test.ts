import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inspectFileLockRemovalTransition, withFileLock } from "../src/config/file-lock";

// Regression for issue #6: a `<lock>.removing` tree left behind by a predecessor
// (still scrubbing, or killed mid-removal) used to make the next release fail
// with `quarantine_collision`, re-expressed as EACCES, which killed ordinary
// writer processes. A live predecessor is waited out and never displaced; a
// provably dead one has its abandoned transition finished through the same
// identity-bound exact removal, and the canonical lock name stays usable.

const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
		await child.exited;
	}
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(prefix: string): Promise<{ target: string; transition: string; root: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	const target = path.join(root, "index");
	return { root, target, transition: `${target}.lock.removing` };
}

async function writeForeignTransition(transition: string, owner: { pid: number }): Promise<void> {
	await fs.mkdir(transition, { mode: 0o700 });
	await fs.writeFile(path.join(transition, "info"), JSON.stringify({ pid: owner.pid, timestamp: Date.now() }));
}

async function deadPid(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	return child.pid;
}

function livePid(): number {
	const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	children.push(child);
	return child.pid;
}

describe("file lock release behind an occupied quarantine name (#6)", () => {
	it("waits out a transient occupant that clears during the release budget", async () => {
		const { root, target, transition } = await fixture("vib-lock-transition-transient-");
		let cleared = false;
		await withFileLock(target, async () => {
			// A predecessor still tearing its quarantine tree down; it finishes on its own.
			await fs.mkdir(transition, { mode: 0o700 });
			await fs.writeFile(path.join(transition, "payload"), "scrubbing");
			setTimeout(() => {
				void fs.rm(transition, { recursive: true, force: true }).then(() => {
					cleared = true;
				});
			}, 120);
		});
		expect(cleared).toBe(true);
		expect(await fs.readdir(root)).toEqual([]);
		let reacquired = false;
		await withFileLock(target, async () => {
			reacquired = true;
		});
		expect(reacquired).toBe(true);
	});

	it("finishes a provably dead predecessor's abandoned transition and keeps the lock usable", async () => {
		const { root, target, transition } = await fixture("vib-lock-transition-dead-");
		await writeForeignTransition(transition, { pid: await deadPid() });
		const inspected = await inspectFileLockRemovalTransition(target + ".lock");
		expect(inspected.status).toBe("dead");
		expect(inspected.removed).toBe(false);

		let ranBody = false;
		await withFileLock(target, async () => {
			ranBody = true;
		});
		expect(ranBody).toBe(true);
		expect(await fs.readdir(root)).toEqual([]);

		for (let attempt = 0; attempt < 3; attempt++) {
			let reacquired = false;
			await withFileLock(target, async () => {
				reacquired = true;
			});
			expect(reacquired).toBe(true);
		}
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("never displaces a transition whose owner is alive", async () => {
		const { target, transition } = await fixture("vib-lock-transition-live-");
		await writeForeignTransition(transition, { pid: livePid() });
		const result = await inspectFileLockRemovalTransition(`${target}.lock`, undefined, true);
		expect(result.status).toBe("alive");
		expect(result.removed).toBe(false);
		expect(await fs.readFile(path.join(transition, "info"), "utf8")).toContain('"pid"');
	});

	it("leaves an unverifiable transition (no owner record) to the exact-removal replay", async () => {
		const { target, transition } = await fixture("vib-lock-transition-unverified-");
		await fs.mkdir(transition, { mode: 0o700 });
		await fs.writeFile(path.join(transition, "payload"), "no info");
		const result = await inspectFileLockRemovalTransition(`${target}.lock`, undefined, true);
		expect(result.status).toBe("unknown");
		expect(result.removed).toBe(false);
		expect(await fs.readFile(path.join(transition, "payload"), "utf8")).toBe("no info");
	});
});
