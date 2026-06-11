# Dedicated App Handoff Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Claude Design handoff migration baseline accurate, reviewed, and reproducible before any dedicated app runtime or UI work begins.

**Architecture:** This is a docs-only normalization slice. The canonical outputs live under `docs/design/dedicated-app/`; this plan verifies and refreshes those documents from the handoff ZIP and current Cat Code source facts without changing production runtime or UI code.

**Tech Stack:** Markdown, `unzip`, `rg`, current Cat Code docs maps, current `web/`, current `src/web/`, and current `src/app-runtime/`.

---

## File Structure

Canonical docs:

- `docs/design/dedicated-app/2026-06-06-claude-design-migration-roadmap.md`: migration strategy, research summary, phased roadmap, and first-plan non-goals.
- `docs/design/dedicated-app/handoff-index.md`: source inventory, primary prototype entry, imported files, uploaded requirement docs, audit file, and final-vs-historical classification.
- `docs/design/dedicated-app/runtime-contract-map.md`: mapping from prototype UI surfaces to app-runtime events, current web events, terminal-owned behavior, and missing app-facing contracts.
- `docs/design/dedicated-app/component-inventory.md`: production component candidates, visual tokens, state requirements, and prototype-only code that must not become production behavior.
- `docs/design/dedicated-app/migration-scope.md`: MVP/parity/future classification, phase gates, and explicit non-goals.

Do not modify `web/src/*`, `src/web/*`, `src/app-runtime/*`, `DONE.md`, or build configuration in this plan. If source inspection reveals a runtime fact that contradicts the docs, update only the relevant Markdown file and cite the owner path.

## Task 1: Rebuild The Handoff Evidence Locally

**Files:**
- Read: `/Users/pt/Downloads/catcode-handoff.zip`
- Validate: `docs/design/dedicated-app/handoff-index.md`

- [ ] **Step 1: Extract the handoff to a temporary directory**

Run:

```bash
tmpdir=$(mktemp -d /tmp/catcode-handoff.XXXXXX)
unzip -q /Users/pt/Downloads/catcode-handoff.zip -d "$tmpdir"
printf '%s\n' "$tmpdir"
```

Expected: prints a path like `/tmp/catcode-handoff.ABC123`.

- [ ] **Step 2: Confirm the primary entry and import order**

Run:

```bash
sed -n '1,120p' "$tmpdir/catcode/README.md"
sed -n '1,120p' "$tmpdir/catcode/project/CatCode Web App v3.html"
```

Expected findings:

- `catcode/README.md` says `catcode/project/CatCode Web App v3.html` was open when the user triggered handoff.
- `CatCode Web App v3.html` imports these files in this order:
  1. `cat-app/data.js`
  2. `cat-app/Sidebar.jsx`
  3. `cat-app/Surfaces.jsx`
  4. `cat-app/Startup.jsx`
  5. `cat-app/Messages.jsx`
  6. `cat-app/Welcome.jsx`
  7. `cat-app/Chat.jsx`
  8. `cat-app/Pages.jsx`
  9. `cat-app/TabBar.jsx`
  10. `cat-app/WorkspaceLayout.jsx`
  11. `cat-app/AppV2.jsx`

- [ ] **Step 3: Verify `handoff-index.md` covers the evidence**

Run:

```bash
rg -n "Primary Prototype|Import order|Historical And Exploratory Files|Uploaded Requirement Documents|Audit Document|Current Interpretation" docs/design/dedicated-app/handoff-index.md
```

Expected: one match for each section title.

- [ ] **Step 4: Patch missing handoff-index facts if needed**

If Step 3 misses a section or Step 2 contradicts the file, edit only `docs/design/dedicated-app/handoff-index.md`.

Required facts to preserve:

- `CatCode Web App v3.html` is primary.
- The archive SHA-256 is
  `9bea5221d2c1c36124e99011908cf1fa70408031d89f4ae0c4e9793207b8480a`.
- The archive manifest summary is 127 files and 13,152,945 bytes uncompressed.
- `cat-app/` is current prototype reference.
- `cat-app-v2-snapshot/`, option boards, and `launcher-explore/` are non-primary.
- Uploaded canonical requirement docs live under `catcode/project/uploads/`.
- `catcode/project/audit/2026-05-17-feature-coverage-audit.md` exists.
- Prototype code is design evidence and must not be copied as production behavior.

## Task 2: Re-Verify Runtime Contract Facts

