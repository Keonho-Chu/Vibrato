/**
 * Tombstone for the removed legacy `worktree` CLI command module.
 *
 * The `vib worktree`/`wt` command was unregistered during the
 * workflow-surface narrowing and its implementation was deliberately
 * removed. This module exists only to fail imports with actionable
 * migration guidance.
 */
export {};

throw new Error(
	"@vib-rato/coding-agent/commands/worktree was deliberately removed: the `vib worktree` command and its cleanup implementation are gone. Inspect leftover managed worktrees under ~/.vib/wt manually and use `git worktree remove` or `git worktree prune` instead.",
);
