# Agent Control Routing Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local-worker resume, running-worker messaging, and Agent Teams messaging unambiguous, race-safe, authority-checked, and truthful about delivery.

**Architecture:** Keep the existing three-tool boundary: `Agent` starts an entity, `SendMessage` targets running local workers or rostered teammates, and `ResumeAgent` restarts only stopped local workers. Use one versioned recipient-record collection as the team identity authority, never reuse a recipient key before team cleanup, give every mailbox envelope an immutable ID and exact sender/recipient allocation identity, acknowledge only processed IDs, correlate privileged responses with outstanding requests, and hold resume ownership until the detached lifecycle ends.

**Tech Stack:** TypeScript, Bun, `bun:test`, Zod v4, existing `proper-lockfile` wrapper, React/Ink for existing tool-result UI.

## Global Constraints

- Work only in `src/` plus the current routing maps under `docs/maps/`; do not touch `app/` or the desktop migration state.
- Do not begin implementation in the current dirty `migration` workspace until the user explicitly chooses the execution workspace. Do not create a branch or worktree without that authorization.
- Add no dependencies. Use `src/utils/lockfile.ts` for cross-process locks.
- Preserve the existing public tool set. Do not expose `Agent` or `ResumeAgent` to external in-process teammates.
- `ResumeAgent` remains local-subagent-only. It must never resume a teammate process or in-process teammate loop.
- `SendMessage` continues to accept idle rostered teammates and running local workers. Missing, starting, removed, or terminated teammates fail closed.
- New teammate identities use lowercase canonical names matching `^[a-z0-9][a-z0-9_-]*$`, at most 64 ASCII bytes. Trim surrounding whitespace, lowercase valid input, and reject `.`, `@`, `:`, `/`, `*`, whitespace inside the name, Windows device basenames, and other lossy spellings.
- Legacy roster names remain readable. If two legacy names map to the same recipient key or mailbox path, routing fails as ambiguous rather than guessing.
- Bare names prefer a current teammate roster member. `@name` explicitly targets a local worker. A bare name with no teammate match may resolve as a local alias, durable handle, or raw local agent ID.
- Mailbox control authorization protects Cat Code tool and runtime paths. It does not claim cryptographic protection against a same-user process that directly edits mailbox files.
- A teammate approving shutdown remains alive unless its acknowledgement is successfully written to the leader mailbox.
- Mailbox and team-file writes are described as `written`, not as crash-durable appends; this plan does not add `fsync`/rename crash-safe persistence.
- Existing teams with an older or absent `teamProtocolVersion` must be restarted or cleaned up before version-2 controls are accepted. Do not silently mix marked and legacy control formats.
- Mailbox size, message-size, count, and retention quotas are a separate hardening follow-up; do not expand this routing fix with a new quota policy.
- Tests for races use barriers/deferred promises, never timers or `sleep`.
- Do not run bare `bun test`, `bun test src/`, `bun run build`, or root `bun run typecheck`. The engine gate is focused tests plus `bun run build:dev:full`.
- Do not update `DONE.md` unless the user separately approves it.
- Commit steps in this plan are conditional: execute them only after the user explicitly authorizes commits.

---

## Design Decisions

### Recipient namespaces

For new allocations inside a team context, local aliases and teammate names share one case-insensitive namespace persisted in `TeamFile.recipientRecords`. The team transaction is always the first allocation authority; process-local worker-name reservation is a secondary guard. Display names may retain existing local-worker capitalization, but collision checks use `recipientNameKey(name)`. New teammate names are stored in canonical lowercase form everywhere: recipient record, deterministic ID input, mailbox filename, prompt result, and routing target.

Recipient keys are never reused within a team. `terminated` records remain as tombstones until explicit team cleanup, so a new teammate cannot inherit an old mailbox or deterministic identity. `allocationId` is the incarnation identity and is included in every version-2 mailbox envelope.

Legacy routing is explicit:

```text
@Ada        -> local worker alias only
ada         -> teammate named ada when present
ada         -> local alias/handle only when no teammate named ada exists
agent-...   -> raw local agent ID when no teammate has that exact canonical name
*           -> broadcast only
```

### Team roster transactions

`TeamFile` gains `teamProtocolVersion: 2` and one `recipientRecords` collection. Each record has `allocationId`, canonical key, display name, kind, agent ID, lifecycle status, and backend launch metadata. The state machine is:

```text
reserved -> starting -> active -> stopped | terminated
```

Before backend launch, the allocation transaction persists `starting` with launcher PID, a process-instance UUID, backend type, expected agent ID, and creation time. PID death alone never reclaims a `starting` record, so PID reuse cannot authorize cleanup. Recovery inspects the backend/task identity; uncertainty fails closed and requires explicit team cleanup. Local records remain claimed while their agent metadata is resumable, and terminated names remain tombstones, so no separate local-claim cleanup collection is needed.

All team mutations use one async `transactTeamFile` primitive that locks, fresh-reads, validates, writes once, and unlocks. Synchronous team access is read-only. Mailbox I/O never occurs while the team lock is held: recipient resolution takes a versioned snapshot, releases the lock, writes the mailbox, then optionally rechecks the same allocation ID.

### Mailbox control boundary

Every mailbox envelope gains `protocolVersion`, `messageId`, sender and recipient agent/allocation IDs, and exactly one payload class:

```text
chat
notification/protocol data
privileged control
```

`idle_notification` and `task_assignment` remain notifications with their existing behavior. Privileged controls use a closed Zod union and may be created only by `writeControlToMailbox`; plain chat input statically excludes the control field. Unmarked legacy control-shaped JSON is rejected with an explicit protocol-version error, not silently delivered or consumed.

Authority is checked against principals resolved from current runtime identity plus a fresh versioned roster snapshot:

| Direction | Allowed controls |
|---|---|
| team lead -> teammate | permission response, sandbox response, shutdown request, plan response, team-permission update, mode-set request |
| teammate -> team lead | permission request, sandbox request, shutdown approved/rejected, plan request |

`writeControlToMailbox` has no caller-authored sender argument; it resolves the sender principal from the current process or AsyncLocalStorage identity and accepts a recipient principal from a versioned roster snapshot. Field-specific validation binds friendly-name fields to `principal.name` and durable-ID fields to `principal.agentId`.

Response controls additionally consume an outstanding request record keyed by request ID, control type, sender/recipient agent IDs, and sender/recipient allocation IDs. Unsolicited, stale, duplicate, or wrong-incarnation responses fail closed.

### Resume ownership

`activeResumeLaunches` becomes lifecycle ownership rather than setup ownership. The owner is acquired before resume setup, transferred to the detached lifecycle promise when launch succeeds, and released only when that lifecycle settles. Setup failures release immediately. The internal primitive re-reads root task state after transcript/metadata I/O and before recording spawn state or replacing the task.

---

## File Structure

### Create

- `src/utils/recipientIdentity.ts` — bounded canonicalization, cross-platform reserved syntax, recipient keys, and validated explicit-local parsing.
- `src/utils/recipientIdentity.test.ts` — canonicalization and routing-key tests.
- `src/tools/shared/spawnMultiAgent.test.ts` — backend-independent reservation and concurrent spawn tests.
- `src/tools/shared/spawnMultiAgent.probe.test.ts` — two-process proof that local and teammate allocations share the persisted team namespace.
- `src/utils/swarm/teamHelpers.test.ts` — recipient transitions, concurrent mutations, malformed config, and recovery behavior.
- `src/hooks/useInboxPoller.test.ts` — pure mailbox-control classification and authority tests for the hook path.
- `src/utils/attachments.test.ts` — headless mailbox-control routing and invalid-control quarantine.
- `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts` — plan-request delivery failure and state-transition tests.

### Modify

- `src/agent-mode/workerNames.ts` and `.test.ts` — atomic explicit local-name reservation.
- `src/utils/swarm/teamHelpers.ts` — versioned recipient-record state machine and short async team transactions.
- `src/tools/shared/spawnMultiAgent.ts` — allocation state transitions and compensating backend cleanup.
- `src/tools/AgentTool/AgentTool.tsx` and tests — shared namespace checks, accurate schema/result guidance, continuation capability flags.
- `src/tools/AgentTool/resolveAgentTarget.ts` and tests — explicit-local parsing and reusable local recipient keys.
- `src/tools/AgentTool/agentToolUtils.ts` and tests — explicit in-process environment and capability filtering.
- `src/tools/AgentTool/prompt.ts` and tests — capability-derived continuation instructions.
- `src/tools/SendMessageTool/SendMessageTool.ts`, `UI.tsx`, and tests — deterministic routing, roster validation, partial broadcast results, authority checks, truthful failures.
- `src/utils/teammateMailbox.ts` and tests — versioned envelopes, exact-ID acknowledgement, written-result contract, payload classes, principal and request validation.
- `src/utils/attachments.ts` — exact-ID acknowledgement, notification preservation, headless control dispatch.
- `src/hooks/useInboxPoller.ts` — consume only authority-checked controls.
- `src/utils/swarm/inProcessRunner.ts` and tests — consume only typed leader shutdown controls; build prompt from resolved tools.
- `src/utils/swarm/permissionSync.ts` — emit typed permission and sandbox controls.
- `src/tools/TaskUpdateTool/TaskUpdateTool.ts` — preserve task-assignment notification semantics under the versioned envelope.
- `src/utils/directMemberMessage.ts` — preserve direct notification/chat routing under the versioned envelope.
- `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` and tests — emit typed plan requests and transition state only after delivery.
- `src/components/teams/TeamsDialog.tsx` — emit typed team-permission and mode controls; surface/log write failures.
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx` and tests — atomic queue-if-running operation.
- `src/tools/ResumeAgentTool/ResumeAgentTool.tsx` and tests — fresh post-resolution state check.
- `src/tools/AgentTool/resumeAgent.ts` and tests — lifecycle-long ownership.
- `src/screens/REPL.tsx` — atomic viewed-local-worker queue/resume decision.
- `docs/maps/agent-mode.md` — three-tool boundary, recipient syntax, lifecycle ownership, test routes.
- `docs/maps/tasks-workers.md` — roster/mailbox control boundary and input routing.
- `docs/maps/tools-permissions.md` — authority-checked mailbox controls and failure propagation.

---

### Task 1: Canonical recipient identities and atomic allocation

**Files:**
- Create: `src/utils/recipientIdentity.ts`
- Create: `src/utils/recipientIdentity.test.ts`
- Create: `src/tools/shared/spawnMultiAgent.test.ts`
- Create: `src/tools/shared/spawnMultiAgent.probe.test.ts`
- Create: `src/utils/swarm/teamHelpers.test.ts`
- Modify: `src/agent-mode/workerNames.ts:24-104`
- Modify: `src/agent-mode/workerNames.test.ts`
- Modify: `src/utils/swarm/teamHelpers.ts:64-182,184-484`
- Modify: `src/tools/shared/spawnMultiAgent.ts:122-145,267-294,305-539,545-753,840-1032`
- Modify: `src/tools/AgentTool/AgentTool.tsx:243-342,575-609,832-851,954-961,1033-1061`
- Modify: `src/tools/AgentTool/resolveAgentTarget.ts:98-125,217-312`
- Modify: `src/tools/AgentTool/resolveAgentTarget.test.ts`

**Interfaces:**
- Produces:

```ts
export class InvalidTeammateNameError extends Error {}
export class InvalidRecipientSyntaxError extends Error {}