**Files:**
- Read: `src/app-runtime/sessionEvents.ts`
- Read: `src/app-runtime/AppSessionController.ts`
- Read: `src/web/WebUIBus.ts`
- Read: `src/web/WebSocketServer.ts`
- Read: `src/main.tsx`
- Validate: `docs/design/dedicated-app/runtime-contract-map.md`

- [ ] **Step 1: Inspect current app-runtime and web relay owners**

Run:

```bash
sed -n '1,260p' src/app-runtime/sessionEvents.ts
sed -n '1,260p' src/app-runtime/AppSessionController.ts
sed -n '1,140p' src/web/WebUIBus.ts
sed -n '1,120p' src/web/WebSocketServer.ts
rg -n "--web|Web mode is browser-first|inputEnabled|startWebUIServer" src/main.tsx src/web/WebSocketServer.ts
```

Expected findings:

- `sessionEvents.ts` exposes `message`, `goal.snapshot`, `permission.requested`, `permission.resolved`, and `abort.status`.
- `AppSessionController.ts` owns app turn lifecycle, pending permissions, goal snapshots, and abort state.
- `WebUIBus.ts` exposes the current smaller browser relay contract:
  `message`, `delta`, `stream_mode`, `tool_use`, `status`, and `user_input`.
- `WebSocketServer.ts` sends initial status with `inputEnabled: false`.
- `main.tsx` starts web mode but does not wire `AppSessionController` into `src/web`.

- [ ] **Step 2: Verify runtime map section coverage**

Run:

```bash
rg -n "Current Runtime Owners|App Runtime Events|Current Web Events|Prototype Surface To Runtime Mapping|Runtime Preservation Requirements|Known Readiness Findings|First Runtime Gap" docs/design/dedicated-app/runtime-contract-map.md
```

Expected: one match for each section title.

- [ ] **Step 3: Patch runtime-map facts if needed**

If Step 1 contradicts the map, edit only `docs/design/dedicated-app/runtime-contract-map.md`.

Required facts to preserve unless source has changed:

- `AppSessionController` is real and tested.
- `AppSessionController` is not currently connected to `src/web` or `src/main.tsx`.
- Current web protocol is smaller than app-runtime events.
- Current browser code handles only `message`, `delta`, and `status`; backend
  relay types also include `stream_mode` and `tool_use`.
- Browser permission response, abort, and app-runtime event handling are not currently implemented.
- Phase 1 must decide between a new app transport adapter and adapting
  `src/web/WebSocketServer.ts`.
- Phase 1 must explicitly cover backend bootstrap/session assembly,
  SDK-message mapping, permission response flow and schemas, abort lifecycle,
  QueryEngine assembly, transport security, and web verification tooling.

## Task 3: Re-Verify Component And Prototype Boundaries

**Files:**
- Read: handoff files under `$tmpdir/catcode/project/cat-app/`
- Validate: `docs/design/dedicated-app/component-inventory.md`

- [ ] **Step 1: Inspect primary prototype component names**

Run:

```bash
wc -l "$tmpdir"/catcode/project/cat-app/*.jsx "$tmpdir"/catcode/project/cat-app/data.js
rg -n "function (AccountChip|ChipStrip|BannerStack|ToastHost|GoalDetail|PermissionQueue|MentionPicker|ChatView|Sidebar|TabBar|WorkspaceLayout|WelcomeScreen|StartupFlow)" "$tmpdir"/catcode/project/cat-app/*.jsx
rg -n "MOCK_|localStorage|setTimeout|window\\.toast|window\\." "$tmpdir"/catcode/project/cat-app/*.jsx "$tmpdir"/catcode/project/cat-app/data.js
```

Expected findings:

- Primary prototype is browser-global React/Babel code.
- `data.js` defines `window.MOCK_*` fixtures.
- Startup, chat, permission, account, connection, and goal actions include local state, timers, or toast-only stubs.

- [ ] **Step 2: Verify component inventory section coverage**

Run:

```bash
rg -n "Prototype Files To Preserve As References|Visual Tokens|Production Component Candidates|Prototype-Only Behaviors Not To Copy|Required States|First Component Slice" docs/design/dedicated-app/component-inventory.md
```

Expected: one match for each section title.

- [ ] **Step 3: Patch component-inventory facts if needed**

If Step 1 finds a missing prototype-only behavior or token, edit only `docs/design/dedicated-app/component-inventory.md`.

Required facts to preserve:

