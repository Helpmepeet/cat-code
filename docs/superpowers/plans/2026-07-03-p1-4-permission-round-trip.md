# P1-4 Permission Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a real engine permission request in the desktop renderer and synchronously send a secure allow or deny response that resumes the engine.

**Architecture:** Keep permissions separate from transcript projection. A pure renderer reducer tracks pending requests from ready/requested/resolved frames, a focused component displays the first non-dismissed request, and App owns the bridge call plus global keyboard routing. Allow responses echo the request's gated input exactly; the sidecar remains the trust boundary for T6/T6b.

**Tech Stack:** React 19, TypeScript, Bun test, Electron preload IPC, existing CatCode app-session protocol.

---

### Task 1: Permission state and response construction

**Files:**
- Create: `app/renderer/src/permissionState.ts`
- Test: `app/renderer/src/permissionState.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Cover hydration from `ready.pendingPermissionRequests`, upsert on
`permission.requested`, removal on `permission.resolved`, local removal after a
decision, and local dismissal without sending a response.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test app/renderer/src/permissionState.test.ts`

Expected: FAIL because `permissionState.ts` does not exist.

- [ ] **Step 3: Implement the minimal reducer and response helpers**

Expose a reducer for server frames plus local `decided` and `dismissed` actions.
Build allow as `{ behavior: "allow", updatedInput: request.request.input }` and
deny as `{ behavior: "deny", message: "Denied by user" }`. Do not expose any
input-editing or `updatedPermissions` API.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun test app/renderer/src/permissionState.test.ts`

Expected: all focused tests pass.

### Task 2: Permission prompt and keyboard mapping

**Files:**
- Create: `app/renderer/src/PermissionPrompt.tsx`
- Test: `app/renderer/src/PermissionPrompt.test.tsx`

- [ ] **Step 1: Write failing rendering and key-mapping tests**

Assert the prompt renders the tool name, exact structured input, and inline key
hints. Assert Enter maps to allow, `n`/`N`/Backspace map to deny, Escape maps to
dismiss, and unrelated or modified keys do nothing.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test app/renderer/src/PermissionPrompt.test.tsx`

Expected: FAIL because `PermissionPrompt.tsx` does not exist.

- [ ] **Step 3: Implement the minimal prompt**

Render a compact dialog with Allow and Deny buttons and export a pure key
classifier. Keep the prompt outside transcript rendering.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun test app/renderer/src/PermissionPrompt.test.tsx`

Expected: all focused tests pass.

### Task 3: Wire the renderer to the real bridge

**Files:**
- Modify: `app/renderer/src/App.tsx`
- Modify: `app/renderer/src/App.test.tsx`

- [ ] **Step 1: Add a failing App rendering assertion**

Assert the App shell includes the permission surface without routing it through
`TranscriptView`.

- [ ] **Step 2: Run the App test and verify RED**

Run: `bun test app/renderer/src/App.test.tsx`

Expected: FAIL because the permission surface is absent.

- [ ] **Step 3: Wire frame reduction and decisions**

Feed every server frame to the permission reducer. On allow/deny, remove the
prompt locally in the same key/click handler and call
`bridge.respondPermission(sessionId, requestId, response)`. Register and clean
up a global keydown listener while a prompt is visible. Escape only dismisses
locally.

- [ ] **Step 4: Run renderer tests and verify GREEN**

Run: `bun test app/renderer/src`

Expected: all renderer tests pass.

### Task 4: Headless verification and operator handoff

**Files:**
- No production files beyond Tasks 1–3.

- [ ] **Step 1: Run desktop tests**

Run: `bun test app/`

Expected: zero failures, including existing T6/T6b boundary tests.

- [ ] **Step 2: Run typecheck, renderer build, hardening smoke, and repo build**

Run:

```bash
cd app && bun run typecheck
cd app && bun run renderer:build
cd app && bun run test:hardening
bun run build:dev:full
```

Expected: all commands exit zero. Record any already-documented sidecar
typecheck limitation separately; do not weaken checks.

- [ ] **Step 3: Stop for operator verification**

Give the operator the exact launch command, harmless Bash prompt, keypress, and
expected pause/resume evidence. Do not drive the GUI.

### Task 5: Record the verified phase gate and commit

**Files:**
- Modify: `docs/migration/STATUS.md`

- [ ] **Step 1: Wait for the operator's live result**

Require confirmation that the real Bash tool paused, the permission prompt
appeared, the chosen key removed it immediately, and the real turn continued.

- [ ] **Step 2: Update migration status**

Mark P1-4 complete with the date and observed result. Mark the Phase-1 gate
cleared and Phase 2 open without generating the Phase-2 backlog.

- [ ] **Step 3: Re-run relevant verification**

Run `bun test app/`, `git diff --check`, and inspect the scoped diff.

- [ ] **Step 4: Commit only P1-4 files**

Commit the implementation, tests, plan, and status update on `migration`,
excluding unrelated pre-existing worktree changes.
