# Developer-information gaps audit — what a developer wants to KNOW in the desktop app but can't

**Date:** 2026-09-01 · **Scope:** information/observability only (no feature or action requests) · **Question:** "When developing something, what does a developer want to know in our app that we're still missing?"

## Method

Three lanes, reconciled:

1. **Desktop inventory** — every information surface the app renders today, from `app/renderer/src/**`, `app/shared/protocol.ts`, `app/main/**`.
2. **Engine + program gaps** — what the terminal engine already surfaces (`src/commands/**`, REPL) that never reached the desktop, plus deferred/cut rows in `docs/migration/PARITY-LEDGER.md` and `docs/migration/STATUS.md`.
3. **External demand** — ChatGPT web research (2026-09-01) across 12 agentic coding tools (Claude Code CLI/desktop, Codex CLI/app, Cursor, Windsurf, Copilot coding agent, Zed, Amp, Devin, Gemini CLI, Cline) and public complaint threads, ranking the 10 most-demanded information items.

Load-bearing internal claims were spot-checked against source. Notably: the Codex **lease roster exists** in the app (`app/renderer/src/TasksDialog.tsx:307`, P4-32b) despite PARITY-LEDGER Part C still listing it as orphaned — the ledger's usage/lease clusters are partly stale, so ledger rows below were verified before inclusion. External lane is used only to rank demand, not as a spec (parity rule stands; its vendor-table links are unverified).

## Headline

**The engine already computes almost everything that's missing — the desktop app just never asks for it or renders it.** Most items are "surface a number that already exists," not "build new telemetry." The biggest cluster is after-the-fact observability: the app is informative while a turn runs, then forgets everything the moment it succeeds. The engine's status-line payload (`src/components/StatusLine.tsx:75-121` — cost, lines added/removed, `exceeds_200k_tokens`, rate limits, model, workspace in one JSON object) already aggregates much of Tier 1 with no desktop consumer; price one new protocol frame before pricing items individually.

External research corroborates the internal ranking almost one-to-one: quota+reset visibility, context health, cost with attribution, live execution state, and reliable diffs are the five strongest public demands. Its negative result also matches: checkpoint/rollback is widely built but weakly demanded — leaving Rewind honestly disabled (`app/renderer/src/sessionActions.ts:128`) is fine.

## Tier 1 — asked daily, unanswerable today

### 1. "What did this session change on my disk?"
Only per-tool-call diffs exist. No aggregated changed-files list, no session-scoped diff, nothing like the terminal `/diff` (`src/commands/diff/index.ts`). External lane ranks reliable diff + changed-file scope in its top 5 across every competitor.

- **Placement:** restore the prototype activity-byline chips `files · +N · −M` (`~/catcode_prototype/cat-app/Chat.jsx:117` — straight parity, the desktop byline dropped them). Click opens a new **Changes right-hand drawer** (ToolInspector/MetadataInspector pattern): changed-file list → per-file hunks reusing `DiffView`, with **attribution** (which turn / which subagent made each change). "View changes" entry in the session actions menu for after the turn ends.
- **Cost note:** a renderer-side aggregate folded from Edit/Write tool cards needs no protocol change but misses bash-made edits; a truthful working-tree view needs a new seam.
- ⚑ The drawer has no prototype anchor — operator sign-off required before build.

### 2. "What has this session cost me so far?"
No session total anywhere. Cost renders only on the error/interrupt seam (`app/renderer/src/TranscriptView.tsx:5312`; success footer deliberately removed, `:5281`) and per-message in the metadata inspector. Terminal `/cost` aggregates it all (`src/commands/cost/cost.ts`, `src/cost-tracker.ts:214-243`). Per-token dollars are rightly cut for Codex-billed sessions (PARITY-LEDGER:1089), so the desktop version is **token-denominated**, with dollars only for API-billed sessions. External evidence: totals without a **cached-vs-fresh split** don't answer the cost question.

