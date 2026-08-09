# S02 — teammate mailbox and messaging

## Verdict

The +1216 lines added to `teammateMailbox.ts` on this branch are almost entirely a
new **authority layer** (version-2 envelopes, a direction matrix, a closed control
union, a `pendingControls` request/response state machine, a single classifier), and
that layer is genuinely good: it is pure, tested against real forgery scenarios, and
it fails closed. What was *not* touched is the **storage layer underneath it**, and
that layer has the same defect this repo already confirmed twice elsewhere: every
mailbox mutation is a lock + `readFile` + `writeFile` truncate-in-place, with no
temp+rename. A crash or a full disk mid-write leaves a truncated JSON array that
makes the mailbox return `[]` to every reader forever and throw on every future
write, and nothing in the repo can repair it (`clearMailbox` has zero call sites).
The single most important fix is to make the mailbox write atomic (write
`${inboxPath}.tmp`, then `rename`), exactly as `src/services/api/codexAccountPool.ts:761`
already does. The second is that acknowledgement is fire-and-forget (`void
markMessagesAsReadByPredicate`) against a 1 Hz interval with no in-flight guard, so
messages are re-delivered to the model whenever the ack loses a race with the next
tick.

**What serializes writers:** `proper-lockfile` on `${inboxPath}.lock` (`LOCK_OPTIONS`,
`teammateMailbox.ts:45`) for every mutating path, and `transactTeamFile` /
`readTeamSnapshot` on `${teamConfig}.lock` for `pendingControls`. **Readers take no
lock at all** — `readMailbox`, `readUnreadMessages`, and `getMailboxSignature` read
the live file while a writer may be mid-truncate. That is survivable only because
`readMailbox` degrades a parse failure to `[]`.

## Findings

### [HIGH] Mailbox writes are truncate-then-write, not temp+rename — one crash bricks the mailbox permanently
- **Where**: `src/utils/teammateMailbox.ts:593` (envelope write), also `:306`, `:1099`, `:1168`, `:1241`, `:2379`
- **Type**: correctness
- **What**: Every mailbox mutation serializes the whole array and `writeFile`s it over
  the live path. `writeFile` opens with `O_TRUNC`, so the file is empty-or-partial for
  the duration of the write, and any interruption leaves that partial state on disk.
- **Trigger / why it matters**: Kill an agent process (SIGKILL, OOM, laptop power loss,
  ENOSPC) while it is inside `writeFile` at `:593`. The file is now invalid JSON, and
  there is no recovery:
  - `readMailbox` (`:167`) `safeParse`s, fails, and returns `[]` — the recipient's
    entire inbox silently reads as empty forever, logged only at
    `logForDebugging(..., {level:'warn'})`.
  - `readMailboxStrict` (`:505`) throws `MailboxWriteError(…, 'read')`, so **every
    future write to that recipient fails permanently**, including from
    `writeControlToMailbox`.
  - `writeResolvedEnvelopeToMailbox` pre-creates with `flag: 'wx'` (`:547`), so it will
    never overwrite the corrupt file, and `clearMailbox` (`:1270`) — the only reset
    path — has **zero call sites anywhere in the repo**.
  Same defect class as the two already-confirmed HIGHs on this branch
  (`codexTokenRefresh.ts:881`, `claudeAccountPool.ts:624`), and the repo already has
  the correct pattern: `src/services/api/codexAccountPool.ts:761-763` writes
  `.${Date.now()}.${pid}.tmp` then `renameSync`.
- **Fix**: In `writeResolvedEnvelopeToMailbox`, `legacyWriteToMailbox`,
  `acknowledgeMailboxMessages`, `markMessage(s)AsRead*`: write to
  `${inboxPath}.${process.pid}.tmp` and `rename()` onto `inboxPath` while holding the
  existing lock. Rename is atomic on POSIX, so readers (which hold no lock) see either
  the old or the new array and never a partial one.

### [HIGH] Acknowledgement is fire-and-forget against an unguarded 1 Hz interval — messages are delivered to the model twice
- **Where**: `src/hooks/useInboxPoller.ts:444-451` (`markRead`), called at `:1057` and `:1118`; interval at `:1211`
- **Type**: correctness
- **What**: `markRead()` calls `void markMessagesAsReadByPredicate(...)` and returns
  immediately. `useInterval` (usehooks-ts) fires `poll()` every 1000 ms with no
  in-flight guard, and `readMailboxIfChanged` deliberately returns
  `signature: undefined` whenever any unread message exists
  (`teammateMailbox.ts:229`), so the next tick always performs a full re-read.