export function canonicalizeNewTeammateName(input: string): string
export function recipientNameKey(input: string): string
export function parseLocalRecipient(input: string):
  | { explicit: true; target: string }
  | { explicit: false; target: string }

export function tryReserveWorkerName(name: string): boolean
export function selectWorkerNameCandidate(
  agentType: string,
  reservedNames?: Iterable<string>,
  options?: { allowGeneric?: boolean },
): string | null

export type TeamRecipientRecord = {
  allocationId: string
  key: string
  name: string
  kind: 'leader' | 'local' | 'teammate'
  agentId: string
  sessionId: string
  status: 'reserved' | 'starting' | 'active' | 'stopped' | 'terminated'
  launcherPid: number
  launcherInstanceId: string
  backendType?: BackendType
  createdAt: number
  updatedAt: number
}

export class TeamFileLockError extends Error {}

export async function readTeamSnapshot(
  teamName: string,
): Promise<Readonly<TeamFile>>

export async function transactTeamFile<T>(
  teamName: string,
  transaction: (
    teamFile: TeamFile,
  ) => { teamFile: TeamFile; result: T } | Promise<{ teamFile: TeamFile; result: T }>,
): Promise<{ result: T; warning?: string }>

export async function allocateTeamRecipient(args: {
  teamName: string
  requestedName: string
  kind: 'local' | 'teammate'
  conflict: 'error' | 'suffix'
  forbiddenKeys: ReadonlySet<string>
  agentId: string
  sessionId: string
  backendType?: BackendType
}): Promise<TeamRecipientRecord>

export async function transitionTeamRecipient(args: {
  teamName: string
  allocationId: string
  from: TeamRecipientRecord['status']
  to: TeamRecipientRecord['status']
  member?: TeamFile['members'][number]
}): Promise<void>

export async function recoverStartingRecipient(args: {
  teamName: string
  allocationId: string
}): Promise<'active' | 'terminated' | 'manual_cleanup_required'>
```

- Consumes: existing `src/utils/lockfile.ts`, `TeamFile`, `agentNameRegistry`, persisted local-agent metadata, and durable Agent Mode handles.

- [ ] **Step 1: Write canonical identity tests**

Add these exact cases to `src/utils/recipientIdentity.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  canonicalizeNewTeammateName,
  parseLocalRecipient,
  recipientNameKey,
} from './recipientIdentity.js'

describe('recipientIdentity', () => {
  test('canonicalizes valid new teammate names once', () => {
    expect(canonicalizeNewTeammateName('  Researcher_2  ')).toBe('researcher_2')
  })

  test.each(['*', 'team-lead', 'foo.bar', 'foo@bar', 'bridge:peer', 'uds:peer', '/peer', 'two words', 'con', 'NUL', 'com1', 'lpt9', 'a'.repeat(65)])(
    'rejects reserved or lossy teammate name %s',
    input => {
      expect(() => canonicalizeNewTeammateName(input)).toThrow()
    },
  )

  test('uses a case-insensitive collision key', () => {
    expect(recipientNameKey(' Ada ')).toBe('ada')
  })

  test('keeps explicit local addressing distinct from bare addressing', () => {
    expect(parseLocalRecipient('@Ada')).toEqual({ explicit: true, target: 'Ada' })
    expect(parseLocalRecipient('ada')).toEqual({ explicit: false, target: 'ada' })
    expect(() => parseLocalRecipient('@')).toThrow()
    expect(() => parseLocalRecipient('@@alice')).toThrow()
  })
})
```

- [ ] **Step 2: Run the identity tests and confirm the module is missing**

Run:

```bash
cd /Users/pt/cat-code && bun test src/utils/recipientIdentity.test.ts
```

Expected: FAIL because `src/utils/recipientIdentity.ts` does not exist.

- [ ] **Step 3: Implement the pure identity module**

Implement the exact policy:

```ts
const TEAMMATE_NAME = /^[a-z0-9][a-z0-9_-]*$/
const RESERVED = new Set(['*', 'team-lead'])
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/
const MAX_TEAMMATE_NAME_BYTES = 64

export class InvalidTeammateNameError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid teammate name "${input}": ${reason}`)
    this.name = 'InvalidTeammateNameError'
  }
}

export class InvalidRecipientSyntaxError extends Error {
  constructor(input: string) {
    super(`Invalid local recipient "${input}": use exactly one @ before a non-empty alias`)
    this.name = 'InvalidRecipientSyntaxError'
  }
}

export function recipientNameKey(input: string): string {
  return input.trim().toLowerCase()
}

export function canonicalizeNewTeammateName(input: string): string {
  const name = recipientNameKey(input)
  if (!TEAMMATE_NAME.test(name)) {
    throw new InvalidTeammateNameError(
      input,
      'use lowercase letters, numbers, hyphens, or underscores',
    )
  }
  if (RESERVED.has(name)) {
    throw new InvalidTeammateNameError(input, 'name is reserved for message routing')
  }
  if (WINDOWS_DEVICE_NAME.test(name)) {
    throw new InvalidTeammateNameError(input, 'name is reserved by Windows')
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_TEAMMATE_NAME_BYTES) {
    throw new InvalidTeammateNameError(input, 'name exceeds 64 bytes')
  }
  return name
}

export function parseLocalRecipient(input: string) {
  const trimmed = input.trim()
  if (!trimmed.startsWith('@')) {
    return { explicit: false as const, target: trimmed }
  }
  const target = trimmed.slice(1)
  if (target.length === 0 || target.startsWith('@')) {
    throw new InvalidRecipientSyntaxError(input)
  }
  return { explicit: true as const, target }
}
```

- [ ] **Step 4: Make worker-name reservation atomic**

Change `activeNames` and `getReservedNames` to store `recipientNameKey(name)`, and make every `pickNext` comparison use the candidate's recipient key. Add:

```ts
export function tryReserveWorkerName(name: string): boolean {
  const key = recipientNameKey(name)
  if (activeNames.has(key)) return false
  activeNames.add(key)
  return true
}
```

Split candidate selection from ownership: `selectWorkerNameCandidate` advances the existing pool cursor and returns a free candidate without reserving it; `allocateWorkerName` calls that selector and then `tryReserveWorkerName` for no-team callers. Make `releaseWorkerName` delete the normalized key, and retain `reserveWorkerName` only as a compatibility wrapper that calls `tryReserveWorkerName`.

Add tests proving two explicit reservations cannot both succeed and case variants collide:

```ts
expect(tryReserveWorkerName('Ada')).toBe(true)
expect(tryReserveWorkerName('ada')).toBe(false)
```

- [ ] **Step 5: Add one async team transaction primitive**

In `teamHelpers.ts`, add `teamProtocolVersion: 2` and `recipientRecords: TeamRecipientRecord[]` to `TeamFile`, add `allocationId` to each version-2 teammate member projection, and seed one active leader record when creating the team. Implement `readTeamSnapshot` and `transactTeamFile` with `lockfile.lock`; do not add synchronous mutation. The transaction uses:

```ts
{
  lockfilePath: `${getTeamFilePath(teamName)}.lock`,
  realpath: false,
  stale: 60_000,
  retries: {
    retries: 8,
    factor: 1.5,
    minTimeout: 10,
    maxTimeout: 100,
  },
}
```

`readTeamSnapshot` briefly locks only to fresh-read and validate version 2, then returns a detached immutable snapshot. `transactTeamFile` locks, fresh-reads, validates, applies one transaction, writes once, and releases. A release failure after the write returns the committed result plus `warning` rather than throwing and inviting replay. Neither callback may perform mailbox I/O.

Convert existing member removal, hidden-pane, mode, and active-state mutations to async `transactTeamFile` calls. Update every caller to await or explicitly observe rejection; no write may be silently dropped because of lock contention.

