# Agent Mode v2.4 Feedback Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the live Agent Mode v2.4 feedback items V24-001 through V24-004: duplicated status ownership, raw worker IDs, extra roster spacing, and stale worker terminal-state truth.

**Architecture:** Keep the fixes in the existing Agent Mode ownership surfaces. Worker identity stays in `src/agent-mode/workerNames.ts` and the `runAgent` spawn path. Worker roster presentation stays in `src/agent-mode/AgentModeWorkerRoster.tsx` with `REPL` deciding when the roster should be visually subordinate to the main spinner. Terminal-state truth stays in `src/agent-mode/sessionState.ts` and existing AgentTool terminal update paths, with focused regression tests to prevent stale active/running counts.

**Tech Stack:** TypeScript, React Ink components, Bun test runner, existing Agent Mode durable session state.

---

## File Structure

- Modify: `src/agent-mode/workerNames.ts`
  - Owns themed worker handle allocation.
  - Add a generic Agent Mode fallback name pool so Explore and `general-purpose` workers do not fall back to raw agent IDs.
- Modify: `src/agent-mode/workerNames.test.ts`
  - Covers fallback handle allocation for Explore and unknown worker roles.
- Modify: `src/tools/AgentTool/runAgent.ts`
  - Passes an explicit Agent Mode flag into handle allocation so generic fallback names are used only when durable Agent Mode worker tracking is active.
- Modify: `src/agent-mode/AgentModeWorkerRoster.tsx`
  - Adds compact rendering for the roster when the main spinner already owns top-level status.
  - Removes unexplained bottom spacing in compact mode.
- Modify: `src/agent-mode/AgentModeWorkerRoster.test.tsx`
  - Covers compact header wording and compact spacing.
- Modify: `src/screens/REPL.tsx`
  - Passes compact roster mode when Agent Mode and the main spinner are visible.
- Modify: `src/agent-mode/sessionState.test.ts`
  - Adds a regression test that a failed or killed worker is removed from active state and surfaces as attention, not running.
- Modify: `docs/agent/2026-05-02-agent-mode-v2.4-live-feedback.md`
  - Adds source-verified evidence under V24-001 through V24-004 after implementation.
  - Sets the closure decision once tests and smoke checks pass.

---

### Task 1: Give Explore And Generic Agent Mode Workers Friendly Handles

**Files:**
- Modify: `src/agent-mode/workerNames.ts`
- Modify: `src/agent-mode/workerNames.test.ts`
- Modify: `src/tools/AgentTool/runAgent.ts`

- [ ] **Step 1: Write the failing worker-name tests**

Append these tests inside the existing `describe('workerNames', () => { existing tests and new tests })` block in `src/agent-mode/workerNames.test.ts`:

```ts
  test('allocates themed handles for Explore workers when generic fallback is enabled', () => {
    Math.random = () => 0

    expect(
      allocateWorkerName('Explore', [], {
        allowGeneric: true,
      }),
    ).toBe('Ada')
  })

  test('does not allocate generic handles outside Agent Mode fallback', () => {
    Math.random = () => 0

    expect(allocateWorkerName('Explore')).toBeNull()
  })

  test('allocates generic handles for custom Agent Mode workers', () => {
    Math.random = () => 0
    reserveWorkerName('Ada')

    expect(
      allocateWorkerName('general-purpose', [], {
        allowGeneric: true,
      }),
    ).toBe('Katherine')
  })
```

Also add these names to `ALL_TEST_NAMES` near the top of `src/agent-mode/workerNames.test.ts` so `afterEach` releases them:

```ts
  'Ada',
  'Katherine',
  'Johnson',
  'Hamilton',
  'Ritchie',
  'Kay',
```

- [ ] **Step 2: Run the worker-name tests to verify RED**

Run:

```bash
bun test src/agent-mode/workerNames.test.ts
```

Expected:

```text
FAIL
Expected 2 arguments but got 3
```

or:

```text
FAIL
Expected: "Ada"
Received: null
```

- [ ] **Step 3: Implement generic Agent Mode fallback names**

Replace the top of `src/agent-mode/workerNames.ts` through `allocateWorkerName` with this implementation, preserving the existing exports `reserveWorkerName` and `releaseWorkerName` below it:

```ts
const CODING_WORKER_NAMES = [
  'Turing', 'Hopper', 'Curie', 'Galileo', 'Kepler', 'Lovelace', 'Ramanujan',
  'Darwin', 'Faraday', 'Pasteur', 'Tesla', 'Euclid', 'Archimedes', 'Euler',
  'Gauss', 'Feynman', 'Bohr', 'Sagan', 'Franklin', 'Bell',
]

const VERIFIER_NAMES = [
  'Noether', 'Heisenberg', 'Hypatia', 'Shannon', 'Hamming', 'Knuth',
  'Tarski', 'Godel', 'Liskov', 'Lamport', 'BernersLee', 'Dijkstra',
  'Torvalds', 'McCarthy', 'Babbage', 'Minsky', 'Khayyam', 'Poincare',
]

const GENERIC_WORKER_NAMES = [
  'Ada', 'Katherine', 'Johnson', 'Hamilton', 'Ritchie', 'Kay',
  'Wilkes', 'Goldstine', 'Backus', 'Engelbart', 'Cerf', 'Barton',
]

const NAME_POOLS: Record<string, string[]> = {
  'agent-mode-coding-worker': CODING_WORKER_NAMES,
  'agent-mode-verifier': VERIFIER_NAMES,
}

const activeNames = new Set<string>()

function getReservedNames(
  reservedNames: Iterable<string> = [],
): Set<string> {
  const reserved = new Set(activeNames)
  for (const name of reservedNames) {
    reserved.add(name)
  }
  return reserved
}

function pickRandom(pool: string[], reservedNames: Iterable<string>): string {
  const reserved = getReservedNames(reservedNames)
  const available = pool.filter(n => !reserved.has(n))
  if (available.length === 0) {
    const baseName = pool[Math.floor(Math.random() * pool.length)]!
    let suffix = 2
    let candidate = `${baseName}-${suffix}`

    while (reserved.has(candidate)) {
      suffix += 1
      candidate = `${baseName}-${suffix}`
    }

    return candidate
  }
  return available[Math.floor(Math.random() * available.length)]!
}

export function allocateWorkerName(
  agentType: string,
  reservedNames: Iterable<string> = [],
  options: { allowGeneric?: boolean } = {},
): string | null {
  const pool = NAME_POOLS[agentType] ?? (options.allowGeneric ? GENERIC_WORKER_NAMES : undefined)
  if (!pool) return null
  const name = pickRandom(pool, reservedNames)
  activeNames.add(name)
  return name
}
```

In `src/tools/AgentTool/runAgent.ts`, change the worker-name allocation block from:

```ts
  const workerName =
    persistedWorkerHandle ??
    allocateWorkerName(agentDefinition.agentType, reservedWorkerHandles)
```

to:

```ts
  const workerName =
    persistedWorkerHandle ??
    allocateWorkerName(agentDefinition.agentType, reservedWorkerHandles, {
      allowGeneric: Boolean(sessionStateTracking),
    })
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
bun test src/agent-mode/workerNames.test.ts
```

Expected:

```text
pass
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/agent-mode/workerNames.ts src/agent-mode/workerNames.test.ts src/tools/AgentTool/runAgent.ts
git commit -m "fix: name generic agent mode workers"
```

---

### Task 2: Demote Worker Roster Status When The Main Spinner Is Visible

**Files:**
- Modify: `src/agent-mode/AgentModeWorkerRoster.tsx`
- Modify: `src/agent-mode/AgentModeWorkerRoster.test.tsx`
- Modify: `src/screens/REPL.tsx`

- [ ] **Step 1: Write the failing compact-roster tests**

Append this test inside `describe('AgentModeWorkerRoster', () => { existing tests and new tests })` in `src/agent-mode/AgentModeWorkerRoster.test.tsx`:

```ts
  test('renders compact roster as subordinate worker detail', () => {
    const summary: AgentModeWorkerUxSummary = {
      hasWorkers: true,
      active: 1,
      ready: 0,
      reviewed: 0,
      resumable: 0,
      stale: 0,
      attention: 0,
      pendingSynthesis: 0,
      visibleWorkers: [
        worker({
          agentId: 'worker-1',
          handle: 'Ada',
          role: 'Explore',
          description: 'Map data and analysis surfaces',
          status: 'running',
        }),
      ],
    }

    const node = AgentModeWorkerRoster({
      loaded: true,
      summary,
      compact: true,
    })
    const text = extractText(node)

    expect(text).toContain('Workers')
    expect(text).not.toContain('◉ Agent Mode workers')
    expect(text).toContain('1 active')
    expect(text).toContain('@Ada')
    expect(React.isValidElement(node) ? node.props.marginBottom : undefined).toBe(0)
  })
```