- **Trigger / why it matters**: Poll at *t*=0 reads unread message `M`, calls
  `onSubmitTeammateMessage(formatted)` (delivered as a turn), then fires the ack
  without awaiting. The ack must acquire the inbox lock; its retry budget is ~655 ms
  (`LOCK_OPTIONS`: 10 retries, 5→100 ms). If a teammate is concurrently writing to that
  inbox — routine for a team lead, whose inbox every teammate writes to, and for
  `attachments.ts:3808` which acks the same file on every turn — the ack either lands
  after *t*=1000 ms or fails outright (swallowed by `logError` inside
  `markMessagesAsReadByPredicate`, `teammateMailbox.ts:2385`). Poll at *t*=1000 ms then
  re-reads `M` as unread and submits or queues it **again**. Nothing downstream dedups:
  `queueMessages` (`useInboxPoller.ts:1073`) has no dedup, and the `from|timestamp|text`
  dedup in `attachments.ts:3739` only reconciles the file against `AppState.inbox`
  within a single attachment build, not across turns. The result is the same teammate
  message injected into the model's context two or more times. Finding [MED] on
  unbounded mailbox growth makes this worse: once the file is large, the ack's
  read+stringify+write alone exceeds the poll interval with no contention at all.
- **Fix**: Keep an `isPollingRef` (or a chained promise) so a poll cannot start while
  one is in flight, and `await markRead()` before the poll resolves.

### [MED] A permission request the leader cannot render is acknowledged and dropped, and the worker then blocks forever
- **Where**: `src/hooks/useInboxPoller.ts:466` (`trackForAck`) vs `:474-478` and `:548-552`
- **Type**: correctness
- **What**: `trackForAck(m)` runs *before* the two paths that discard the request:
  `findToolByName(getAllBaseTools(), parsed.tool_name)` returning undefined, and
  `getLeaderToolUseConfirmQueue()` being unregistered. Both `continue`/log and the
  message is still marked read, so no retry is possible.
- **Trigger / why it matters**: `getAllBaseTools()` (`src/tools.ts:217`) is the static
  built-in list; MCP tools live separately in `appState.mcp.tools` and are joined only
  by `getMergedTools` (`src/tools.ts:423`). A tmux teammate that requests permission for
  any `mcp__server__tool` therefore hits `findToolByName` → undefined → the request is
  acked and dropped. On the worker side there is **no timeout**: `swarmWorkerHandler.ts:67-147`
  awaits a promise that is only settled by `processMailboxPermissionResponse` or by the
  abort signal, and `pendingCallbacks` (`useSwarmPermissionPoller.ts:76`) is a plain
  module-level `Map` with no expiry. The worker hangs on that tool call until a human
  interrupts it. (Secondary: the abort path never calls
  `unregisterPermissionCallback`, so the map leaks one entry per cancelled request.)
- **Fix**: Move `trackForAck(m)` after both guards, and on the unrenderable-tool /
  no-queue branches send an explicit `permission_response` with
  `subtype: 'error'` back to the worker so it fails fast instead of hanging.

### [MED] An unacknowledgeable message pins the poller into a permanent 1 Hz full-read plus team-file-lock loop
- **Where**: `src/hooks/useInboxPoller.ts:202-206` vs `src/utils/attachments.ts:3655-3663`
- **Type**: correctness
- **What**: The two consumers of the *same* no-snapshot fallback rule disagree on
  acknowledgement. The poller does `if (isStructuredProtocolMessage(m.text)) continue`
  — dropped, never tracked, never acked, no log. `attachments.ts` runs the identical
  rule but always does `consumedKeys.add(messageKey(m))`.