- [ ] **Step 6: Implement the recipient-record state machine**

Under one short team transaction:

1. Canonicalize teammate names; preserve normalized local display names and derive their key with `recipientNameKey`.
2. Treat every existing record, including `terminated`, as occupying its key.
3. For `conflict: 'error'`, reject an occupied key. For `conflict: 'suffix'`, search a suffix-aware candidate that remains within 64 bytes.
4. Append a `reserved` record with a fresh `allocationId`, expected agent ID, session ID, launcher PID, process-instance UUID, and creation time.
5. Before backend launch, transition that exact record from `reserved` to `starting` and record backend type.

Transitions compare both `allocationId` and expected `from` state. Invalid or duplicate transitions fail closed. `starting` records are never reclaimed solely from PID death. `recoverStartingRecipient` checks the recorded backend/task identity: confirmed live becomes `active`, confirmed absent becomes a `terminated` tombstone, and uncertainty returns `manual_cleanup_required`.

- [ ] **Step 7: Reserve once before selecting a spawn backend**

In `AgentTool.call`, collect local recipient keys from live registry entries, persisted metadata aliases, durable handles, and active in-memory worker names. Acquire `allocateTeamRecipient({ kind: 'teammate', conflict: 'suffix' })` before calling `tryReserveWorkerName` or selecting a backend. If the process-local reservation loses to a no-team allocation in the same process, transition the unused record to a tombstone and retry the next suffix; never delete or reuse its key.

Pass the allocation record into `SpawnTeammateConfig`. Remove all three backend-local calls to `generateUniqueTeammateName` and `sanitizeAgentName`. Each backend must receive the already canonical `name`, allocation ID, and deterministic `agentId`.

Persist `starting` before launch. After backend creation and initial-message write, transition the exact allocation to `active` with the complete member record, then release the process-local guard. Each failure path performs compensating actions for the side effects already completed—abort controller, task registration, AppState entry, pane/process, member projection—and finally transitions the allocation to `terminated`. Never delete the record.

- [ ] **Step 8: Reserve explicit local aliases before asynchronous setup**

Pass the resolved current `teamName` into `resolveSystemSubagentName`. For an explicit name in a team, acquire `allocateTeamRecipient({ kind: 'local', conflict: 'error' })` before `tryReserveWorkerName`. For an automatic name in a team, call `selectWorkerNameCandidate`, attempt the same allocation with `conflict: 'error'`, and advance when occupied. Outside a team, use the existing `allocateWorkerName` path. Return:

```ts
type ResolvedSystemSubagentName = {
  agentName: string
  processReservationName: string
  teamAllocation?: {
    teamName: string
    allocationId: string
  }
}
```

Do not release the process-local reservation until `registerAgentName` has transferred ownership to `agentNameRegistry` and the team record is `active`. Local completion transitions the record to `stopped`; it remains occupied and resumable. Explicit local deletion or team cleanup transitions it to `terminated`, still retaining the tombstone until the entire team is deleted. Setup failure compensates completed side effects and transitions the record to `terminated`.

- [ ] **Step 9: Add barrier-controlled allocation tests**

Create the team file in the test `beforeEach`, then have `spawnMultiAgent.test.ts` call the real allocation function concurrently:

```ts
const [first, second] = await Promise.all([
  allocateTeamRecipient({
    teamName: 'review-team',
    requestedName: 'researcher',
    kind: 'teammate',
    conflict: 'suffix',
    forbiddenKeys: new Set(),
    agentId: 'researcher@review-team',
    sessionId: 'session-1',
  }),
  allocateTeamRecipient({
    teamName: 'review-team',
    requestedName: 'researcher',
    kind: 'teammate',
    conflict: 'suffix',
    forbiddenKeys: new Set(),
    agentId: 'researcher-2@review-team',
    sessionId: 'session-1',
  }),
])
expect([first.name, second.name].sort()).toEqual([
  'researcher',
  'researcher-2',
])
```

For full spawn tests, use a deferred backend promise to hold the first launch after its `starting` record is written but before the `active` transition, then start the second launch. Repeat through split-pane, separate-window, and in-process backend mocks. Add tests for:

- direct rejection of invalid teammate inputs `foo@bar` and `foo.bar`;
- local `researcher` versus teammate `researcher` collision;
- concurrent explicit local aliases allowing exactly one launch;
- launch failure compensating every completed side effect and leaving a `terminated` tombstone.
- terminating `alice` and requesting `alice` again never reuses the original key or allocation ID; suffix mode selects `alice-2`, while error mode rejects.

In `spawnMultiAgent.probe.test.ts`, start two `bun -e` child processes with the same temporary `CLAUDE_CONFIG_DIR` and team name. Release them from a shared barrier so one allocates `kind: 'local'` while the other allocates `kind: 'teammate'` with `conflict: 'error'`. Keep the winner alive on a second barrier while the parent inspects `config.json`; assert exactly one record owns the key and the loser reports the collision. Release the winner afterward. Test crash recovery separately: a dead launcher with a `starting` record is never automatically reused.

Add crash-injection tests after backend creation, command send, AppState insertion, task registration, member projection, and initial mailbox write. Each test asserts completed side effects are compensated where possible and the allocation remains a non-reusable `terminated` or fail-closed `starting` record.

Add transaction tests proving concurrent mode update plus recipient activation preserves both changes, concurrent removal plus allocation preserves the tombstone and new record, malformed team config fails without rewrite, and lock-release failure after a successful write is reported without replaying the transaction.

- [ ] **Step 10: Run focused identity and spawn tests**

Run:

```bash
cd /Users/pt/cat-code && bun test src/utils/recipientIdentity.test.ts src/agent-mode/workerNames.test.ts src/utils/swarm/teamHelpers.test.ts src/tools/AgentTool/AgentTool.test.ts src/tools/AgentTool/resolveAgentTarget.test.ts src/tools/shared/spawnMultiAgent.test.ts src/tools/shared/spawnMultiAgent.probe.test.ts
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 11: Commit the identity slice if commits are authorized**

```bash
cd /Users/pt/cat-code && git add src/utils/recipientIdentity.ts src/utils/recipientIdentity.test.ts src/agent-mode/workerNames.ts src/agent-mode/workerNames.test.ts src/utils/swarm/teamHelpers.ts src/utils/swarm/teamHelpers.test.ts src/tools/shared/spawnMultiAgent.ts src/tools/shared/spawnMultiAgent.test.ts src/tools/shared/spawnMultiAgent.probe.test.ts src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/AgentTool.test.ts src/tools/AgentTool/resolveAgentTarget.ts src/tools/AgentTool/resolveAgentTarget.test.ts && git commit -m "fix(agents): make recipient identity allocation atomic"
```

---

### Task 2: Deterministic routing and truthful mailbox delivery

**Files:**
- Modify: `src/utils/teammateMailbox.ts:79-265`
- Modify: `src/utils/teammateMailbox.test.ts`
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts:99-272,526-948`
- Modify: `src/tools/SendMessageTool/UI.tsx`
- Modify: `src/tools/SendMessageTool/SendMessageTool.test.ts`
- Modify: `src/tools/SendMessageTool/UI.test.tsx`

**Interfaces:**
- Consumes: `canonicalizeNewTeammateName`, `recipientNameKey`, `parseLocalRecipient`, `readTeamSnapshot`, and `TeamRecipientRecord`.
- Produces:

```ts
export class MailboxWriteError extends Error {
  readonly recipientName: string
  readonly operation: 'mkdir' | 'create' | 'lock' | 'read' | 'write'
  constructor(
    recipientName: string,
    operation: MailboxWriteError['operation'],
    cause: unknown,
  )
}

export type TeamPrincipal = {
  kind: 'leader' | 'teammate'
  agentId: string
  name: string
  allocationId: string
}

export type MailboxWrittenResult = {
  written: true
  messageId: string
  warning?: string
}

export type MailboxChatInput = {
  text: string
  summary?: string
  color?: string
  control?: never
  notification?: never
}

export async function resolveCurrentTeamPrincipal(
  teamName: string,
  snapshot: Readonly<TeamFile>,
): Promise<TeamPrincipal>

export async function acknowledgeMailboxMessages(args: {
  recipient: TeamPrincipal
  teamName: string
  messageIds: readonly string[]
}): Promise<void>

export type FailedRecipient = { name: string; error: string }

export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  failed_recipients?: FailedRecipient[]
  routing?: MessageRouting
}
```

- [ ] **Step 1: Write failing mailbox-write and exact-acknowledgement tests**

Create a file at the would-be teams directory so `mkdir` fails with `ENOTDIR`, then assert rejection. Also add a barrier-controlled acknowledgement race:

```ts
const alicePrincipal: TeamPrincipal = {
  kind: 'teammate',
  agentId: 'alice@review-team',
  name: 'alice',
  allocationId: 'allocation-alice',
}
const teamsPath = join(tempDir, 'teams')
writeFileSync(teamsPath, 'not a directory')
await expect(
  writeToMailbox({
    recipient: alicePrincipal,
    message: { text: 'status?' },
    teamName: 'review-team',
  }),
).rejects.toBeInstanceOf(MailboxWriteError)

const first = await writeToMailbox({
  recipient: alicePrincipal,
  message: { text: 'A' },
  teamName: 'review-team',
})
const snapshot = await readUnreadMessages('alice', 'review-team')
expect(snapshot.map(message => message.messageId)).toEqual([first.messageId])

const second = await writeToMailbox({
  recipient: alicePrincipal,
  message: { text: 'B' },
  teamName: 'review-team',
})
await acknowledgeMailboxMessages({
  recipient: alicePrincipal,
  teamName: 'review-team',
  messageIds: [first.messageId],
})
const afterAck = await readMailbox('alice', 'review-team')
expect(afterAck.find(message => message.messageId === first.messageId)?.read).toBe(true)
expect(afterAck.find(message => message.messageId === second.messageId)?.read).toBe(false)
```

