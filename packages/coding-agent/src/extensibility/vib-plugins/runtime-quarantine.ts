import { identityEquals, identityKey } from "./lifecycle-reconciliation";
import type { VibBundleIdentity, VibRuntimeFinding, VibRuntimeSnapshot, VibRuntimeSnapshotState } from "./types";

/**
 * Deterministic numeric activation generation for an activation fingerprint.
 *
 * Equal activation inputs yield an equal generation, so a consumer holding a
 * snapshot can tell whether it still describes the state it is rendering.
 * Derived from the fingerprint's leading hex so it stays inside the safe
 * integer range.
 */
export function vibActivationGenerationFor(activationFingerprint: string): number {
	const parsed = Number.parseInt(activationFingerprint.slice(0, 13), 16);
	return Number.isSafeInteger(parsed) ? parsed : 0;
}

/**
 * Caller-owned accumulator for scope-qualified runtime evidence.
 *
 * Producers (loaders, adapters, validators) hand findings to an accumulator
 * they were given; they never publish. Exactly one coordinator publishes a
 * complete generation snapshot, and consumers merge it only when the identity
 * and generation match.
 */
export class VibRuntimeFindingAccumulator {
	private readonly findings: VibRuntimeFinding[] = [];

	constructor(readonly generation: number) {}

	add(finding: VibRuntimeFinding): void {
		this.findings.push(finding);
	}

	addAll(findings: readonly VibRuntimeFinding[]): void {
		for (const finding of findings) this.add(finding);
	}

	/** Sorted, de-duplicated snapshot for the generation this accumulator owns. */
	snapshot(): VibRuntimeSnapshot {
		const seen = new Set<string>();
		const unique: VibRuntimeFinding[] = [];
		for (const finding of this.findings) {
			const key = [identityKey(finding.identity), finding.surfaceId, finding.code, finding.message].join("\u0000");
			if (seen.has(key)) continue;
			seen.add(key);
			unique.push(finding);
		}
		unique.sort((a, b) => {
			const ka = `${identityKey(a.identity)}\u0000${a.surfaceId}\u0000${a.code}`;
			const kb = `${identityKey(b.identity)}\u0000${b.surfaceId}\u0000${b.code}`;
			return ka.localeCompare(kb);
		});
		return { generation: this.generation, findings: unique };
	}
}

/** Read-only view of the most recently published complete generation. */
export interface VibRuntimeSnapshotProvider {
	current(): VibRuntimeSnapshotState;
}

/**
 * Single-writer publisher for runtime evidence.
 *
 * Passes can overlap: the session's prompt rebuild is re-entrant, so a second
 * pass may start while a first is still awaiting its producers. Publication is
 * therefore fenced by a monotonic epoch. A pass reserves an epoch when it
 * begins, which immediately retires whatever was published before, and its
 * later publish is accepted only if no newer pass has reserved since. A slow or
 * failed older pass can never overwrite a newer one, and an incomplete pass
 * simply never publishes, leaving consumers at `unavailable`.
 */
export class VibRuntimeSnapshotStore implements VibRuntimeSnapshotProvider {
	private state: VibRuntimeSnapshotState = { status: "unavailable" };
	private epoch = 0;

	/**
	 * Begin a pass. Retires the current snapshot and returns the epoch token the
	 * caller must present to publish.
	 */
	beginPass(): number {
		this.epoch += 1;
		this.state = { status: "unavailable" };
		return this.epoch;
	}

	/** Publish only if `epoch` is still the newest reserved pass. */
	publish(snapshot: VibRuntimeSnapshot, epoch?: number): void {
		if (epoch !== undefined && epoch !== this.epoch) return;
		this.state = { status: "current", snapshot };
	}

	invalidate(): void {
		this.state = { status: "unavailable" };
	}

	current(): VibRuntimeSnapshotState {
		return this.state;
	}
}

/**
 * Findings for one bundle, but only when the snapshot is current AND describes
 * the exact generation the consumer is rendering. Missing provider, mismatched
 * generation, or unavailable state resolve to `unavailable` — never to a
 * silently empty "clear" result.
 */
export function findingsForBundle(
	provider: VibRuntimeSnapshotProvider | undefined,
	identity: VibBundleIdentity,
	expectedGeneration: number,
): { status: "unavailable" } | { status: "current"; findings: VibRuntimeFinding[] } {
	if (!provider) return { status: "unavailable" };
	const state = provider.current();
	if (state.status !== "current") return { status: "unavailable" };
	if (state.snapshot.generation !== expectedGeneration) return { status: "unavailable" };
	return {
		status: "current",
		findings: state.snapshot.findings.filter(f => identityEquals(f.identity, identity)),
	};
}
