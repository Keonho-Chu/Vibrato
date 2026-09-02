---
name: plan
description: Delegate consensus planning to Vibrato (runs /skill:ralplan to a pending-approval plan).
---

Call the `vib_delegate_plan` coordinator MCP tool to delegate this work to vib-rato.

- Pass the current project directory as `cwd`.
- Pass the user's request as `task`.
- Only set `allow_mutation: true` after the user explicitly approves changes AND
  the coordinator server was started with the `sessions` mutation class enabled.
  Delegation is read-only until both conditions hold.

Vibrato starts a session and runs `/skill:ralplan` to completion, returning a
durable `turn_id`, status, and artifact references. Poll with
`vib_coordinator_await_turn` or `vib_coordinator_watch_events`.
Codex resume bridge correlation: after registering an app-server handoff with
`vib_coordinator_register_codex_handoff`, pass the same `session_id` as
`codex_host_session_id` on delegate calls so the new Vibrato session auto-binds to
the Codex thread for wake-on-completion and questions. Acknowledge durable wakes
by `wake_key` with `vib_coordinator_ack_codex_handoff`; heartbeats are unsupported
(`automation_update_unavailable`), so delivery is event-driven with startup drain.