- [ ] **Step 2: Run the roster tests to verify RED**

Run:

```bash
bun test src/agent-mode/AgentModeWorkerRoster.test.tsx
```

Expected:

```text
FAIL
Property 'compact' does not exist
```

or:

```text
FAIL
Expected not to contain: "◉ Agent Mode workers"
```

- [ ] **Step 3: Implement compact roster rendering**

Update the component signature in `src/agent-mode/AgentModeWorkerRoster.tsx` from:

```tsx
export function AgentModeWorkerRoster({
  loaded,
  summary,
}: {
  loaded: boolean
  summary: AgentModeWorkerUxSummary | null
}): React.ReactNode {
  return (
    <Box width="100%" flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="claude">◉ Agent Mode workers</Text>
      </Box>
```

to:

```tsx
export function AgentModeWorkerRoster({
  loaded,
  summary,
  compact = false,
}: {
  loaded: boolean
  summary: AgentModeWorkerUxSummary | null
  compact?: boolean
}): React.ReactNode {
  return (
    <Box width="100%" flexDirection="column" marginBottom={compact ? 0 : 1}>
      <Box>
        {compact ? (
          <Text dimColor>Workers</Text>
        ) : (
          <Text color="claude">◉ Agent Mode workers</Text>
        )}
      </Box>
```

In `src/screens/REPL.tsx`, change the roster render from:

```tsx
{agentModeActive ? <AgentModeWorkerRoster loaded={agentModeSessionStateLoaded} summary={agentModeWorkerSummary} /> : null}
```

to:

```tsx
{agentModeActive ? (
  <AgentModeWorkerRoster
    loaded={agentModeSessionStateLoaded}
    summary={agentModeWorkerSummary}
    compact={showSpinner}
  />
) : null}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
bun test src/agent-mode/AgentModeWorkerRoster.test.tsx
```

Expected:

```text
pass
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/agent-mode/AgentModeWorkerRoster.tsx src/agent-mode/AgentModeWorkerRoster.test.tsx src/screens/REPL.tsx
git commit -m "fix: compact agent mode worker roster"
```

---

### Task 3: Lock Terminal-State Truth For Failed And Killed Workers

**Files:**
- Modify: `src/agent-mode/sessionState.test.ts`
- Modify if the new tests fail: `src/agent-mode/sessionState.ts`
- Modify if the new tests fail through the runtime path: `src/tools/AgentTool/AgentTool.tsx`
- Modify if the new tests fail through extracted helpers: `src/tools/AgentTool/agentToolUtils.ts`

- [ ] **Step 1: Write the failing terminal-state regression test**

Append this test inside the existing `describe('agent mode session state', () => { existing tests and new tests })` block in `src/agent-mode/sessionState.test.ts`:

```ts
  test('terminal failed and killed workers are removed from active counts', async () => {
    const objective = 'Keep terminal worker truth'
    const failedAgentId = randomUUID().slice(0, 8)
    const killedAgentId = randomUUID().slice(0, 8)

    await updateSessionState(
      sessionId,
      () =>
        createSessionState({
          sessionId,
          mode: 'agent',
          objective,
        }),
      () => {},
    )

    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective,
      handle: 'Ada',
      agentId: failedAgentId,
      role: 'Explore',
      description: 'Map surfaces',
      worktreePath: null,
      spawnedAt: '2026-05-03T00:00:00.000Z',
    })
    await recordWorkerSessionSpawn({
      sessionId,
      mode: 'agent',
      objective,
      handle: 'Katherine',
      agentId: killedAgentId,
      role: 'general-purpose',
      description: 'Run audit',
      worktreePath: null,
      spawnedAt: '2026-05-03T00:01:00.000Z',
    })

    await recordWorkerSessionTerminal({
      sessionId,
      agentId: failedAgentId,
      status: 'failed',
      error: 'Tool execution failed',
      outputSummary: 'Map surfaces',
    })
    await recordWorkerSessionTerminal({
      sessionId,
      agentId: killedAgentId,
      status: 'killed',
      outputSummary: 'Run audit',
    })

    const state = await readSessionState(sessionId)

    expect(state?.knownWorkers).toHaveLength(2)
    expect(state?.knownWorkers.map(worker => worker.status).sort()).toEqual([
      'failed',
      'killed',
    ])
    expect(state?.currentPhase).toBe('blocked')
    expect(state?.nextAction).toBe('Inspect Katherine and recover or report the blocker.')
    expect(state?.knownWorkers.some(worker => worker.status === 'running')).toBe(false)
  })
```