- [ ] **Step 2: Run the mailbox test and confirm false fulfillment**

```bash
cd /Users/pt/cat-code && bun test src/utils/teammateMailbox.test.ts
```

Expected: the new test fails because `writeToMailbox` currently catches and returns.

- [ ] **Step 3: Add versioned envelopes and exact-ID acknowledgement**

Every write generates a UUID `messageId` and stores `protocolVersion: 2`, sender/recipient agent IDs, sender/recipient allocation IDs, payload class, timestamp, and unread state. `writeToMailbox` accepts only `MailboxChatInput`, resolves the sender from runtime identity, and returns `{ written: true, messageId }` only after the JSON rewrite succeeds.

Wrap pre-write and write errors with recipient and operation context, log once, and rethrow. If lock release fails after a successful write, return `{ written: true, messageId, warning }`: the message exists from the process's perspective, and reporting failure would invite a duplicate retry. Do not call this crash-durable.

Do not convert malformed mailbox JSON to `[]` during a write. Treat schema failure as `MailboxWriteError('read')` and preserve the file.

`acknowledgeMailboxMessages` locks the mailbox, re-reads it, and marks only the supplied IDs read. Unknown IDs are harmless no-ops. Replace broad `markMessagesAsRead` and predicate acknowledgement in the poller and attachments paths; each handler acknowledges only after successful processing. Invalid controls are acknowledged by their exact ID after quarantine logging.

- [ ] **Step 4: Resolve recipients deterministically**

Refactor `SendMessageTool.call` to use this order:

```ts
const parsed = parseLocalRecipient(input.to)
if (parsed.explicit) {
  return routeToLocalWorker(parsed.target)
}

if (isAgentSwarmsEnabled()) {
  const teammate = await resolveFreshRosterMember(parsed.target)
  if (teammate.kind === 'ambiguous') return ambiguousRecipientFailure(teammate)
  if (teammate.kind === 'member') return routeToTeammate(teammate.member)
}

return routeToLocalWorker(parsed.target)
```

`resolveFreshRosterMember` uses `readTeamSnapshot`, requires protocol version 2, and returns a `TeamPrincipal` for an `active` or idle rostered teammate. It rejects `reserved`, `starting`, `stopped`, `terminated`, absent, and ambiguous legacy identities. Release the team lock before mailbox I/O. After a successful write, optionally re-read and report that delivery raced with removal when the same allocation ID is no longer routable; never hold the team lock while acquiring mailbox locks.

- [ ] **Step 5: Propagate plain-send failure**

`handleMessage` returns `success: false` with `Failed to send to <name>: <error>` when the write rejects. It must not create an inbox for a name absent from the roster. A successful result means “written to the addressed incarnation's mailbox,” not “processed by the recipient.”

Add this reusable harness to `SendMessageTool.test.ts`; each test writes an actual roster because AppState alone is no longer authoritative:

```ts
function makeMember(name: string, isActive = true): TeamFile['members'][number] {
  return {
    agentId: `${name}@review-team`,
    allocationId: `allocation-${name}`,
    name,
    joinedAt: 1,
    tmuxPaneId: `pane-${name}`,
    cwd: tempDir,
    subscriptions: [],
    isActive,
  }
}

function createTeamHarness(args: {
  members: TeamFile['members']
  tasks?: Record<string, LocalAgentTaskState>
  aliases?: Array<[string, string]>
}) {
  const teamFile: TeamFile = {
    name: 'review-team',
    teamProtocolVersion: 2,
    createdAt: 1,
    leadAgentId: 'lead',
    members: args.members,
    recipientRecords: args.members.map(member => ({
      allocationId: member.allocationId,
      key: recipientNameKey(member.name),
      name: member.name,
      kind: 'teammate',
      agentId: member.agentId,
      sessionId: 'session-1',
      status: 'active',
      launcherPid: process.pid,
      launcherInstanceId: 'test-process',
      createdAt: 1,
      updatedAt: 1,
    })),
  }
  const path = join(tempDir, 'teams', 'review-team', 'config.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(teamFile))
  let state = {
    agentNameRegistry: new Map(args.aliases ?? []),
    tasks: args.tasks ?? {},
    teamContext: {
      teamName: 'review-team',
      teamFilePath: path,
      leadAgentId: 'lead',
      isLeader: true,
      teammates: Object.fromEntries(
        args.members.map(member => [
          member.agentId,
          {
            name: member.name,
            tmuxSessionName: 'session',
            tmuxPaneId: member.tmuxPaneId,
            cwd: member.cwd,
            spawnedAt: member.joinedAt,
          },
        ]),
      ),
    },
  }
  return {
    context: {
      getAppState: () => state,
      setAppState: (updater: (prev: typeof state) => typeof state) => {
        state = updater(state)
      },
    } as never,
    getState: () => state,
  }
}

async function callSendMessage(
  to: string,
  harness: ReturnType<typeof createTeamHarness>,
) {
  return SendMessageTool.call(
    { to, summary: 'follow up', message: 'follow-up' },
    harness.context,
    undefined as never,
    { requestId: `req-${to}` } as never,
  )
}
```

Then add:

```ts
const missingHarness = createTeamHarness({ members: [makeMember('alice')] })
const missing = await callSendMessage('alic', missingHarness)
expect(missing.data).toMatchObject({ success: false })
expect(existsSync(getInboxPath('alic', 'review-team'))).toBe(false)

const idleHarness = createTeamHarness({
  members: [makeMember('alice', false)],
})
const idle = await callSendMessage('alice', idleHarness)
expect(idle.data).toMatchObject({ success: true })
```

- [ ] **Step 6: Report partial broadcast delivery**

Resolve a versioned recipient snapshot in one short team read, release the team lock, then use `Promise.allSettled` for mailbox writes. Populate `recipients` only with successful writes and `failed_recipients` for failures. Set `success` to `false` when any intended recipient fails. Render successful and failed recipient counts in `UI.tsx`.

Test two successes plus one injected failure:

```ts
const broadcastHarness = createTeamHarness({
  members: [makeMember('alice'), makeMember('bob'), makeMember('carol')],
})
const append = spyOn(teammateMailbox, 'writeToMailbox').mockImplementation(
  mock(async args => {
    if (args.recipient.name === 'bob') {
      throw new MailboxWriteError('bob', 'write', new Error('disk full'))
    }
    return originalWriteToMailbox(args)
  }) as never,
)
const result = await SendMessageTool.call(
  { to: '*', summary: 'status check', message: 'report status' },
  broadcastHarness.context,
  undefined as never,
  { requestId: 'req-broadcast' } as never,
)

expect(result.data).toMatchObject({
  success: false,
  recipients: ['alice', 'carol'],
  failed_recipients: [{ name: 'bob', error: expect.any(String) }],
})
expect(append).toHaveBeenCalledTimes(3)
```

Capture `originalWriteToMailbox = teammateMailbox.writeToMailbox` before installing the spy so successful recipients exercise the real append path.

- [ ] **Step 7: Add legacy collision routing tests**

Cover the routing rules with the harness above:

```ts
const collisionHarness = createTeamHarness({
  members: [makeMember('researcher')],
  aliases: [['researcher', 'agent-local']],
  tasks: {
    'agent-local': {
      id: 'agent-local',
      type: 'local_agent',
      status: 'running',
      agentId: 'agent-local',
      agentType: 'general-purpose',
      pendingMessages: [],
    },
  },
})

const bare = await callSendMessage('researcher', collisionHarness)
expect(bare.data.message).toContain("researcher's inbox")
expect(
  collisionHarness.getState().tasks['agent-local'].pendingMessages,
).toEqual([])

const explicitLocal = await callSendMessage('@researcher', collisionHarness)
expect(explicitLocal.data.message).toContain('queued for delivery')
expect(
  collisionHarness.getState().tasks['agent-local'].pendingMessages,
).toEqual(['follow-up'])

const ambiguousHarness = createTeamHarness({
  members: [makeMember('legacy.name'), makeMember('legacy-name')],
})
const ambiguous = await callSendMessage('legacy.name', ambiguousHarness)
expect(ambiguous.data).toMatchObject({ success: false })
expect(ambiguous.data.message).toContain('ambiguous legacy teammate name')
```

Retain existing raw agent-ID, durable-handle, running local-worker, and stopped local-worker tests.

- [ ] **Step 8: Run focused mailbox and SendMessage tests**

```bash
cd /Users/pt/cat-code && bun test src/utils/teammateMailbox.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/SendMessageTool/UI.test.tsx
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 9: Commit the delivery slice if commits are authorized**

```bash
cd /Users/pt/cat-code && git add src/utils/teammateMailbox.ts src/utils/teammateMailbox.test.ts src/tools/SendMessageTool/SendMessageTool.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/SendMessageTool/UI.tsx src/tools/SendMessageTool/UI.test.tsx && git commit -m "fix(agents): make teammate delivery truthful"
```

---

### Task 3: Typed and authority-checked mailbox controls

**Files:**
- Modify: `src/utils/teammateMailbox.ts:55-75,469-1192`
- Modify: `src/utils/teammateMailbox.test.ts`
- Modify: `src/utils/attachments.ts:3585-3755`
- Create: `src/utils/attachments.test.ts`
- Modify: `src/hooks/useInboxPoller.ts:220-821`
- Create: `src/hooks/useInboxPoller.test.ts`
- Modify: `src/utils/swarm/inProcessRunner.ts:693-905,1448-1489`
- Modify: `src/utils/swarm/inProcessRunner.test.ts`
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts:53-71,274-524,611-768,918-943`
- Modify: `src/tools/SendMessageTool/SendMessageTool.test.ts`
- Modify: `src/utils/swarm/permissionSync.ts:680-928`
- Modify: `src/tools/TaskUpdateTool/TaskUpdateTool.ts`
- Modify: `src/utils/directMemberMessage.ts`
- Modify: `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:263-312`
- Create: `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts`
- Modify: `src/components/teams/TeamsDialog.tsx:645-713`

