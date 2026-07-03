> ⚠️ **SUPERSEDED 2026-06-26 by `PROGRAM-PLAN.md`.** Kept for reference — the
> per-domain territory detail (files, data, source anchors) is still useful raw material
> for the W4 backlog. Where this disagrees with PROGRAM-PLAN.md, the latter wins.

# CatCode migration — domain map

The unit of work is a **domain**, not a feature. We work **session by session**;
fine-graining a domain into its individual features happens *when we start that
domain*, not now. This file is the spine: the territories the prototype covers,
each to be traced into `~/cat-code/src` later (find real home / confirm none /
note divergence).

Derived from the actual prototype code (`cat-app/*.jsx` exports + `data.js`
structures + AppV2 routes + Settings categories) on 2026-06-19 — not from the
backlog. Goal restated: migrate cat-code from **TUI → dedicated app** (not a
browser tab); prototype visuals are ~production-ready; the hard part is features
whose real-cat-code home is unknown or that fight its architecture.

---

## A. Shell & navigation
The frame everything lives in.
- **Files:** `AppV2.jsx` (root state), `Sidebar.jsx`, `TabBar.jsx`, `WorkspaceLayout.jsx` (1-3 split panels + resize + drag), `CommandPalette.jsx`, `SlashCommandPicker.jsx`, `Surfaces.jsx` (Chip/Banner/Toast primitives), `Welcome.jsx`.
- **Data:** `MOCK_BANNERS`, `SLASH_COMMANDS`, `SLASH_COMMANDS_FULL`, `RECENT_COMMANDS`.
- **Routes:** `chat | sessions | accounts | settings`.
- **⚠ Deepest architectural item:** multi-session tabs/panels vs cat-code's one-process-per-session. User wants multi-session. It's *foundational* (the shell hosts everything) but *sequenced late* (STRATEGY Phase 5) — deferred until the seam + adapter + process model are proven, NOT because it's optional. Full analysis at the bottom of this file.

## B. Transcript & message rendering
The chat stream itself.
- **Files:** `Messages.jsx`, `DiffView`, the `Prose` markdown renderer.
- **27 distinct transcript row types** (verified): user, assistant, thinking, redacted-thinking, tool, tool-result, grouped, multidiff, compact, microcompact, snip, tombstone, hook-progress, task-assign, rate-limit, error, interrupted, image, command, local-cmd, sys-notice, agent-event, delegate, dream, attachment, **session-init**, **result**. (Messages.jsx exports a `*Row`/`*Block`/`*Card` for each, incl. `SessionInitRow` + `ResultRow`.)
- **Data:** `MOCK_MESSAGES`, `MOCK_MESSAGES_GALLERY`, `output-demo.js` (long Bash-output fixtures), `MOCK_SESSIONS` taxonomy.
- **Heavily `// SOURCE:`-anchored** to `message.ts` / `messages.ts`. The real stream shape is the contract. NOTE: several types are PROTOTYPE-ONLY (`tool`, `delegate`, `multidiff`, `grouped`, `agent-event`) — upstream tool calls are content blocks inside assistant messages, not their own type. Tracing this domain must separate real stream types from prototype display types.

## C. Tool-call rendering
The 11 tool-card families (a sub-territory of B, big enough to stand alone).
- **Files:** `Messages.jsx` (FrameE shell, Bash+8 states, Read/Write/Edit, Grep/Glob, Web, MCP, Notebook, LSP, Skill, Agent, `OutputInspector`, word-level diff).
- **Key fact:** tool status is *derived* upstream (resolved/errored sets), not a stored field — the migration must compute it, not read a mock.

## D. Composer & input
Everything below the transcript.
- **Files:** `Chat.jsx` (input, slash picker, @-mention, paste-collapse, prompt history, the scripted activity/Spinner engine), context donut, run/model/effort/fast/thinking chips (in `Surfaces.jsx`).
- **Note:** the scripted `setInterval` turn engine is pure demo — real version drives off the live stream.

## E. Permissions
- **Files:** `Permissions.jsx` (`PermissionQueue` — 14 variants, 5 lanes, keyboard-first, stale/abort/bypass-immune), `PermissionRules.jsx` (Settings → rules editor).
- **Data:** `MOCK_PERM_QUEUE`, `MOCK_PERM_STATE`, `PERMISSION_RULES`, `PERMISSION_MODES`, `PERMISSION_RULE_SOURCES`, `PERMISSION_TOOL_NAMES`, `PERMISSION_ADDITIONAL_DIRS`, `PERMISSION_DENIAL_TRACKING`.
- **Strongly source-anchored** (`permissions.ts`). The interaction model is already cat-code-accurate.