- [ ] **Step 2: Run the session-state tests to verify RED or confirm existing coverage**

Run:

```bash
bun test src/agent-mode/sessionState.test.ts --test-name-pattern "terminal failed and killed workers"
```

Expected if current code still has the stale-state bug:

```text
FAIL
```

with a mismatch showing a worker still has `status: 'running'`, or `currentPhase` is still `executing`.

Expected if the current source already fixed this part:

```text
pass
```

If the test passes immediately, do not change production code for this task. Keep the regression test and continue to Step 5.

- [ ] **Step 3: Implement minimal terminal-state fix if the test fails**

If the test fails because `recordWorkerSessionTerminal` leaves active state behind, update `src/agent-mode/sessionState.ts` so the start of `recordWorkerSessionTerminal` is:

```ts
export async function recordWorkerSessionTerminal({
  sessionId,
  agentId,
  status,
  error,
  outputSummary,
}: {
  sessionId: string
  agentId: string
  status: Exclude<AgentModeWorkerSessionStatus, 'running'>
  error?: string
  outputSummary?: string
}): Promise<void> {
  await mutatePersistedSessionState(sessionId, null, state => {
    for (const [handle, worker] of Object.entries(state.activeWorkers)) {
      if (worker.agentId === agentId) {
        delete state.activeWorkers[handle]
      }
    }

    const existing = state.knownWorkers[agentId]
    if (!existing) return
```

If the test fails because the terminal runtime path does not call `recordWorkerSessionTerminal`, inspect the failing path and add the call using this exact shape:

```ts
await recordWorkerSessionTerminal({
  sessionId: parentSessionId,
  agentId: syncAgentId,
  status: 'failed',
  error: errorMessage(error),
  outputSummary: description,
}).catch(_err =>
  logForDebugging(`Failed to record Agent Mode worker failure: ${_err}`),
)
```

Use `backgroundedTaskId` instead of `syncAgentId` in background-worker paths.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
bun test src/agent-mode/sessionState.test.ts src/agent-mode/workerUxSummary.test.ts src/tools/AgentTool/AgentTool.test.ts
```

Expected:

```text
pass
```

- [ ] **Step 5: Commit**

If only the regression test was needed, run:

```bash
git add src/agent-mode/sessionState.test.ts
git commit -m "test: cover agent mode terminal worker truth"
```

If production code changed too, run:

```bash
git add src/agent-mode/sessionState.ts src/agent-mode/sessionState.test.ts src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/agentToolUtils.ts
git commit -m "fix: sync agent mode terminal worker state"
```

---

### Task 4: Verify The Combined v2.4 Fix And Update Feedback Evidence

**Files:**
- Modify: `docs/agent/2026-05-02-agent-mode-v2.4-live-feedback.md`

- [ ] **Step 1: Run the focused automated suite**

Run:

```bash
bun test \
  src/agent-mode/workerNames.test.ts \
  src/agent-mode/AgentModeWorkerRoster.test.tsx \
  src/agent-mode/sessionState.test.ts \
  src/agent-mode/workerUxSummary.test.ts \
  src/tools/AgentTool/AgentTool.test.ts \
  src/commands/goal/goal.test.ts \
  src/tools/UpdateGoalTool/UpdateGoalTool.test.ts \
  src/agent-mode/agentMode.test.ts
```

Expected:

```text
pass
```

- [ ] **Step 2: Run a manual Agent Mode smoke check**

Run this from `/Users/pt/cat-code`:

```bash
AGENT_DEPLOYMENT=agent bun src/entrypoints/cli.tsx --agent-mode
```

In the Agent Mode session, submit:

```text
use Explore to map the Agent Mode worker roster code path, then stop after the worker starts
```

Expected visible behavior:

```text
Workers
1 active
  └─ @Ada · Explore · running · Map data and analysis surfaces