**Interfaces:**
- Produces:

```ts
export const MailboxControlPayloadSchema = lazySchema(() =>
  z.union([
    PermissionRequestMessageSchema(),
    PermissionResponseMessageSchema(),
    SandboxPermissionRequestMessageSchema(),
    SandboxPermissionResponseMessageSchema(),
    ShutdownRequestMessageSchema(),
    ShutdownApprovedMessageSchema(),
    ShutdownRejectedMessageSchema(),
    PlanApprovalRequestMessageSchema(),
    PlanApprovalResponseMessageSchema(),
    TeamPermissionUpdateMessageSchema(),
    ModeSetRequestMessageSchema(),
  ]),
)

export type MailboxControlPayload = z.infer<
  ReturnType<typeof MailboxControlPayloadSchema>
>

export const MailboxNotificationPayloadSchema = lazySchema(() =>
  z.union([
    IdleNotificationMessageSchema(),
    TaskAssignmentMessageSchema(),
  ]),
)

export type MailboxNotificationPayload = z.infer<
  ReturnType<typeof MailboxNotificationPayloadSchema>
>

export type ClassifiedMailboxMessage =
  | { kind: 'chat'; message: TeammateMessage }
  | { kind: 'notification'; message: TeammateMessage; notification: MailboxNotificationPayload }
  | { kind: 'control'; message: TeammateMessage; control: MailboxControlPayload }
  | { kind: 'invalid_control'; message: TeammateMessage; reason: string }
  | { kind: 'protocol_mismatch'; message: TeammateMessage; reason: string }

export function classifyMailboxMessage(args: {
  message: TeammateMessage
  receiver: TeamPrincipal
  sender: TeamPrincipal
  pendingControls: readonly PendingControlRecord[]
}): ClassifiedMailboxMessage

export async function writeControlToMailbox(args: {
  recipient: TeamPrincipal
  control: MailboxControlPayload
  teamName: string
  color?: string
}): Promise<MailboxWrittenResult>

export type PendingControlRecord = {
  requestId: string
  requestType: 'permission' | 'sandbox' | 'shutdown' | 'plan'
  senderAgentId: string
  senderAllocationId: string
  recipientAgentId: string
  recipientAllocationId: string
  state: 'sending' | 'written' | 'processing' | 'consumed'
}

export async function claimPendingControl(args: {
  teamName: string
  response: TeammateMessage
  control: MailboxControlPayload
}): Promise<PendingControlRecord | null>

export async function finishPendingControl(args: {
  teamName: string
  requestId: string
  outcome: 'consumed' | 'retry'
}): Promise<void>
```

- Consumes: written-result and principal contracts from Task 2 plus recipient allocation IDs from Task 1.

- [ ] **Step 1: Add the closed control union and envelope field**

Add `pendingControls?: PendingControlRecord[]` to version-2 `TeamFile`. Add Zod schemas for `TeamPermissionUpdateMessage` and the non-privileged notification union (`idle_notification`, `task_assignment`). The current cast-only parsers are not sufficient at the boundary. Add mutually exclusive `chat`, `notification`, and `control` payload fields to the hand-written `TeammateMessage` type.

Avoid a module-initialization temporal-dead-zone: make both envelope schemas lazy and invoke them at read time:

```ts
const TeammateMailboxMessageSchema = lazySchema(() =>
  z.object({
    protocolVersion: z.literal(2),
    messageId: z.string().uuid(),
    senderAgentId: z.string(),
    senderAllocationId: z.string(),
    recipientAgentId: z.string(),
    recipientAllocationId: z.string(),
    payloadKind: z.enum(['chat', 'notification', 'control']),
    text: z.string(),
    timestamp: z.string(),
    read: z.boolean(),
    color: z.string().optional(),
    summary: z.string().optional(),
    structured: TeammateStructuredPayloadSchema.optional(),
    notification: MailboxNotificationPayloadSchema().optional(),
    control: MailboxControlPayloadSchema().optional(),
  }).superRefine(validateExclusivePayloadClass),
)

const TeammateMailboxFileSchema = lazySchema(() =>
  z.array(TeammateMailboxMessageSchema()),
)
```

Replace every `TeammateMailboxFileSchema.safeParse(...)` call with `TeammateMailboxFileSchema().safeParse(...)`. The control union is closed by its listed `type` literals; an unknown `type` is not a control. Team protocol mismatch is a named failure requiring restart/cleanup, not an `invalid_control` downgrade.

`writeControlToMailbox` resolves the sender principal internally, enforces the complete direction matrix against the recipient principal, serializes `control` into `text` for existing UI display, and stores the same validated object in `control`. The low-level chat writer's type makes `control` unrepresentable. Field-specific validation rejects friendly-name or durable-ID fields that contradict the resolved sender principal.

- [ ] **Step 2: Write authority-classifier tests**

Create concrete principals and a version-2 envelope helper:

```ts
const leader: TeamPrincipal = {
  kind: 'leader',
  agentId: 'lead',
  name: TEAM_LEAD_NAME,
  allocationId: 'allocation-lead',
}
const alice: TeamPrincipal = {
  kind: 'teammate',
  agentId: 'alice@review-team',
  name: 'alice',
  allocationId: 'allocation-alice',
}
const bob: TeamPrincipal = {
  kind: 'teammate',
  agentId: 'bob@review-team',
  name: 'bob',
  allocationId: 'allocation-bob',
}

function controlEnvelope(
  sender: TeamPrincipal,
  recipient: TeamPrincipal,
  control: MailboxControlPayload,
): TeammateMessage {
  return {
    protocolVersion: 2,
    messageId: randomUUID(),
    senderAgentId: sender.agentId,
    senderAllocationId: sender.allocationId,
    recipientAgentId: recipient.agentId,
    recipientAllocationId: recipient.allocationId,
    payloadKind: 'control',
    text: JSON.stringify(control),
    timestamp: '2026-07-12T00:00:00.000Z',
    read: false,
    control,
  }
}

const shutdownRequest = createShutdownRequestMessage({
  requestId: 'shutdown-1',
  from: TEAM_LEAD_NAME,
})
const pendingShutdown: PendingControlRecord = {
  requestId: 'shutdown-1',
  requestType: 'shutdown',
  senderAgentId: leader.agentId,
  senderAllocationId: leader.allocationId,
  recipientAgentId: alice.agentId,
  recipientAllocationId: alice.allocationId,
  state: 'written',
}

expect(
  classifyMailboxMessage({
    message: controlEnvelope(leader, alice, shutdownRequest),
    sender: leader,
    receiver: alice,
    pendingControls: [],
  }),
).toMatchObject({ kind: 'control', control: shutdownRequest })

const shutdownApproved = createShutdownApprovedMessage({
  requestId: 'shutdown-1',
  from: 'alice',
})
expect(
  classifyMailboxMessage({
    message: controlEnvelope(alice, leader, shutdownApproved),
    sender: alice,
    receiver: leader,
    pendingControls: [pendingShutdown],
  }),
).toMatchObject({ kind: 'control', control: shutdownApproved })
expect(
  classifyMailboxMessage({
    message: controlEnvelope(alice, leader, shutdownApproved),
    sender: alice,
    receiver: leader,
    pendingControls: [],
  }),
).toMatchObject({ kind: 'invalid_control' })

expect(
  classifyMailboxMessage({
    message: controlEnvelope(bob, alice, shutdownRequest),
    sender: bob,
    receiver: alice,
    pendingControls: [pendingShutdown],
  }),
).toMatchObject({ kind: 'invalid_control' })

const staleAlice = { ...alice, allocationId: 'allocation-alice-old' }
expect(
  classifyMailboxMessage({
    message: controlEnvelope(leader, staleAlice, shutdownRequest),
    sender: leader,
    receiver: alice,
    pendingControls: [pendingShutdown],
  }),
).toMatchObject({ kind: 'invalid_control' })
```

Use table-driven cases for every authority-matrix row. For response controls, include a matching `PendingControlRecord`, then repeat with no record, a consumed record, the wrong allocation ID, and duplicate delivery; only the first matching unconsumed response is accepted. Add protocol mismatch cases and regression cases proving `idle_notification` and `task_assignment` classify as `notification`, not chat or invalid control.

Add a sender-resolution test with teammate runtime identity `alice`: a `writeControlToMailbox` call containing an inner leader identity must reject, and TypeScript must reject an attempted `from: TEAM_LEAD_NAME` argument because the API has no caller-authored sender field.

- [ ] **Step 3: Run the classifier tests and confirm text-only parsing still wins**

```bash
cd /Users/pt/cat-code && bun test src/utils/teammateMailbox.test.ts
```

Expected: FAIL because `classifyMailboxMessage`, the `control` envelope field, and the closed control union do not exist yet.

- [ ] **Step 4: Implement authority classification**

The classifier must:

1. Require protocol version 2 and exact sender/recipient agent and allocation IDs.
2. Return `chat`, `notification`, or `control` only when the declared payload class and payload field agree.
3. Reject unmarked legacy control-shaped text with `protocol_mismatch`; unrelated text/JSON remains chat.
4. Enforce the direction matrix using resolved `TeamPrincipal` values.
5. Bind `from`/worker-name fields to `principal.name` and durable-ID fields to `principal.agentId`.
6. For response controls, require one matching outstanding request record in the supplied snapshot.
7. Return `invalid_control` on identity, authority, request, duplicate, or incarnation mismatch; never downgrade it to chat.

The asynchronous dispatcher then calls `claimPendingControl`, which compare-and-swaps `sending | written -> processing` for the exact request and principal tuple. A response already present in the mailbox proves the request write crossed the process boundary even if the sender crashed before marking it `written`. Only the claim winner runs the handler. Successful handling calls `finishPendingControl(...'consumed')`; failure returns it to `written` and leaves the mailbox message unread.

- [ ] **Step 5: Classify controls before attachment delivery**

Replace the text-only `isStructuredProtocolMessage` split with versioned envelope classification. In `attachments.ts`, read a short team snapshot, resolve principals, classify each unread mailbox message, and split it into chat, notification, valid control, mismatch, and invalid-control lists.

- Chat and the existing model-visible notifications enter their current attachment paths.
- Invalid controls and mismatches are acknowledged by exact `messageId` and logged by sender/type/reason without payload contents.
- In interactive mode, valid controls remain unread for `useInboxPoller`.
- In headless mode, process the existing `shutdown_approved` behavior from the valid-control list, consume its pending request, then acknowledge its exact ID. Select the member from the resolved sender principal.

This also fixes the current unreachable headless shutdown branch, which filters structured messages out of `allMessages` and then scans only `allMessages` for `shutdown_approved`.

Expose `getTeammateMailboxAttachments` only through a narrow `_attachmentsForTest` export. In `attachments.test.ts`, invoke that seam with a temporary version-2 team and mailbox. Prove exact-ID acknowledgement does not consume a concurrent append; chat addressed to an old allocation is not delivered to the current occupant; a valid correlated `shutdown_approved` removes only its sender allocation; wrong-incarnation and legacy lookalikes remove nobody; and idle/task notifications retain existing behavior.

- [ ] **Step 6: Migrate all privileged control producers**

Use `writeControlToMailbox` in:

- `permissionSync.ts` for permission and sandbox requests/responses;
- `SendMessageTool.ts` for shutdown requests/responses and plan responses;
- `ExitPlanModeV2Tool.ts` for plan requests;
- `useInboxPoller.ts` for its automatic plan approval response;
- `TeamsDialog.tsx` for team-permission and mode-set controls;
- `teammateMailbox.ts` `sendShutdownRequestToMailbox`.

Ordinary chat call sites remain on `writeToMailbox` without `control`.
Migrate idle and task-assignment producers to the explicit notification payload without changing their current model-visible behavior.

Every producer resolves its recipient principal from a version-2 snapshot and lets `writeControlToMailbox` resolve the sender internally. Request producers create a `PendingControlRecord` in state `sending`, release the team lock, write the control, then mark the record `written`; a crash after the write leaves a correlatable `sending` record, while a normal write failure removes it. Response consumers atomically claim `sending | written -> processing`, run the handler once, then transition to `consumed`; handler failure returns the record to `written`.

Every producer must await or explicitly observe the returned promise. For UI callbacks whose signature is `void`, use `void writeControlToMailbox(...).then(handleWritten, handleFailure)`; on failure, keep the permission/plan request unresolved and surface the existing error/log path instead of recording approval or rejection as written.

After migration, run a source sweep. Every serialized privileged type must appear in a `writeControlToMailbox` call, not a bare `writeToMailbox` call. Include `useInboxPoller.ts` permission-response callbacks in the sweep; their current fire-and-forget calls must observe failed delivery.

- [ ] **Step 7: Enforce the full structured-message authority matrix at send time**

In both `validateInput` and `call`, authorize every user-exposed structured variant:

- `shutdown_request`: sender is the fresh team lead and target is a fresh rostered teammate;
- `shutdown_response`: sender is the fresh rostered teammate identified by the process environment and target is `team-lead`;
- `plan_approval_response`: sender is the fresh team lead and target is a fresh rostered teammate.

The call-time versioned snapshot is authoritative because validation may precede permission waits. The team lock is released before `writeControlToMailbox`; the envelope binds the exact recipient allocation so removal or replacement cannot retarget it.

Failures name the violated rule; for example:

```ts
{
  success: false,
  message: 'Only the team lead can request teammate shutdown.',
}
```

- [ ] **Step 8: Refactor in-process control consumption**

Acquire a versioned snapshot, resolve sender/receiver principals, then replace `isShutdownRequest(m.text)` with `classifyMailboxMessage`. Only a valid leader control addressed to the current teammate allocation may return `type: 'shutdown_request'`. Acknowledge invalid or mismatched controls by exact ID, log without payload secrets, and continue polling.

Tests must prove peer structured requests, forged plain JSON, and inner/envelope mismatches do not return shutdown.

- [ ] **Step 9: Refactor `useInboxPoller` through a pure classifier lane**

Extract a pure function used by the hook so `useInboxPoller.test.ts` can test dispatch without rendering React. The asynchronous poller reads a versioned snapshot, resolves principals, and feeds only validated controls to permission, plan, mode, shutdown, pane-kill, and roster-mutation branches. It acknowledges only the exact IDs successfully handled; failed handlers leave their messages unread for retry.

For shutdown approval, use the envelope sender's roster identity when choosing the member to terminate or remove. Do not trust `control.from` independently.

- [ ] **Step 10: Make acknowledgement success a prerequisite for shutdown**

In `handleShutdownApproval`, require the matching outstanding shutdown request and await `writeControlToMailbox` before aborting an in-process controller or scheduling process shutdown. On failure, return `success: false`, keep the teammate alive, and preserve the request for retry. A `{ written: true, warning }` result means the response exists in the mailbox: log/surface the warning but do not retry or block shutdown.

Test:

```ts
expect(result.data.success).toBe(false)
expect(task.abortController.signal.aborted).toBe(false)
```

Apply the same written-result and request-correlation rules to shutdown rejection, plan approval/rejection, permission responses, and sandbox responses. Add duplicate, unsolicited, wrong-recipient, wrong-incarnation, and stale-request tests.

- [ ] **Step 11: Run focused control-plane tests**

```bash
cd /Users/pt/cat-code && bun test src/utils/teammateMailbox.test.ts src/utils/attachments.test.ts src/utils/swarm/inProcessRunner.test.ts src/hooks/useInboxPoller.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 12: Commit the control-plane slice if commits are authorized**

```bash
cd /Users/pt/cat-code && git add src/utils/teammateMailbox.ts src/utils/teammateMailbox.test.ts src/utils/attachments.ts src/utils/attachments.test.ts src/hooks/useInboxPoller.ts src/hooks/useInboxPoller.test.ts src/utils/swarm/inProcessRunner.ts src/utils/swarm/inProcessRunner.test.ts src/tools/SendMessageTool/SendMessageTool.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/utils/swarm/permissionSync.ts src/tools/TaskUpdateTool/TaskUpdateTool.ts src/utils/directMemberMessage.ts src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts src/components/teams/TeamsDialog.tsx && git commit -m "fix(agents): authenticate teammate control messages"
```

---

### Task 4: Fresh state and single resume lifecycle ownership

**Files:**
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:201-239`
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts:851-889`
- Modify: `src/tools/SendMessageTool/SendMessageTool.test.ts`
- Modify: `src/tools/ResumeAgentTool/ResumeAgentTool.tsx:115-181`
- Modify: `src/tools/ResumeAgentTool/ResumeAgentTool.test.ts:591-639`
- Modify: `src/tools/AgentTool/resumeAgent.ts:77-100,101-149,264-371`
- Modify: `src/tools/AgentTool/resumeAgent.test.ts`
- Modify: `src/screens/REPL.tsx:3988-4016`

**Interfaces:**
- Produces:

```ts
export function queuePendingMessageIfRunning(
  taskId: string,
  message: string,
  setAppState: SetAppState,
): boolean
```

- Consumes the synchronous store contract at `src/state/store.ts:20-27`: `setState` executes its updater before returning. The boolean result must not be used with an asynchronous React state setter.
- Internal resume ownership remains private to `resumeAgent.ts`; no public tool schema changes.

- [ ] **Step 1: Write atomic queue tests**

Add:

```ts
let appState = {
  tasks: {
    running: {
      id: 'running',
      type: 'local_agent',
      status: 'running',
      agentId: 'running',
      agentType: 'general-purpose',
      pendingMessages: [],
    },
    stopped: {
      id: 'stopped',
      type: 'local_agent',
      status: 'completed',
      agentId: 'stopped',
      agentType: 'general-purpose',
      pendingMessages: [],
    },
  },
} as unknown as AppState
const setAppState: SetAppState = updater => {
  appState = updater(appState)
}
const runningId = 'running'
const stoppedId = 'stopped'