- **Trigger / why it matters**: `readTeamSnapshot`/`resolveCurrentTeamPrincipal`
  (`useInboxPoller.ts:346`) throw for a legacy (pre-version-2) team file
  (`TeamProtocolVersionError`) or when this agent's own roster record was removed or
  tombstoned (`TeamPrincipalResolutionError`, `teammateMailbox.ts:452`). Both are
  caught into `controlSnapshot = null`. Any control-shaped message in that inbox is
  then dropped without ack and stays unread forever. Because
  `readMailboxIfChanged` nulls the signature while any unread exists
  (`teammateMailbox.ts:229`), the poller then does, **every second, for the life of the
  process**: full `readFile` + `JSON.parse` + zod validation of the whole mailbox, plus
  a `readTeamSnapshot` that takes the team-file lock and immediately throws. Multiply by
  every agent process in the team, all contending on the same `config.json.lock`. This
  is the same class of regression as the mailbox-polling energy bug this project already
  fixed; the stat-signature fast path itself is intact and unchanged from `main`, but
  this branch added the per-poll team-file lock behind it.
  Measured cost: **idle mailbox = 1 `stat()`/s per session, zero reads** (correct);
  **any unread present = 1 `stat` + 1 full read + 1 team-file lock/read/`structuredClone`
  per second**, plus two more lock+read+**write** transactions per control response
  (`claimPendingControl` + `finishPendingControl`).
- **Fix**: In the `!classified` fallback, acknowledge the dropped message the way
  `attachments.ts` does (add its key to `consumedKeys`), and log the drop.

### [MED] Nothing prunes the mailbox files or `pendingControls` — both are append-only for the life of a team
- **Where**: `src/utils/teammateMailbox.ts:595` (append), `:1012-1027` (`finishPendingControl`)
- **Type**: correctness
- **What**: Messages are only ever appended and flipped `read: true`; they are never
  removed. `PendingControlRecord`s transition to `consumed` and stay in the array —
  `removePendingControl` (`:942`) is called only on the write-failure path. `clearMailbox`
  is dead code, so no bound exists at all.
- **Trigger / why it matters**: Growth is O(messages) in the file and O(requests) in
  `config.json`, and every single write re-serializes the whole array, making total
  write cost O(n²). A long-running team lead receiving idle notifications and chat from
  several teammates accumulates a multi-megabyte inbox; each poll that finds an unread
  message then reads and zod-validates all of it, and each ack rewrites all of it. That
  directly feeds the duplicate-delivery window in the HIGH above. `readTeamSnapshot`
  additionally `structuredClone`s the entire (growing) team file on every call.
- **Fix**: On acknowledgement, drop read messages older than a retention window (or cap
  at N); in `finishPendingControl`, delete the record on `consumed` instead of marking
  it — nothing reads a consumed record except to reject it, and `claimPendingControl`
  already treats "absent" and "consumed" identically.

### [MED] The mailbox lock can be stolen after 10 s and the loser's write silently wins, losing a message
- **Where**: `src/utils/teammateMailbox.ts:45-51` (`LOCK_OPTIONS`)
- **Type**: correctness
- **What**: `LOCK_OPTIONS` sets only `retries`. It does not set `stale` or
  `onCompromised`, so `proper-lockfile`'s defaults apply:
  `stale: 10000`, `onCompromised: (err) => { throw err }`
  (`node_modules/proper-lockfile/lib/lockfile.js:208,213`). Contrast the team lock,
  which explicitly sets `stale: 60_000` (`teamHelpers.ts:305`).
- **Trigger / why it matters**: The lock holder refreshes the lockfile mtime on a
  `setTimeout` that is `unref`'d and cannot fire while its event loop is blocked. If a
  holder stalls >10 s (laptop sleep/resume, a long synchronous serialization of a large
  mailbox per the finding above, heavy CPU contention across many agent processes), an
  arriving writer sees the lock as stale, removes it, and acquires it. Both processes
  now do read-modify-write; whichever `writeFile`s last **silently discards the other's
  message**. The compromised holder's `onCompromised` throw lands in the global
  `uncaughtException` handler (`src/utils/gracefulShutdown.ts:316`), which only records
  an analytics event — nobody is told a message was lost.
- **Fix**: Pass `stale: 60_000` and an explicit `onCompromised` that logs the recipient
  and file path, and (with the atomic-rename fix above) treat compromise as a signal to
  re-read and retry rather than complete the write.

### [LOW] The control-type union is enumerated in seven places; only the `switch`es are compile-time checked, and one is already stale
- **Where**: `src/utils/teammateMailbox.ts:2138` (`isStructuredProtocolMessage`), `:2168`
  (`CONTROL_TYPE_LITERALS`), `:670`/`:678` (direction sets), `:774` (`RESPONSE_CONTROL_TYPES`),
  `:732`/`:751` (switches), `src/hooks/useInboxPoller.ts:231` (dispatch switch)