```

or another friendly handle from the generic pool instead of a raw `@<agent-id>` value.

Expected layout behavior:

```text
<spinner line>
Workers
1 active
  └─ @Name · Explore · running · Map data and analysis surfaces
──────────────────────────────────────────────────────────────────────────────
❯
```

There should be no `◉ Agent Mode workers` top-level heading while the spinner is visible, and no extra blank rows between the worker roster and prompt separator.

- [ ] **Step 3: Run a terminal-state smoke check**

In the same Agent Mode session, start a worker and cancel it with the UI stop action. If direct cancellation is awkward in the terminal session, use a small task that fails during initialization or returns `completed_with_error`.

Expected visible behavior after the terminal update:

```text
Workers
0 active · 1 attention
  └─ @Name · <role> · attention · <description or error>
```

There should be no stale `running` row for the same stopped or failed worker.

- [ ] **Step 4: Update v2.4 feedback evidence**

In `docs/agent/2026-05-02-agent-mode-v2.4-live-feedback.md`, add this subsection under each fixed issue.

Under V24-001:

```md
#### Evidence (verified 2026-05-03)

- Source fix: while the main spinner owns top-level progress, `AgentModeWorkerRoster` renders in compact mode as subordinate `Workers` detail instead of `◉ Agent Mode workers`.
- Test coverage: `src/agent-mode/AgentModeWorkerRoster.test.tsx` covers compact roster rendering.
- Manual smoke: Agent Mode spinner and worker roster no longer present two top-level status headings at the same time.
```

Under V24-002:

```md
#### Evidence (verified 2026-05-03)

- Source fix: `allocateWorkerName` supports an Agent Mode-only generic fallback pool, and `runAgent` enables it only when durable Agent Mode session tracking is active.
- Test coverage: `src/agent-mode/workerNames.test.ts` covers Explore and custom worker handle allocation.
- Manual smoke: Explore workers render with friendly handles instead of raw agent IDs.
```

Under V24-003:

```md
#### Evidence (verified 2026-05-03)

- Source fix: compact worker roster mode removes extra bottom margin while the spinner is visible.
- Test coverage: `src/agent-mode/AgentModeWorkerRoster.test.tsx` asserts compact roster `marginBottom` is `0`.
- Manual smoke: the worker roster sits directly above the prompt separator without unexplained blank rows.
```

Under V24-004:

```md
#### Evidence (verified 2026-05-03)

- Source fix: terminal worker state removes failed and killed workers from active tracking and surfaces terminal workers as attention state.
- Test coverage: `src/agent-mode/sessionState.test.ts` covers failed and killed workers leaving active state.
- Manual smoke: stopped or failed workers do not remain counted as active/running in the roster.
```

Replace the closure decision section with:

```md
## Closure decision

Current decision: complete with live-smoke evidence recorded on 2026-05-03.

Deferred follow-up:
- Continue watching for worker-spawn failures in non-cat-code workspaces. If `store is not defined` or another launch-time failure recurs, record it as a new v2.5 feedback item with the exact error text and worker role.
```

- [ ] **Step 5: Commit**

Run:

```bash
git add docs/agent/2026-05-02-agent-mode-v2.4-live-feedback.md
git commit -m "docs: close agent mode v2.4 feedback"
```

---

## Self-Review

Spec coverage:
- V24-001 is covered by Task 2 compact roster rendering.
- V24-002 is covered by Task 1 generic Agent Mode worker handles.
- V24-003 is covered by Task 2 compact roster spacing.
- V24-004 is covered by Task 3 terminal-state regression coverage and implementation fallback.
- Closure evidence is covered by Task 4.

Placeholder scan:
- The plan contains no forbidden placeholder terms, incomplete file references, or unspecified test commands.
- Every implementation task includes exact files, code snippets, commands, expected outcomes, and commit commands.

Type consistency:
- `allocateWorkerName(agentType, reservedNames, options)` is used consistently in tests and `runAgent`.
- `AgentModeWorkerRoster({ loaded, summary, compact })` is used consistently in tests and `REPL`.
- `recordWorkerSessionTerminal` uses the existing `status: 'failed' | 'killed' | 'completed'` model and does not add a new status type.