## F. Orchestrator Mode & workers
- **Files:** `OrchestratorMode.jsx` (worker roster, two-axis lifecycle/owner model, AgentToolCard, WorkerFocusView, TasksPanel, BackgroundTaskStatus), `AgentIdentity.jsx` (shared agent vocabulary).
- **Data:** `MOCK_WORKERS`, `ORCHESTRATOR_A_MESSAGES`.
- **Gated upstream** (`COORDINATOR_MODE` feature). Deep behavioral anchors (AskOrchestratorTool, enqueueAgentNotification).

## G. Tasks (background)
- **Files:** `TasksPage.jsx` (`BgTasksDialog` — in-session task list).
- **Data:** `MOCK_TASKS`, `MOCK_TASKS_NOW`.
- **⚠ Architecture divergence:** prototype aggregates tasks across sessions (a `sessionId` bridge field); upstream tasks are per-process (`AppState.tasks`). Tied to the multi-session decision (Domain A).

## H. Sessions (the page)
- **Files:** `SessionsPage.jsx`, `SessionActions.jsx` (rename/tag/branch/rewind/export/copy), `MetadataInspector.jsx`.
- **Data:** `MOCK_SESSIONS_EXTENDED`, `MOCK_SESSION_META`, `MOCK_MSG_META`.
- **Anchored** to `logs.ts` (LogOption / JSONL entries). Resume/branch/rewind touch real session-on-disk machinery.

## I. Accounts, usage & diagnostics
- **Files:** `Pages.jsx` (`AccountsPage`, Codex pool, usage charts, `DiagnosticsSection`).
- **Data:** `MOCK_ACCOUNTS`, `MOCK_STATUS`, `MOCK_IDE`.
- **Anchored** to `codexAccountPool.ts`. Codex-only (no Claude accounts).

## J. Settings
- **Files:** `Settings.jsx` (two-pane shell + SourceBadge/ManagedBadge/Field primitives).
- **Sub-domains (15):** general, model, permissions(→E), workspace, privacy, keybindings, theme, agents(→K), mcp, plugins, skills, hooks, ide, diagnostics(→I), managed.
- Many sub-domains are honest stubs in the prototype — each needs its own source trace.

## K. Agents (config manager)
- **Files:** `AgentsPage.jsx` (`.cat-code/agents/*.md` definition registry, precedence/override model).
- **Data:** `MOCK_AGENT_DEFS`.
- **Anchored** to `loadAgentsDir.ts`. NOT a runtime roster (that's G/F).

## L. Startup, trust & connection
- **Files:** `Startup.jsx` (trust/auth gate, `WorkspaceSwitchPrompt`), `ResumeStates.jsx` (hydration overlay, cross-project resume), `Pages.jsx` (`WorkspaceTrustSection`), connection/reconnect banners (in `AppV2`/`Surfaces`).
- **Data:** `MOCK_STARTUP_HANDOFFS`, `MOCK_CONNECTION`.

## M. Goal
- **Files:** `GoalChip` / `GoalDetail` (in `Surfaces.jsx`).
- **Data:** `MOCK_GOAL`.
- **Anchored** to `threadGoal.ts` (ThreadGoal).

---

## Not part of the app (exclude)
Dead/variant/demo-only files, not loaded by `CatCode Web App.html`:
`Workspace.jsx`, `composer-variants.jsx`, `menu-variants.jsx`, `profile-variants.jsx`,
`design-canvas.jsx`, `ConnectionDemo.jsx` (lives inside Settings → Diagnostics).
Plus all `DEMO-ONLY` sessions (`s-perm`, `s-tool-gallery`, `s-taxonomy`) and the
Orchestrator A/B/C demo switch.

---

## How a domain gets worked (proposed, to confirm per domain)
When we open a domain: (1) enumerate its features fine-grained, (2) trace each into
`~/cat-code/src` — real home (file:line) / works-differently / no counterpart /
architectural collision, (3) decide what making it real takes. The per-domain
*deliverable format* is still TBD — we'll define it after doing one domain for real.

**Cross-cutting decision that gates several domains:** multi-session (A, G, and parts
of B/H) vs cat-code's process model. User wants multi-session.

VERIFIED against source (2026-06-19) — the divergence is real but more concrete than
"extend the protocol":
- cat-code is **one process per session** (one `AppState`/REPL per `claude` process).
  No single in-memory app hosts many sessions. (`src/state/AppStateStore.ts`, `screens/REPL.tsx`.)
- BUT a real **on-disk session registry already exists**: `src/utils/concurrentSessions.ts`
  writes a **PID file per session** (`~/.../sessions/`) carrying `SessionKind`
  (`interactive|bg|daemon|daemon-worker`), `SessionStatus` (`busy|idle|waiting`), name,
  bridgeId. Sessions discover each other by reading these files (`countConcurrentSessions`,
  `registerSession`). There's a `BG_SESSIONS` feature for background sessions.
- So the prototype's tabs/panels do NOT map to one process — they map to **N cat-code
  processes the app must spawn/attach/multiplex**, with the session registry as the
  coordination layer. This is the deepest architectural item; it gates Domain A and shapes G/H.
  Resolve the process/multiplex model before committing A.
