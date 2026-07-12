# P4-8b — the in-session Orchestrator toggle is a live per-session env switch

**Status: RULED + BUILT 2026-07-13.** Makes the WelcomeScreen's Orchestrator control
(previously a read-only reflect of `AgentModeSnapshot.active`) actually switch agent mode
for the in-session (`variant:'session'`) empty state. All anchors verified against the
working tree; where this doc and source disagree, source wins.

## The decision

The Orchestrator toggle is wired to the engine's OWN runtime mode switch, **not** an
engine respawn and **not** a session-lifecycle change:

- Agent mode is a **live env-var read**: `isAgentMode()` returns
  `isEnvTruthy(process.env.CLAUDE_CODE_AGENT_MODE)`, read at call time
  (`src/agent-mode/agentMode.ts:37-38`).
- The switch is **`matchSessionMode('agent' | 'normal' | 'coordinator')`**
  (`src/agent-mode/agentMode.ts:102-124`) — the engine's own mode switch, the SAME one the
  `/agent` command uses. `'agent'` sets `CLAUDE_CODE_AGENT_MODE='1'`, `'normal'` deletes it
  (both clear the coordinator flag). It logs `tengu_agent_mode_switched` and is idempotent
  (returns `undefined` when already in the requested mode). The sidecar NEVER pokes
  `process.env` directly — it calls this function.
- Because the sidecar is **one process per session** (N-process, LOCKED — `TRANSPORT.md` /
  `SESSION-LIFETIME.md`), the env change is correctly scoped to that session alone.
- The system prompt reads `isAgentMode` when it builds each turn
  (`src/utils/queryContext.ts:66`), so the **next** turn runs in the new mode. Toggling on an
  empty session (the WelcomeScreen case) is the clean path — no in-flight turn to disturb.

No locked decision is touched: transport, N-process, raw-event fidelity, die-with-window, and
the two-id model are all unchanged. A live env switch needs none of them.

## The wire path (app-owned inbound verb — the P4-15 template)

Like the P4-5 account verbs, the P4-15 workspace-trust accept, and the P4-19 settings write,
this is **app-owned inbound vocabulary** the engine's shared `appClientMessageSchema` does NOT
carry. It rides the same recipe:

1. `WelcomeScreen` (session variant) `OrchestratorReflect` renders an interactive
   `<button role="switch">`; clicking calls `onToggleOrchestrator(!active)`.
2. App → `getBridge().setAgentMode(panelSessionId, next)` (HC3 fixed preload sender
   `catcode:agent-mode-set`).
3. Electron main light-coerces `active` to a boolean, mints the `requestId`, and forwards
   `{ type:'agent-mode.set', requestId, active }` (main is NOT the trust boundary).
4. **Sidecar (the trust boundary)** validates with a sidecar-LOCAL Zod strict schema +
   `checkStrictKeys` closed allowlist (`{type,requestId,active}` only), then calls
   `agentModeDomain.setActive(active)` → `matchSessionMode(...)`, and re-broadcasts
   `agent-mode.snapshot` (whose `active` = `isAgentMode()`) when the mode flipped. An
   `agent-mode.set.result` frame echoes the `requestId` (T5a-analog).

## Security posture (SECURITY-MINIMUM — hard gate, all preserved)

- Closed inbound allowlist validated **at the sidecar**, never only at the preload; a
  boundary test accepts a valid frame and rejects malformed ones (missing `requestId`,
  non-boolean `active`, extra key, unknown type).
- The renderer authors ONLY the boolean intent — no path (HC1), no engine object, no token.
  Secrets stay engine-side; directional frame limits (`MAX_FRAME_BYTES` in /
  `MAX_OUTBOUND_FRAME_BYTES` out) are unchanged.
- The launcher variant stays READ-ONLY (there is no session yet to toggle).

## Parity

Restores prototype parity: `Welcome.jsx`'s Orchestrator toggle is interactive. The prior
P4-17 read-only reflect was a deliberate deferral ("no agent-mode write verb — a live toggle
would be fake wiring"); P4-8b supplies the real verb, so the deferral is now closed for the
session variant.