- **Type**: design
- **What**: Adding a member to `MailboxControlPayloadSchema` is checked by tsc only in
  the `switch` statements; the five `Set`/literal lists compile fine when incomplete.
  The comment at `:2165` documents that `isStructuredProtocolMessage` is **already
  missing** `shutdown_rejected` and leaves it that way.
- **Trigger / why it matters**: `isStructuredProtocolMessage` is the fallback exclusion
  used whenever no version-2 snapshot is available (`useInboxPoller.ts:203`,
  `attachments.ts:3658`). Because `shutdown_rejected` is absent from it, on a legacy
  team a `shutdown_rejected` control JSON is delivered to the model as raw chat text
  while every one of its ten siblings is excluded — an inconsistency that will repeat
  for the next control type someone adds.
- **Fix**: Derive `isStructuredProtocolMessage`'s check from `CONTROL_TYPE_LITERALS`
  (one list), and build the direction sets so that a `never`-assignment tripwire fires
  when a union member appears in neither.

### [LOW] Dead exports in `teammateMailbox.ts`
- **Where**: `src/utils/teammateMailbox.ts:1270` (`clearMailbox`), `:1200` (`markMessagesAsRead`), `:1485` (`isPermissionRequest`), `:1594` (`isSandboxPermissionRequest`), `:2026` (`isTeamPermissionUpdate`), `:2073` (`isModeSetRequest`)
- **Type**: dead-code
- **What**: `clearMailbox` has zero references in the entire repo including tests.
  `markMessagesAsRead` is referenced only from `teammateMailbox.test.ts:70` — this
  branch replaced its last production call site (`useInboxPoller.ts`, was
  `markMessagesAsRead(agentName, teamName)` on `main`) with the predicate variant, and
  the function was left behind. The four `is*` predicates have no call sites outside
  their own module and are superseded by `classifyMailboxMessage`.
- **Trigger / why it matters**: The cost is concrete for `clearMailbox`: it is the only
  code that could repair the corrupt-mailbox state in the HIGH finding, and being
  unreferenced it is neither reachable nor obviously intended to be. The four
  predicates are a live invitation to bypass the new authority classifier — they parse
  a control payload from raw text with no sender check at all.
- **Fix**: Delete the four predicates and `markMessagesAsRead`; either wire
  `clearMailbox` into a repair path or delete it too.

### [LOW] The positional `writeToMailbox` overload's third argument is easy to pass wrong, and one call site does
- **Where**: `src/utils/teammateMailbox.ts:1043-1064`; misuse at `src/tools/TaskUpdateTool/TaskUpdateTool.ts:302`
- **Type**: quality
- **What**: The legacy overload is `(recipientName, message, teamName?)` — three
  strings where the third silently selects the directory the mailbox is written into.
  `TaskUpdateTool` passes `taskListId` there. `getTaskListId()`
  (`src/utils/tasks.ts:199`) returns the team name in the common case but returns
  `CLAUDE_CODE_TASK_LIST_ID` or `getSessionId()` otherwise.
- **Trigger / why it matters**: With `CLAUDE_CODE_TASK_LIST_ID` set to anything other
  than the team name, a task-assignment notification is written to
  `teams/<taskListId>/inboxes/<owner>.json`, which no poller ever reads. The message is
  reported as sent and is never delivered.
- **Fix**: At minimum have `TaskUpdateTool` pass the resolved team name. Better: retire
  the positional overload — the object form already exists and cannot be mis-ordered.

### [LOW] `teammateMailbox.ts` is a god module and `poll()` is a god function
- **Where**: `src/utils/teammateMailbox.ts` (2437 lines); `src/hooks/useInboxPoller.ts:311-1127`
- **Type**: design
- **What**: One module owns file transport, the lock protocol, the version-2 envelope,
  principal resolution, the direction-authority matrix, eleven payload
  factory/predicate pairs, the `pendingControls` state machine, the classifier, and a
  transcript helper that walks `Message[]` (`getLastPeerDmSummary:2402`). `poll()` is a
  ~750-line `useCallback` with nine sequential role-guarded blocks; only
  `classifyInboxMessages` was extracted as a pure function.
