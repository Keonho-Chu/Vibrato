# Vibrato dogfood local skill template

Issue #93 requested a gaebal-vibrato/operator dogfood skill. The live issue has no comment approving a fifth bundled default workflow skill, so this stays a local template instead of changing the default workflow surface. Operators can copy it into a user or project override when they want Vibrato-first session guidance.

The installable skill body is everything from the first frontmatter marker down; the frontmatter must be the **first line** of the installed file or the skill scan skips it with a diagnostic (the scan requires a parsed `description`). Install into the user-level scan location (`~/.vib/agent/skills/`, not `~/.vib/skills/`):

```sh
mkdir -p ~/.vib/agent/skills/vib-dogfood
sed -n '/^---$/,$p' docs/vib-dogfood-skill-template.md > ~/.vib/agent/skills/vib-dogfood/SKILL.md
```

For a single project, install to `<project>/.vib/skills/vib-dogfood/SKILL.md` with the same extraction. Do not commit that project `.vib` copy unless the project explicitly wants a local override.

Filesystem skill discovery is **on by default**: no configuration is needed. Start a new session and `/skill:vib-dogfood` should autocomplete. To disable a scope later, use the user-facing trust settings — `skills.trustUserSkills` for the user install above, `skills.trustProjectSkills` for a project install (see [docs/skills.md](./skills.md)):

---
name: vib-dogfood
description: Use when running or reviewing work through Vibrato sessions, dogfooding Vibrato, or migrating an operator workflow from OMX to Vibrato.
---

# Vibrato Dogfood Operator Workflow

Use Vibrato first for coding, review, planning, and follow-up sessions. Treat OMX as a fallback only when Vibrato is unavailable, broken, or missing a required capability.

## Locate and launch Vibrato

- Installed CLI: run `command -v vib` and then launch with `vib --tmux`.
- Repository checkout: from the vib-rato repo, prefer `bun packages/coding-agent/src/cli.ts --tmux` when testing source changes before install.
- Worktree isolation: for branch-specific work, either let Vibrato create a managed sibling worktree with `vib --tmux --worktree <branch-like-name>` or `cd <existing-worktree-path>` and run `vib --tmux` there. Do not pass filesystem paths to `--worktree`.
- Name sessions explicitly with the project and issue, for example `vib-rato-93-dogfood-skill`, so tmux panes, logs, and exports remain traceable.

## Start the session

- Put git operations inside the Vibrato session: fetch, branch/worktree setup, focused commits, pushes, and PR creation should be visible in-session.
- Submit the initial prompt with the issue URL, target branch, acceptance criteria, verification limits, and any existing plan/spec link.
- Verify the prompt was accepted: the TUI should show the user prompt, an active assistant turn, or a tool/action request. If the session silently idles, resend once with a shorter prompt and capture the failure.
- Verify working state before leaving the session unattended: confirm the target cwd/worktree, branch, and issue scope are visible in the transcript or command output.

## During work

- Keep session names and branch names issue-scoped.
- Prefer Vibrato workflow skills only when they fit: `deep-interview` for unclear requirements, `ralplan` for planning, `ultragoal` for durable ledgers, and `autoresearch` for goal-directed research missions.
- Keep evidence in the session: issue reads, focused tests/checks, screenshots only when visual behavior matters, and PR URLs.
- When Vibrato is weaker than OMX, finish the urgent work with the smallest safe fallback and file a vib-rato follow-up issue with the missing capability, exact command/session context, expected behavior, and evidence.

## Fallback policy

Use OMX or another operator path only when:

- `vib` cannot be located or launched after checking installed and repo-local commands;
- authentication, model routing, tmux, or prompt submission is broken;
- Vibrato lacks a required capability that OMX already has;
- an urgent production/review deadline would be missed by debugging Vibrato first.

Record the fallback reason and create or link the vib-rato issue that would make Vibrato sufficient next time.

## Evidence checklist

Report:

- project, issue, branch/worktree, and session name;
- whether Vibrato was installed or repo-local;
- prompt acceptance and working-state evidence;
- git operations performed in-session;
- focused verification commands and results;
- PR/issue URLs;
- follow-up vib-rato issues for any Vibrato gap or fallback.
