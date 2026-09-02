---
name: vib-delegation
description: Delegate planning and execution workflows to vib-rato via the coordinator MCP server.
---

# Vibrato delegation

This plugin exposes vib-rato's coordinator MCP server so a host agent can
delegate whole workflows to Vibrato and receive durable turn status plus artifacts.

## Tools

| Tool | Workflow | Vibrato skill | Purpose |
| --- | --- | --- | --- |
| `vib_delegate_plan` | plan | /skill:ralplan | Delegate consensus planning to Vibrato (runs /skill:ralplan to a pending-approval plan). |
| `vib_delegate_execute` | execute | /skill:ultragoal | Delegate execution to Vibrato (runs /skill:ultragoal to completion with verification). |

## Fail-closed safety

The bundled MCP config sets `VIB_COORDINATOR_MCP_WORKDIR_ROOTS` to the host
project directory and does **not** set `VIB_COORDINATOR_MCP_MUTATIONS`.
Delegation is read-only until the user explicitly enables a mutation class and
passes `allow_mutation: true` per call. `VIB_COORDINATOR_MCP_REPO` is a
namespace label only, never a filesystem path.
## Codex resume bridge correlation

After registering an app-server handoff with `vib_coordinator_register_codex_handoff`,
pass the same `session_id` as `codex_host_session_id` on delegate calls so new Vibrato
sessions auto-bind to the Codex thread for wake-on-completion and questions. Acknowledge
durable wakes by `wake_key` with `vib_coordinator_ack_codex_handoff`; heartbeats are
unsupported (`automation_update_unavailable`), so delivery is event-driven with startup drain.

## Polling

Each delegate returns a `turn_id`. Poll `vib_coordinator_await_turn` (bounded)
or `vib_coordinator_watch_events` for the `delegation.started` event and the
terminal turn state. Turn state is the source of truth, not terminal scrollback.