- **Placement:** "This session" section in the context-donut popover (`ContextUsagePanel`) — cumulative tokens in/out, per-model, cache-read vs fresh split, `$` line only when API-billed. Clearly separate section: context-fill and cumulative spend are different questions. Depth: session aggregate atop the metadata inspector's "Usage & cost". No new rail chip — the rail is six chips deep already.

### 3. "Is it done / does it need me?" (window unfocused)
Does not exist — zero hits for `new Notification` / `setBadgeCount` / `flashFrame` in `app/main/` (verified); Settings admits it ("raises in-window toasts only", `app/renderer/src/SettingsShell.tsx:784-790`). Only cross-tab signal is the permission badge. External demand distinguishes **"finished"** from **"I need you now."**

- **Placement:** macOS notification for exactly four events, fired only when unfocused/backgrounded: approval needed, turn finished, turn failed, background task done. Dock badge count = pending approvals. In-window: extend the existing tab-bar attention badge vocabulary with a turn-finished dot. Control: replace the Settings placeholder with per-event toggles.
- ⚑ No prototype anchor (verified — prototype "notification" hits are unrelated concepts); OS-conventional but needs operator sign-off.

### 4. "Am I about to hit my limits?" — Anthropic quota + rate-limited signal
Codex accounts get 5h/weekly headroom bars; **Anthropic accounts have no quota fields in the protocol at all** (`app/shared/protocol.ts:2148-2156`) while the terminal `/usage` shows 5h/weekly/overage (`src/components/Settings/Usage.tsx:269-322`). `RateLimitRow` was cut (PARITY-LEDGER:439) — rate-limiting folds into generic API errors, so "you were rate-limited, switch accounts" never appears as an actionable fact. External lane ranks quota **with the exact reset time** as the single strongest demand.

- **Placement:** mirror the Codex 5h/weekly bars for Anthropic in the account-chip popover and Accounts page (needs a protocol seam; engine data exists). Show `↺ reset` **unconditionally** next to the bars, both providers — today it appears only on capped rows. Restore `RateLimitRow` in the transcript (prototype element) and flip the account-chip dot at the same moment. Wire the fully-capped banner for Anthropic too.
- Priority note: this box runs mostly on Codex models, so this sits last in Tier 1 — but it is a whole-category blind spot.

## Tier 2 — asked when something goes wrong, and the app goes silent exactly then