expect(queuePendingMessageIfRunning(runningId, 'follow-up', setAppState)).toBe(true)
expect(appState.tasks[runningId].pendingMessages).toEqual(['follow-up'])
expect(queuePendingMessageIfRunning(stoppedId, 'late', setAppState)).toBe(false)
expect(appState.tasks[stoppedId].pendingMessages).toEqual([])
```

- [ ] **Step 2: Implement atomic queue-if-running**

Set a local `queued` flag only inside the synchronous AppState-store updater after confirming the current task is a non-main `local_agent` with `status === 'running'`. Return the flag. Add a comment citing the synchronous `createStore.setState` invariant. Keep `queuePendingMessage` only for internal callers that intentionally do not require status, or migrate all ordinary steering callers to the new function.

- [ ] **Step 3: Re-read state after target resolution**

In `SendMessageTool`, use the initial state only for `resolveAgentTarget`. Call `context.getAppState()` again before routing. Use `queuePendingMessageIfRunning`; if it returns false, re-read once and return `ResumeAgent` guidance for a stopped task or queue to the newly running replacement.

In `ResumeAgentTool`, re-read state after resolution and reject a target that became running.

- [ ] **Step 4: Write a delayed-resolution race test**

Use a deferred metadata read so call B captures stopped state, call A resumes and registers running state, then release B. Assert B returns already-running guidance and `runAsyncAgentLifecycle` was called once.

- [ ] **Step 5: Hold resume ownership until lifecycle settlement**

Replace the setup-scoped `Set` lifecycle with explicit transfer:

```ts
const activeResumeLifecycles = new Set<string>()

export async function resumeAgentBackground(args: ResumeAgentBackgroundArgs) {
  if (activeResumeLifecycles.has(args.agentId)) {
    throw new AgentResumeInProgressError(args.agentId)
  }
  activeResumeLifecycles.add(args.agentId)
  let ownershipTransferred = false
  try {
    return await resumeAgentBackgroundLocked(args, lifecycle => {
      ownershipTransferred = true
      const release = () => {
        activeResumeLifecycles.delete(args.agentId)
      }
      void lifecycle.then(release, release)
    })
  } finally {
    if (!ownershipTransferred) activeResumeLifecycles.delete(args.agentId)
  }
}
```

`resumeAgentBackgroundLocked` must capture the `runWithAgentContext(...runAsyncAgentLifecycle(...))` promise and pass it to the transfer callback before returning the scheduling result.

- [ ] **Step 6: Add the authoritative fresh task check inside the primitive**

After transcript, metadata, and worktree I/O—but before `appendSubagentSpawned`, `registerActiveSubagent`, task registration, or detached execution—fresh-read root state. Reject a currently running local task with `AgentResumeInProgressError`.

This check supplements the lifecycle owner set; it does not replace it.

- [ ] **Step 7: Update viewed-local-worker input routing**

In `REPL.tsx`, replace the captured `task.status` decision with `queuePendingMessageIfRunning`. If queueing fails, call `resumeAgentBackground`; rely on the primitive for final ownership. Continue routing teammates through `injectUserMessageToTeammate`.

- [ ] **Step 8: Add lifecycle-settlement tests**

Use the existing `runAsyncAgentLifecycle` spy in `resumeAgent.test.ts` with a complete resume-call closure:

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const lifecycle = deferred<void>()
runAsyncAgentLifecycle.mockImplementation(
  mock(() => lifecycle.promise) as never,
)
const resume = () =>
  resumeAgentBackground({
    agentId: 'agent-resume',
    prompt: 'continue',
    canUseTool: (() => undefined) as never,
    toolUseContext: createToolUseContext(),
  })

await expect(resume()).resolves.toMatchObject({ agentId: 'agent-resume' })
await expect(resume()).rejects.toBeInstanceOf(AgentResumeInProgressError)
lifecycle.resolve()
await lifecycle.promise
await expect(resume()).resolves.toMatchObject({ agentId: 'agent-resume' })
```

Add setup-failure coverage proving ownership releases without a lifecycle. Add a second lifecycle test that rejects the deferred promise, installs a temporary `unhandledRejection` listener, and proves ownership releases without emitting an unhandled rejection from the ownership cleanup chain.

- [ ] **Step 9: Run focused local lifecycle tests**

```bash
cd /Users/pt/cat-code && bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts src/tools/AgentTool/resumeAgent.test.ts src/tools/ResumeAgentTool/ResumeAgentTool.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 10: Commit the lifecycle slice if commits are authorized**

```bash
cd /Users/pt/cat-code && git add src/tasks/LocalAgentTask/LocalAgentTask.tsx src/tasks/LocalAgentTask/LocalAgentTask.test.ts src/tools/SendMessageTool/SendMessageTool.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/ResumeAgentTool/ResumeAgentTool.tsx src/tools/ResumeAgentTool/ResumeAgentTool.test.ts src/tools/AgentTool/resumeAgent.ts src/tools/AgentTool/resumeAgent.test.ts src/screens/REPL.tsx && git commit -m "fix(agents): enforce single resume lifecycle ownership"
```

---

### Task 5: Capability-derived prompts, schema wording, maps, and final verification

**Files:**
- Modify: `src/tools/AgentTool/agentToolUtils.ts:83-128`
- Modify: `src/tools/AgentTool/agentToolUtils.test.ts`
- Modify: `src/utils/swarm/inProcessRunner.ts:1002-1080`
- Modify: `src/utils/swarm/inProcessRunner.test.ts`
- Modify: `src/tools/AgentTool/prompt.ts:379-414`
- Modify: `src/tools/AgentTool/prompt.test.ts`
- Modify: `src/tools/AgentTool/AgentTool.tsx:355-364,417-476,1913-2014`
- Modify: `src/tools/AgentTool/AgentTool.test.ts`
- Modify: `src/tools/SendMessageTool/prompt.ts:8-77`
- Modify: `docs/maps/agent-mode.md`
- Modify: `docs/maps/tasks-workers.md`
- Modify: `docs/maps/tools-permissions.md`

**Interfaces:**
- Produces internal capability data:

```ts
export type AgentContinuationCapabilities = {
  canSendMessage: boolean
  canResumeAgent: boolean
  canSpawnAgent: boolean
}

export function getAgentContinuationCapabilities(
  tools: readonly Tool[],
): AgentContinuationCapabilities

export type AgentContinuationMetadata = {
  continuationCapabilities?: AgentContinuationCapabilities
}
```

Synchronous and asynchronous local-agent results intersect `AgentContinuationMetadata`. The field is optional for historical results; missing capabilities render conservatively with no continuation call literals. This is internal result data, not a new user-authored input, and does not broaden the public tool surface.

- [ ] **Step 1: Write prompt/tool-pool consistency tests**

In `agentToolUtils.test.ts`, resolve the external in-process pool explicitly:

```ts
const availableTools = getTools(getEmptyToolPermissionContext())
const inProcessTools = resolveAgentTools(
  {
    tools: ['*'],
    disallowedTools: [],
    source: 'built-in',
    permissionMode: 'default',
  },
  availableTools,
  false,
  'in-process-teammate',
).resolvedTools
const inProcessNames = inProcessTools.map(tool => tool.name)
expect(inProcessNames).not.toContain(AGENT_TOOL_NAME)
expect(inProcessNames).not.toContain(RESUME_AGENT_TOOL_NAME)
expect(getAgentContinuationCapabilities(inProcessTools)).toEqual({
  canSendMessage: true,
  canResumeAgent: false,
  canSpawnAgent: false,
})
```

In `prompt.test.ts`, call the extended `getPrompt` with concrete capabilities:

```ts
const withoutResume = await getPrompt(
  getBuiltInAgents(),
  false,
  undefined,
  'openai',
  false,
  {
    canSendMessage: true,
    canResumeAgent: false,
    canSpawnAgent: false,
  },
)
expect(withoutResume).not.toContain('use ResumeAgent')

const topLevel = await getPrompt(
  getBuiltInAgents(),
  false,
  undefined,
  'openai',
  false,
  {
    canSendMessage: true,
    canResumeAgent: true,
    canSpawnAgent: true,
  },
)
expect(topLevel).toContain('use ResumeAgent')
```

Extend the existing normal-async result fixture in `AgentTool.test.ts` with `continuationCapabilities: { canSendMessage: true, canResumeAgent: false, canSpawnAgent: false }`; assert it still contains the running `SendMessage` hint and omits both `ResumeAgent` and `After it completes or is stopped`.

- [ ] **Step 2: Make in-process environment explicit during filtering**

Extend `filterToolsForAgent`/`resolveAgentTools` with an explicit environment parameter:

```ts
type AgentToolEnvironment = 'default' | 'in-process-teammate'
```

Default to `'default'` for existing callers. `inProcessRunner` passes `'in-process-teammate'` directly, so prompt construction and runtime tool filtering cannot disagree because AsyncLocalStorage was not established yet.

Preserve the external policy: both `Agent` and `ResumeAgent` remain unavailable.

- [ ] **Step 3: Build the in-process prompt from resolved tools**

Construct the runtime agent definition without prebuilding the leader prompt. Resolve its actual tools first, call `getSystemPrompt(resolvedTools, ...)`, append the teammate addendum/custom prompt, and pass the same resolved tool list into `runAgent` with exact-tool semantics where required.

The model-facing prompt and API tool definitions must derive from the same array. Expose only a narrow `_forTest.resolveInProcessRuntime` entry returning `{ tools, systemPrompt }`; `inProcessRunner.test.ts` asserts the returned tool names omit `Agent`/`ResumeAgent` and the prompt omits their continuation instructions.

- [ ] **Step 4: Make Agent prompt guidance capability-aware**

Compute `AgentContinuationCapabilities` with `getAgentContinuationCapabilities` from the same resolved tools supplied to `AgentTool.prompt`. Pass it into `getPrompt`. Emit stopped-agent `ResumeAgent` guidance only when `canResumeAgent` is true. When a context can spawn a synchronous nested agent but cannot resume it, state that a completed nested run cannot be resumed from that context.

- [ ] **Step 5: Correct the `name` schema description**

Replace the unconditional description with:

```text
Name for the spawned entity. Outside a team context this is a local subagent alias: use SendMessage while it runs and ResumeAgent after it stops. In a team context this creates a teammate allocation: use SendMessage while it remains rostered; a terminated teammate cannot be resumed or reuse its old identity, so replacement requires a fresh Agent call and a new allocation.
```

- [ ] **Step 6: Carry capabilities into Agent result rendering**

Add optional internal `continuationCapabilities` to synchronous and asynchronous local-agent outputs. Compute it once from the exact resolved tool array used for the invoking prompt and API definitions, then thread that value through invocation and result rendering; do not re-derive it from the unfiltered parent `toolUseContext.options.tools`. Historical results without the field emit no tool-call continuation literal. In `mapToolResultToToolResultBlockParam`, render only calls the invoker can make:

- running local + `canSendMessage` -> SendMessage hint;
- stopped local + `canResumeAgent` -> ResumeAgent hint;
- no resume capability -> no ResumeAgent literal;
- teammate spawn -> existing mailbox wording.

- [ ] **Step 7: Keep SendMessage prompt semantics exact**

Update `SendMessageTool/prompt.ts` to state:

- bare roster names target teammates;
- `@alias` explicitly targets local workers;
- teammates may be active or idle but must still be rostered;
- stopped local workers require `ResumeAgent`;
- terminated teammates require a fresh `Agent` call and a new allocation; the old recipient key is not reused within the team;
- structured lifecycle controls are authority-checked and must not be imitated with plain JSON chat.

- [ ] **Step 8: Run focused prompt tests**

```bash
cd /Users/pt/cat-code && bun test src/tools/AgentTool/AgentTool.test.ts src/tools/AgentTool/agentToolUtils.test.ts src/tools/AgentTool/prompt.test.ts src/utils/swarm/inProcessRunner.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 9: Update current routing maps**