- **Trigger / why it matters**: This is why the two HIGHs above are hard to see:
  `trackForAck` is called at nine different points inside `poll()` with different
  ordering relative to the code that can `continue`, and whether a message is ever
  acknowledged depends on which of those nine branches it reaches. The
  `classifyInboxMessages` extraction is exactly the right move — the finding is that it
  stopped at one of nine.
- **Fix**: Extract each role-guarded block into a `handleX(dispatch, deps): string[]`
  returning the message keys it consumed, so acknowledgement is one join at the end
  instead of nine scattered calls. Move the payload factories/predicates and
  `getLastPeerDmSummary` out of the transport module.

## What is good here

- **`classifyMailboxMessage` is the right shape**: pure, synchronous, takes an
  already-fetched snapshot, returns a closed discriminated union with
  `invalid_control`/`protocol_mismatch` as *terminal* states that callers are documented
  never to downgrade to `chat`. It is genuinely testable and genuinely tested — the
  suite covers peer-to-peer forgery, inner-payload/envelope mismatch, stale allocation
  IDs, duplicate response replay, and unmarked legacy control payloads.
- **`writeControlToMailbox` takes no caller-supplied sender.** Resolving the sender from
  the running process's own identity against a fresh snapshot, rather than trusting a
  `from` field, is the correct enforcement point and the doc comment at `:816` says so
  precisely.
- **`readMailboxStrict` (`:488`) is the right asymmetry**: the read-for-display path
  degrades a malformed mailbox to `[]`, but the read-before-write path treats it as a
  hard failure so a write can never truncate a mailbox it could not parse. The
  `acknowledgeMailboxMessages` test at `teammateMailbox.test.ts:182` pins exactly that.
- **The `consumedKeys`/`messageKey` acknowledgement discipline** in both
  `useInboxPoller.ts:432` and `attachments.ts:3639` — acking by exact identity so a
  message that arrived *after* classification stays unread — is the correct answer to
  the append-during-read race, and it is better than the `markMessagesAsRead`-everything
  approach it replaced.
- **`escapeXmlText`/`escapeXmlAttribute` around the model-facing serialization**
  (`src/contracts/orchestration.ts:240`) means a hostile teammate cannot forge a
  `</teammate_message>` boundary or inject an attribute. Message text still reaches the
  model as content, but it is contained and attributed, which is the right bar.

## Not reviewed / uncertain

- **Whether the poller's team-file lock actually causes measurable contention in
  practice.** I established the call frequency by reading the code (1 `readTeamSnapshot`
  per poll per session whenever any unread message exists) but did not run a team to
  measure lock wait times. A 3-teammate team with the leader idle and one stuck
  message would settle it.
- **Whether a `protocol_mismatch` message can be produced by a currently-shipping
  writer.** All eight live `legacyWriteToMailbox` call sites I inspected
  (`spawnMultiAgent.ts:490,714`, `PaneBackendExecutor.ts:184,236`,
  `InProcessBackend.ts:171`, `inProcessRunner.ts:585`, `teammateInit.ts:113`,
  `TaskUpdateTool.ts:292`) write chat or notifications, never control shapes — so the
  producer would have to be an older binary still running in a tmux pane. That is
  plausible in this repo but I could not confirm it happens. It matters because
  `classifyInboxMessages` only pushes to `acknowledgeOnlyIds` when `m.messageId` exists
  (`useInboxPoller.ts:211`), and legacy writers never stamp one — so such a message is
  permanently unackable, which is the sharpest instance of the [MED] pin-the-poller
  finding.
- **`src/utils/swarm/inProcessRunner.ts:860-1000`** is a third independent consumer of
  the same mailbox with its own classification and `markMessageAsReadByIndex` calls. I
  read enough of it to confirm it shares the classifier, but did not audit its
  acknowledgement ordering for the same off-by-one-branch problems found in `poll()`.
  It was outside the stated scope.
- **`docs/maps/tasks-workers.md:89` states that broad
  `markMessagesAsRead()`/`markMessagesAsReadByPredicate()` acknowledgement in the
  poller/attachment hot paths "is the thing to search for and remove if you find it
  reintroduced."** Both hot paths still call `markMessagesAsReadByPredicate`
  (`useInboxPoller.ts:446`, `attachments.ts:3808`). I judged this *not* a defect
  because both pass an exact-identity predicate over `consumedKeys`, which satisfies
  the stated intent — but the doc reads as a prohibition on the function name, so the
  doc and the code should be reconciled one way or the other.