### 5. Live execution state: stall, wait-state, and the plan after approval
*(Elevated by external evidence — its #4, with plan-integrity/scope-creep complaints attached.)* The terminal spinner has a stalled-token detector (~3s without tokens, `src/components/Spinner.tsx:228`) and turn-budget readout + ETA (`:266-276`); the desktop byline has neither — a stalled turn and a thinking turn look identical. The approved plan vanishes: `PlanPanel` exists only while the `ExitPlanMode` approval is pending (`app/renderer/src/PlanPanel.tsx:19-24`); afterwards only the terse `3/7` todo readout remains.

- **Placement:** all on the activity byline (the live-facts anchor). Stalled tone shift after the no-token threshold; explicit wait-state wording (working / waiting on command / waiting on you / retrying); `used / budget (N%) · ETA` right-aligned when a budget is set. Promote the todo hover panel to carry the **approved plan with the current step highlighted**.

### 6. "How long did that take?"
Live clock vanishes on success; finished-turn duration survives only on error seams and in the inspector. Background tasks render **no elapsed at all** — `startTime`/`endTime`/`totalPausedMs` cross the wire, `startTime` used for sorting only (`app/renderer/src/tasksState.ts:150`).

- **Placement:** build `TurnDurationRow` ("◷ worked for 1m 48s") — prototype-anchored (`~/catcode_prototype/cat-app/Messages.jsx:1379`), ledgered blocked-on-seam (PARITY-LEDGER:419). Also fixes "successful turns end with zero trace." TasksDialog rows get elapsed/ended-ago from wire data (renderer-only).

### 7. "Why did it fail, exactly?" + validation evidence
Turn errors are a two-line card that punts to "Save diagnostics bundle"; the bundle computes rich facts (stuck sessions, delivery anomalies, coverage — `app/main/diagnosticsBundle.ts`) never rendered in-app; no log viewer, no request-id surface. Bash cards can't distinguish stderr from stdout (one merged projection per `tool_use_id`, PARITY-LEDGER:389). External lane adds the adjacent category neither internal lane flagged: **evidence that tests actually passed** (its #9). For a single expert operator the cheap version suffices: stderr split + visible exit code.

- **Placement:** expandable detail on the existing turn-error card (request id, raw error body). Diagnostics-bundle summary as a read-only pane in Settings next to the "Save diagnostics bundle" button. stderr/stdout tabs on `BashOutputCard` (prototype-anchored) + exit code visible on the collapsed card.

### 8. "Did my hook run? Is my MCP server connected?"
Deferrals named in-source (`app/renderer/src/SettingsExtensions.tsx:8-11`): no hook last-run outcomes, no MCP live connection status. A silently-failing hook has no surface.

- **Placement:** Settings → Extensions rows — per-hook last-run outcome (when, ok/failed, exit code), live connection pill on MCP rows. In-turn: `HookProgressRow` in the transcript (prototype-anchored, PARITY-LEDGER:435).

## Tier 3 — real but narrower (unranked)

- **Git state is spawn-frozen and thin.** Branch never re-read after a mid-session switch (`app/shared/protocol.ts:2739`); dirty/staged/ahead-behind not in the protocol at all.
- **Provider/endpoint identity.** Terminal `/status` block (API provider, base URLs, proxy, mTLS) has no desktop equivalent.
- **Per-turn cache diagnostics.** `/cache-stats` (per-request hit%, cache-key prefix — `src/commands/cache-stats/cache-stats.ts`) terminal-only; app has only an aggregate rate.
- **App's own version renders nowhere** — no About, no Settings footer. Engine version is three levels deep in the inspector.
- **Model route per turn** is inspector-deep; external demand (#8) wants actual model per turn/subagent surfaced when routing changes.
- **Cheap unrendered wire data:** `AccountStatus.planType`/`.statusReason`/`.lastRefreshIso`, `cacheCreationInputTokens`, task times (covered in Tier 2), session `messageCount` (loader populates 0, chip removed).

## Covered well today — don't spend here

Context-window fill (donut + engine category breakdown + compaction seam), permission/approval flow, background-task and worker/lease visibility (P4-32b), account identity + Codex headroom bars, queued messages, per-tool-call diffs, metadata-inspector depth, 7d/30d token analytics.

## Placement summary

| Surface | Gains |
|---|---|
| Activity byline | files/+/− chips (parity) · stall tone · wait-state wording · budget/ETA |
| Todo hover panel | approved plan with current step |
| Transcript | TurnDurationRow · RateLimitRow · HookProgressRow · stderr tabs + exit code · deeper error card |
| Context-donut popover | "This session" totals with cache split |
| Right drawer (new ⚑) | Changes/diff view with per-turn attribution |
| Account popover + Accounts page | Anthropic 5h/weekly bars · always-on reset time |
| TasksDialog | task elapsed times |
| Settings | notification toggles · diagnostics summary · hook/MCP health |
| OS (new ⚑) | notifications for 4 events · dock badge = pending approvals |

Placement rule applied: live facts → byline · per-turn history → transcript seams · persistent session numbers → rail popovers · deep dives → drawers · config health → Settings.

## Decisions needed before dispatch

The two ⚑ items — the **Changes drawer** and the **notification design** — have no prototype anchor and are the only invented UI here; everything else is parity restoration or extension of an existing surface. Both need operator sign-off per the no-unrequested-visuals rule.

## Uncertainties

- External lane's per-tool table is vendor-doc-sourced with unverified links; used for demand ranking only.
- The two-agent internal inventory inferred several "missing" verdicts from identifier absence in `app/renderer/src/`; the lease-roster case proved one such verdict stale. The Tier 1/2 items above were spot-checked; Tier 3 items were not individually re-verified.
- Whether the desktop context gauge applies `projectView`/microcompact before counting (terminal does, `src/commands/context/context.tsx:14-28`) was flagged but not verified — if it doesn't, the donut overcounts.