Update:

- `docs/maps/agent-mode.md` with the bare teammate/`@local` rule, local-only resume ownership, canonical collision-free new identities, and focused tests;
- `docs/maps/tasks-workers.md` with atomic queue-if-running, recipient-record states, exact-ID mailbox acknowledgement, protocol versioning, and shutdown acknowledgement behavior;
- `docs/maps/tools-permissions.md` with runtime principals, the closed control union, request correlation, and the envelope authority matrix.

Do not edit the historical PR #10 review report or the May 12 separation plan.

- [ ] **Step 10: Run the integrated focused suite**

```bash
cd /Users/pt/cat-code && bun test src/utils/recipientIdentity.test.ts src/agent-mode/workerNames.test.ts src/tasks/LocalAgentTask/LocalAgentTask.test.ts src/utils/swarm/teamHelpers.test.ts src/tools/AgentTool/AgentTool.test.ts src/tools/AgentTool/agentToolUtils.test.ts src/tools/AgentTool/prompt.test.ts src/tools/AgentTool/resolveAgentTarget.test.ts src/tools/AgentTool/resumeAgent.test.ts src/tools/ResumeAgentTool/ResumeAgentTool.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/SendMessageTool/UI.test.tsx src/tools/shared/spawnMultiAgent.test.ts src/tools/shared/spawnMultiAgent.probe.test.ts src/utils/teammateMailbox.test.ts src/utils/attachments.test.ts src/utils/swarm/inProcessRunner.test.ts src/hooks/useInboxPoller.test.ts src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts
```

Expected: all selected tests pass with zero failures. Record exact pass/fail/assertion counts.

- [ ] **Step 11: Run the engine build gate**

```bash
cd /Users/pt/cat-code && bun run build:dev:full
```

Expected: lint/parse stage completes, `cli-dev` builds, and `./cli-dev --version` prints. Do not substitute `bun run build`.

- [ ] **Step 12: Run exhaustive stale-reference sweeps**

```bash
cd /Users/pt/cat-code && rg -n "sanitizeAgentName|generateUniqueTeammateName|isStructuredProtocolMessage\(m\.text\)|isShutdownRequest\(m\.text\)|queuePendingMessage\(" src docs --glob '*.ts' --glob '*.tsx' --glob '*.md'
```

Classify every hit. Expected end state:

- no teammate spawn path uses `sanitizeAgentName` or `generateUniqueTeammateName`;
- no privileged dispatch parses `m.text` as authority;
- every ordinary steering path uses atomic queue-if-running;
- historical docs may retain old names only when clearly marked historical.

Also sweep:

```bash
cd /Users/pt/cat-code && rg -n "markMessagesAsRead\(|markMessagesAsReadByPredicate\(|writeToMailbox\([^)]*(control|permission_|shutdown_|plan_approval|mode_set|team_permission)|toolUseContext\.options\.tools.*continuationCapabilities" src --glob '*.ts' --glob '*.tsx'
```

Expected: no broad mailbox acknowledgement in poller/attachment paths; every privileged producer uses `writeControlToMailbox`; capability metadata is never derived from the unfiltered parent tool pool. Classify any remaining broad acknowledgement as a non-processing maintenance path or a defect.

- [ ] **Step 13: Verify documentation and working-tree integrity**

```bash
cd /Users/pt/cat-code && git diff --check && git status --short
```

Expected: `git diff --check` is clean. `git status --short` must show only files intentionally changed by this plan plus the user's pre-existing dirty files; do not stage, reset, delete, or rewrite unrelated work.

- [ ] **Step 14: Commit the prompt/docs slice if commits are authorized**

```bash
cd /Users/pt/cat-code && git add src/tools/AgentTool/agentToolUtils.ts src/tools/AgentTool/agentToolUtils.test.ts src/utils/swarm/inProcessRunner.ts src/utils/swarm/inProcessRunner.test.ts src/tools/AgentTool/prompt.ts src/tools/AgentTool/prompt.test.ts src/tools/AgentTool/AgentTool.tsx src/tools/AgentTool/AgentTool.test.ts src/tools/SendMessageTool/prompt.ts docs/maps/agent-mode.md docs/maps/tasks-workers.md docs/maps/tools-permissions.md && git commit -m "fix(agents): align control prompts with runtime capabilities"
```

---

## Acceptance Checklist

- [ ] New teammate names have one canonical lowercase identity across roster, deterministic ID, mailbox, result text, and routing.
- [ ] `*`, `team-lead`, address prefixes, path-like names, lossy punctuation, Windows device names, and names over 64 bytes cannot be allocated.
- [ ] Concurrent same-name teammate spawns produce distinct allocation records with no duplicate lifecycle or lost roster write.
- [ ] A two-process probe proves concurrent local/teammate claims for one team key allow exactly one owner.
- [ ] Concurrent explicit local aliases allow exactly one owner.
- [ ] New local aliases and teammate names cannot collide.
- [ ] Legacy bare-name collisions route to the teammate; `@name` routes to local; ambiguous legacy mailbox keys fail closed.
- [ ] Recipient keys are never reused within a team; terminated allocations remain tombstones until team cleanup.
- [ ] `starting` allocations are never reclaimed from PID death alone, and crash-injection tests leave no duplicate active identity.
- [ ] A nonexistent, starting, stopped, terminated, or removed teammate does not get a newly routed inbox message.
- [ ] Mailbox success means written to the exact recipient allocation; failures propagate to plain, broadcast, plan, permission, and shutdown callers.
- [ ] Every envelope has protocol version, immutable message ID, sender/recipient agent IDs, and sender/recipient allocation IDs.
- [ ] Poller and attachment acknowledgement marks only exact processed message IDs; a concurrent append remains unread.
- [ ] Broadcast reports partial failure and never counts failed recipients as written.
- [ ] Chat, notification, and privileged-control payloads remain distinct; idle and task-assignment behavior does not regress.
- [ ] Mixed or legacy control protocol versions fail with an explicit restart/cleanup requirement.
- [ ] Plain JSON chat cannot trigger privileged control handlers.
- [ ] Peers cannot originate leader-only shutdown, permission, plan, mode, or team-permission controls.
- [ ] Control senders come from runtime-resolved principals, and envelope/inner identities agree field by field.
- [ ] Response controls require one matching outstanding request and reject unsolicited, duplicate, stale, or wrong-incarnation responses.
- [ ] Failed shutdown acknowledgement leaves the teammate alive.
- [ ] SendMessage uses fresh state and queues only to a currently running local task.
- [ ] Resume ownership remains held until the detached lifecycle settles.
- [ ] REPL-versus-tool and delayed-resolution tests launch exactly one resumed lifecycle.
- [ ] External in-process prompt text advertises neither unavailable `Agent` nor unavailable `ResumeAgent`.
- [ ] Agent schema and result trailers distinguish local-subagent and teammate lifecycles and derive capabilities from the exact resolved tool array.
- [ ] Integrated focused tests pass, `bun run build:dev:full` passes, stale-reference sweep is classified, and `git diff --check` is clean.

## Self-Review

- Spec coverage: all validated PR #10 findings plus exact acknowledgement, runtime principals, non-reused allocation identity, crash-safe fail-closed recovery, protocol versioning, request correlation, and resolved-tool capabilities map to Tasks 1–5.
- Placeholder scan: every implementation task names concrete files, interfaces, test cases, commands, and expected outcomes.
- Type consistency: recipient records, principals, versioned envelopes, exact acknowledgement, control payloads, pending requests, broadcast failure, continuation capability, and atomic queue signatures are defined once and consumed by later tasks with the same names.
- Scope check: the five tasks are independently reviewable but share one control-plane invariant, so one ordered plan is preferable to separate plans that could leave routing or authority half-migrated.