- Do not use `window.MOCK_*` as production data.
- Do not use `localStorage` prototype trust/auth as production trust/auth.
- Do not use browser-global `window.*` component registration.
- Do not use toast-only stubs as production behavior.
- Preserve dark Cat Code tokens, compact density, mono treatment, permission queue, goal drawer, tool cards, chip strip, and composer direction as references.
- First production component slice is limited to `DedicatedAppShell`, `MessageList`, `Composer`, `StatusChip`, `PermissionDialog`, and `GoalStatus`.

## Task 4: Re-Verify Scope Gates

**Files:**
- Validate: `docs/design/dedicated-app/migration-scope.md`
- Validate: `docs/design/dedicated-app/2026-06-06-claude-design-migration-roadmap.md`

- [ ] **Step 1: Verify roadmap and scope agreement**

Run:

```bash
rg -n "Phase 0|Phase 1|Phase 2|Phase 3|Phase 4|Phase 5|Non-Goals|Definition Of Ready|Definition Of Done" docs/design/dedicated-app/2026-06-06-claude-design-migration-roadmap.md docs/design/dedicated-app/migration-scope.md
```

Expected findings:

- Roadmap lists Phase 0 through Phase 5.
- Scope doc lists readiness and done gates for Phase 1.
- First plan non-goals exclude runtime, UI, split panels, settings redesign, and mock production wiring.

- [ ] **Step 2: Verify Phase 1 does not overreach**

Run:

```bash
rg -n "Excluded from Phase 1|Multi-tab|Split panels|Accounts charts|Agents and tasks pages|Settings redesign|Command palette|Launcher variants" docs/design/dedicated-app/migration-scope.md
```

Expected: matches under `Excluded from Phase 1`.

- [ ] **Step 3: Patch scope docs if needed**

If the scope doc and roadmap disagree, update the narrower `migration-scope.md` first, then update the roadmap summary to match.

Required Phase 1 gates:

- Decide app transport boundary.
- Decide whether `web/` remains the target or a new app directory is needed.
- Define browser transport security for prompts and permission decisions.
- Define backend bootstrap/session assembly for setup, commands, agents, MCP,
  permission mode, app state, and QueryEngine config outside the Ink REPL.
- Define first session lifecycle.
- Define permission request and response flow.
- Define permission wire schemas for allow, deny, cancel, updated input,
  persistent permission updates, recheck, sandbox/network distinction, worker
  identity, and reconnect replay of pending requests.
- Define SDK-message mapper scope.
- Define QueryEngine assembly strategy.
- Define abort lifecycle behavior.
- Define whether existing `stream_mode` and `tool_use` events are reused,
  replaced, or intentionally ignored.
- Define web verification tooling because `web/package.json` currently has no
  test script and root lint excludes `web/`.
- Decide whether existing web TypeScript failures are fixed inside Phase 1 or as a separate prep patch.

## Task 5: Validate The Documentation Set

**Files:**
- Validate: `docs/design/dedicated-app/*.md`
- Validate: `docs/superpowers/plans/2026-06-06-dedicated-app-handoff-normalization.md`

- [ ] **Step 1: Check changed files**

Run:

```bash
git status --short
```

Expected: only docs under `docs/design/dedicated-app/` and this plan file are modified or untracked.

- [ ] **Step 2: Check whitespace**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 3: Check generated design docs for forbidden placeholder language**

Run:

```bash
rg -n "T[B]D|T[O]DO|implement[[:space:]]later|fill[[:space:]]in[[:space:]]details|add[[:space:]]appropriate|handle[[:space:]]edge[[:space:]]cases|write[[:space:]]tests[[:space:]]for[[:space:]]the[[:space:]]above|similar[[:space:]]to[[:space:]]Task" docs/design/dedicated-app
```

Expected: no output.

- [ ] **Step 4: Check path and source references**

Run:

```bash
rg -n "https://|/Users/pt/Downloads/catcode-handoff.zip|src/app-runtime|src/web|web/src|catcode/project|AppSessionController|WebSocketServer" docs/design/dedicated-app docs/superpowers/plans/2026-06-06-dedicated-app-handoff-normalization.md
```

Expected: output lists the external research links, archive path, repo owner paths, and handoff-internal paths used by the docs.

## Self-Review

- Coverage: this plan covers Phase 0 normalization only.
- Scope: Phase 1 runtime work is intentionally excluded and needs its own plan after these docs are reviewed.
- Reproducibility: the checked-in docs are canonical; this plan describes how to refresh and validate them from the ZIP and current source.
- Type consistency: event names match `src/app-runtime/sessionEvents.ts` as of the planning review.
