# S02 adversarial validation: teammate mailbox and messaging

> **Verification provenance:** Claude Opus 5, high effort. Source review plus
> four standalone scratch repros that import the real repo modules
> (`teammateMailbox.ts`, `lockfile.ts`) against a temp `CLAUDE_CONFIG_DIR`, and
> one focused test file (`bun test src/utils/teammateMailbox.test.ts` — 34 pass /
> 0 fail). No GUI, no desktop app, no full suite, no repo file edited other than
> this report. Branch `migration` at `a17e5e9`.

## Overall verdict

The original report is substantially right about *what is broken* and
substantially wrong about *why it is broken and how bad it is*. Both HIGHs
survive as real defects, but neither survives as written: the mailbox is **not**
permanently bricked by a crash (a scratch repro proves the legacy write path
self-heals it), and the duplicate-delivery race is **not** triggered by routine
concurrent writes or large mailboxes (measured: an uncontended ack is 1–4 ms,
and even a 14 MiB / 20,000-message mailbox acks in 40 ms — 25x under the 1000 ms
tick). The real trigger for the ack race is a *crashed or stalled lock holder*,
and when it fires the consequence is far worse than "twice": I reproduced **11
deliveries of the same message in 14 seconds**. The two HIGHs are also the same
incident — F1's crash is F2's trigger — which the report never connects. Six
findings are confirmed outright, three are narrower or mis-triggered than
claimed, one is overstated. The single thing most deserving action is F2 plus
the `stale`/`onCompromised` half of F6, not the atomic-write fix the report
leads with.

Two claims I was asked to spot-check independently: the praise of the v2
authority layer **holds** — all eight forgery scenarios I constructed fail
closed, with two positive controls proving the classifier is not simply
rejecting everything. The `git blame` claim **partly fails**: the non-atomic
storage pattern is pre-existing on `main`, but this branch added two brand-new
non-atomic write sites rather than leaving the layer untouched.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Truncate-then-write bricks the mailbox permanently | **OVERSTATED** | Repro: `legacyWriteToMailbox` self-heals a corrupt mailbox on the next write; 9 production call sites do this routinely |
| F2 | HIGH | Fire-and-forget ack causes double delivery | **PARTIALLY CONFIRMED** | Mechanism real and worse (11x, not 2x), but the report's trigger is measurably wrong |
| F3 | MED | Unrenderable permission request acked and dropped, worker hangs | **CONFIRMED** | `trackForAck` at `:466` precedes both discard branches; worker promise has no timeout |
| F4 | MED | Unacknowledgeable message pins the poller at 1 Hz | **CONFIRMED** | Divergence real; found a sharper trigger than the report's (terminated-sender tombstone) |
| F5 | MED | Nothing prunes mailboxes or `pendingControls` | **PARTIALLY CONFIRMED** | Growth real; the "feeds the duplicate-delivery window" linkage is refuted by measurement |
| F6 | MED | Lock stolen after 10 s, loser's write silently wins | **CONFIRMED** | Defaults verified in `proper-lockfile`; steal observed at t≈10 s in repro |
| F7 | LOW | Control union in seven places, one already stale | **PARTIALLY CONFIRMED** | Staleness real; the stated legacy-team trigger is unreachable, a different route is |
| F8 | LOW | Dead exports | **CONFIRMED** | All six verified at zero production call sites; one supporting rationale refuted |
| F9 | LOW | Positional `writeToMailbox` third arg misused | **CONFIRMED** | `TaskUpdateTool.ts:302` passes `taskListId` as `teamName` |
| F10 | LOW | God module / god function | **CONFIRMED** | 2,436 lines; `trackForAck` at 10 sites, not the nine claimed |

**Tally: CONFIRMED 6 / PARTIALLY CONFIRMED 3 / OVERSTATED 1 / INVALID 0 / DUPLICATE 0 / UNPROVEN 0.**

## Per finding

### F1 — [HIGH] Mailbox writes are truncate-then-write, not temp+rename — one crash bricks the mailbox permanently

- **Verdict**: **OVERSTATED**

- **Cited location holds?** Yes, on the mechanism. All six cited sites are
  `writeFile(inboxPath, jsonStringify(...), 'utf-8')` with the default flag
  `'w'` (`O_TRUNC`): `src/utils/teammateMailbox.ts:306` (legacy write), `:593`
  (envelope write), `:1099` (`acknowledgeMailboxMessages`), `:1168`
  (`markMessageAsReadByIndex`), `:1241` (`markMessagesAsRead`), `:2379`
  (`markMessagesAsReadByPredicate`). None uses temp+rename. The contrast with
  `src/services/api/codexAccountPool.ts:761` is fair.

- **Sub-claim (a) — is the write really non-atomic despite the lock?** **Yes,
  and the report identifies the right risk.** `proper-lockfile` serializes
  *writers*; it has no bearing on a process dying between `open(O_TRUNC)` and
  the completion of `write()`. The widest window is actually wider than the
  report says: a crash *immediately after* the truncating open leaves a
  **zero-byte** file, which needs no partial-write timing at all. I confirmed
  both the zero-byte and partial-JSON states degrade exactly as claimed
  (`readMailbox` → `[]`).

- **Sub-claim (b) — is the bricking PERMANENT and unrecoverable?** **No. This is
  the load-bearing error.** A recovery path exists, is not obscure, and runs
  routinely: **`legacyWriteToMailbox` reads with the *lenient* `readMailbox`
  (`:290`), not `readMailboxStrict`.** On a corrupt file that read returns `[]`,
  the function appends the new message and writes `[newMessage]` — overwriting
  the corruption with a valid array. The mailbox is fully functional afterwards.

  The report cited `:306` — the very line that performs the repair — in its own
  list of *broken* write sites without noticing it is also the fix path. It then
  built the "nothing can repair it" conclusion on `clearMailbox` having zero call
  sites, which is true but irrelevant.

  This is not a theoretical escape hatch. Nine production legacy call sites
  cover **both** directions of traffic, so essentially any continued team
  activity heals the file:
  - into teammate inboxes: `spawnMultiAgent.ts:490,714`,
    `PaneBackendExecutor.ts:184,236`, `InProcessBackend.ts:171`,
    `directMemberMessage.ts:70`, `TaskUpdateTool.ts:292`
  - into the **lead's** inbox: `inProcessRunner.ts:585` (every idle
    notification), `teammateInit.ts:113` (idle notification)

- **Reachable in production?** The corruption mechanism, yes — no env gate, no
  feature flag, plain `fs/promises.writeFile` on every mutation path. The
  *permanence* is not reachable at all.

- **Trigger**: SIGKILL/OOM/ENOSPC/power loss inside any cited `writeFile`.
  Produces a zero-byte or partial-JSON inbox. Reads then return `[]`; the
  principal write path (`SendMessageTool` → `writeResolvedEnvelopeToMailbox` →
  `readMailboxStrict`) throws `MailboxWriteError(..., 'read')`. The next legacy
  write to that inbox ends the condition.

- **Counter-arguments considered**:
  - *Does the lock prevent it?* No — checked, and the report is right here.
  - *Does `flag: 'wx'` pre-create block recovery?* It blocks *that* function from
    overwriting, as claimed, but `legacyWriteToMailbox` reaches its own
    unconditional `writeFile` at `:306` regardless, so it is not a barrier.
  - *Is `clearMailbox` itself a viable repair if wired up?* I suspected its
    `flag: 'r+'` would fail to truncate and leave trailing garbage. **I tested
    this and I was wrong** — under Bun, `writeFile(p, '[]', {flag:'r+'})` yields
    exactly `"[]"`. Not a finding; recording it so the negative result is not
    re-derived.
  - *Does `readMailboxStrict` make the principal path permanently dead?* Only
    until a legacy write repairs the file. And its behavior is deliberate and
    correct: it fails loudly rather than silently truncating, which the original
    report itself praises in its "What is good here" section — the two sections
    contradict each other.

- **True consequence**: **Silent, permanent loss of every unread message in that
  inbox** (the repair discards them — verified: prior messages gone, `len=1`
  after repair), plus a window in which `SendMessageTool` reports truthful
  delivery failures. Real data loss, but recoverable state, not a bricked
  mailbox. Severity should drop **HIGH → MED**: the outcome is bounded message
  loss on an already-crashing process, not a dead team.

- **Storage-layer provenance (asked separately)**: The report's claim that the
  broken layer was "not touched" by this branch is **partly wrong**.
  `git blame`: `:306`, `:1168`, `:1241`, `:2379` all date to `^86051a8`
  (2026-04-30, initial snapshot) and exist identically on `main`. But `:593`
  (`writeResolvedEnvelopeToMailbox`) and `:1099` (`acknowledgeMailboxMessages`)
  are `18090c3c` (2026-07-13), which `git merge-base --is-ancestor 18090c3c main`
  reports as **branch-only**. So the branch did not fix the pattern and
  propagated it into two new write paths. It does not *regress* `main`, so it
  should not block the branch — but "untouched" is not accurate.

- **Evidence**: `scratchpad/v22/repro-brick.ts`:
  ```
  [A pre-repair] readMailbox -> [] | readUnread -> len 0     (zero-byte file)
  [B pre-repair] readMailbox -> [] | readUnread -> len 0     (partial JSON)
    acknowledgeMailboxMessages: returned (error swallowed by logError)
    after ack attempt, on-disk unchanged? true
    after markMessagesAsReadByPredicate, on-disk unchanged? true
  --- legacy positional writeToMailbox() against corrupt file ---
  >>> RECOVERED? true
  >>> prior messages lost? true
  >>> mailbox healthy afterwards? len=2 (expect 2)
  ```
  Plus `git blame -L <n>,<n> -- src/utils/teammateMailbox.ts` for each cited line.

- **Disposition**: Apply the atomic write, but **not as the top priority and not
  as the report scoped it**. Two changes, in this order:
  1. **`legacyWriteToMailbox` should use `readMailboxStrict`** (or rename the
     unparseable file aside before overwriting). This is the actual data-loss
     bug and the report missed it entirely by mislabeling the repair path as
     merely broken. Today a *transient* parse failure silently discards every
     unread message; the strict read is already written and already used by the
     two newer paths.
  2. Then temp+rename in all six sites, per the report's fix. Note that once (1)
     lands, a corrupt mailbox genuinely does become unrecoverable — so (1) and
     (2) must ship together with a rename-aside-and-start-fresh branch, or the
     report's "permanent brick" prediction becomes true by our own hand. Do not
     wire up `clearMailbox` for this; a repair path needs to preserve the corrupt
     file for diagnosis, not blank it.

---

### F2 — [HIGH] Acknowledgement is fire-and-forget against an unguarded 1 Hz interval — messages are delivered to the model twice

- **Verdict**: **PARTIALLY CONFIRMED** — mechanism confirmed and the consequence
  is worse than claimed; the report's stated trigger is measurably false.

- **Cited location holds?** Yes. `src/hooks/useInboxPoller.ts:444-451`
  `markRead()` does `void markMessagesAsReadByPredicate(...)` and returns.
  Called at `:1057` (no-regular-messages path) and `:1118` (after delivery).
  `useInterval(() => void poll(), 1000)` at `:1211`, `INBOX_POLL_INTERVAL_MS = 1000`
  at `:121`.

- **Reachable in production?** Yes. No env gate or feature flag.
  `usehooks-ts`'s `useInterval` is a bare `setInterval` invoking a ref to the
  latest callback (`node_modules/usehooks-ts/dist/index.js:87-103`) — **no
  in-flight guard**, confirmed by reading the dependency, not assumed.
  `readMailboxIfChanged` returns `signature: undefined` whenever any unread
  exists (`teammateMailbox.ts:229`), so the stat fast path cannot suppress the
  re-read. Confirmed.

- **Trigger**: The report's trigger is **wrong**, and I refuted both halves of it
  by measurement:
  - *"If a teammate is concurrently writing to that inbox — routine"*: an
    uncontended ack completes in **1.2–3.6 ms**. A single competing write holds
    the lock for a comparable few ms. Reaching the ~655 ms retry budget would
    take on the order of a hundred-plus perfectly back-to-back writers on one
    inbox. Not routine.
  - *"once the file is large, the ack's read+stringify+write alone exceeds the
    poll interval with no contention at all"*: **false**. 1,000 messages =
    2.8 ms; 5,000 = 14.7 ms; **20,000 messages / 14.4 MiB = 40.2 ms**, i.e. 25x
    under the tick. This sub-claim, and the report's dependency of F2 on F5, are
    refuted.

  The **real** trigger is a lock holder that dies or stalls. Measured retry
  budget is ~668 ms, and past it the ack does not merely land late — it **fails
  outright and is never retried**, swallowed by `logError` inside
  `markMessagesAsReadByPredicate` (`:2385`):
  ```
  competitor holds  300 ms -> ack returned after  368.7 ms, landed=true
  competitor holds  700 ms -> ack returned after  668.1 ms, landed=false
  competitor holds 1200 ms -> ack returned after  670.3 ms, landed=false
  competitor holds 3000 ms -> ack returned after  666.7 ms, landed=false
  ```
  A SIGKILLed agent leaves the `proper-lockfile` lock directory on disk with no
  owner, so every ack fails for the **full 10 s `stale` window** (F6).

- **Counter-arguments considered**:
  - *An in-flight guard?* None — verified in the dependency source.
  - *A dedupe on message id downstream?* For chat, no. `queueMessages`
    (`:1073`) has none; the idle-delivery effect (`:1160-1195`) formats and
    submits every `status:'pending'` entry with no dedup. The `from|timestamp|text`
    `seen` set in `attachments.ts:3739` dedups the mailbox file against
    `AppState.inbox` within one attachment build, so it cannot catch a message
    already delivered as a *previous turn's* prompt.
  - *An idempotent read marker?* The only one is `read: true` in the file, which
    is precisely what the failing ack sets.
  - **The report missed a real counter-example that partly narrows it**: the
    permission-request path *does* have an explicit dedup for exactly this race,
    at `useInboxPoller.ts:540-547`, commented `"Deduplicate: if the mark-read ack
    failed on a prior poll, the same message will be re-read — skip if already
    queued."` So the codebase already knows about this failure mode; the gap is
    that only one of the nine dispatch branches is protected. That is a sharper
    framing than "nobody thought about it", and it reinforces F10.

- **True consequence**: **Worse than claimed.** Not "two or more times" — one
  delivery **per tick** for as long as the ack keeps failing. With a crashed lock
  holder that is ~10-11 deliveries before the stale steal lets an ack through;
  with a live-but-stalled holder that keeps refreshing its lockfile mtime, it is
  unbounded. Reproduced end to end:
  ```
  Simulated crashed lock holder: <inbox>.json.lock exists, no owner.
    t=    4 ms  DELIVERED "deploy the thing" (delivery #1)
    t= 1003 ms  DELIVERED "deploy the thing" (delivery #2)
    ...
    t=10018 ms  DELIVERED "deploy the thing" (delivery #11)
  >>> the SAME message was delivered to the model 11 time(s) in 14 s
  ```

- **Evidence**: `scratchpad/v22/repro-ack-timing.ts` and
  `scratchpad/v22/repro-stale-lock.ts` (output above);
  `node_modules/usehooks-ts/dist/index.js:87-103`;
  `src/hooks/useInboxPoller.ts:444-451,540-547,1211`.

- **Disposition**: The report's fix — `isPollingRef` plus `await markRead()` — is
  **necessary but insufficient, and would create false confidence.** Awaiting a
  *failing* ack changes nothing: the poller still re-reads the message as unread
  on the next tick. Apply all three:
  1. In-flight guard on `poll()` (as proposed).
  2. `await markRead()` before the poll resolves (as proposed).
  3. **A session-scoped `Set` of already-delivered `messageKey`s**, consulted
     before delivery, so a failed ack cannot cause re-delivery. This is the only
     part that actually fixes the reproduced behavior, and it generalizes the
     one-off dedup already at `:540-547` to all nine branches.
  Additionally, an ack failure must not be swallowed by `logError` at `:2385` —
  it is the signal that duplicates are about to be sent.

---

### F3 — [MED] A permission request the leader cannot render is acknowledged and dropped, and the worker then blocks forever

- **Verdict**: **CONFIRMED**

- **Cited location holds?** Yes, exactly. `src/hooks/useInboxPoller.ts:466` is
  `trackForAck(m)`, the first statement of the loop body, before both discard
  paths: `findToolByName(getAllBaseTools(), parsed.tool_name)` → `if (!tool) { ...
  continue }` at `:474-478`, and the `else` branch logging
  `"ToolUseConfirmQueue unavailable, dropping permission request"` at `:548-552`.
  Both leave the message in `consumedKeys`, so `markRead` acks it.

- **Reachable in production?** Yes. `getAllBaseTools()` (`src/tools.ts:217`) is
  the static built-in array; MCP tools live in `appState.mcp.tools` and are
  joined only by `getMergedTools` (`src/tools.ts:423`). Verified by reading both.
  So any `mcp__server__tool` name resolves to `undefined`.

- **Trigger**: A tmux/pane teammate requests permission for an MCP tool. The
  leader acks the request and drops it. Worker side: the `await new Promise<PermissionDecision>`
  in `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts` is settled only by
  `registerPermissionCallback`'s `onAllow`/`onReject` or by the
  `abortController.signal` listener — **no timeout**, confirmed by reading the
  whole promise body. `pendingCallbacks` (`src/hooks/useSwarmPermissionPoller.ts:76`)
  is a module-level `Map` with no expiry.

- **Counter-arguments considered**:
  - *Does the `:540-547` dedup rescue it?* No — that dedup sits **inside** the
    `if (setToolUseConfirmQueue)` branch and **after** the `findToolByName`
    guard, so neither discard path reaches it.
  - *Does the abort listener mean it does not truly hang?* It settles the
    promise, but only when the user interrupts or the query is cancelled. The
    report's "hangs until a human interrupts it" is accurate.
  - *Is the callback-leak sub-claim real?* Yes.
    `rg 'unregisterPermissionCallback'` shows it called only at
    `src/utils/swarm/inProcessRunner.ts:464`; `swarmWorkerHandler.ts` imports
    only `registerPermissionCallback` (`:14`), so the abort path leaks one Map
    entry per cancelled request. Confirmed.

- **True consequence**: An MCP-tool permission request from a pane worker is
  acknowledged, dropped with only a debug log, and never retried; the worker
  stalls on that tool call until the operator interrupts. One leaked callback
  entry per aborted request.

- **Evidence**: `src/hooks/useInboxPoller.ts:466,474-478,540-547,548-552`;
  `src/tools.ts:217,423`;
  `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts:60-150`;
  `src/hooks/useSwarmPermissionPoller.ts:76,94`.

- **Uncertainty**: I did not confirm that pane/tmux teammates are in practice
  configured with MCP servers, which is what sets the frequency. The mechanism is
  proven; the rate is not. A pane worker with any MCP server configured would
  settle it in one turn.

- **Disposition**: Report's fix is right — move `trackForAck(m)` below both
  guards and return an explicit `permission_response` with `subtype: 'error'` so
  the worker fails fast. Add `unregisterPermissionCallback(request.id)` to the
  abort listener in `swarmWorkerHandler.ts`. Do **not** switch to
  `getMergedTools` here as a shortcut: the poller has no `ToolPermissionContext`
  or `appState.mcp` at that point, and reaching for one would widen the poller's
  dependencies for a path that should simply fail fast.

---

### F4 — [MED] An unacknowledgeable message pins the poller into a permanent 1 Hz full-read plus team-file-lock loop

- **Verdict**: **CONFIRMED** — and the trigger is more reachable than the report
  argued.

- **Cited location holds?** Yes. `src/hooks/useInboxPoller.ts:202-206`:
  ```
  if (!classified) {
    if (isStructuredProtocolMessage(m.text)) continue
    dispatch.regularMessages.push(m)
    continue
  }
  ```
  No `acknowledgeOnlyIds` push, no log. `src/utils/attachments.ts:3655-3663` runs
  the identical rule but unconditionally does `consumedKeys.add(messageKey(m))`.
  The divergence is exactly as described.

- **Reachable in production?** Yes, and by a route the report did not find. The
  report leaned on legacy team files (`TeamProtocolVersionError`) and admitted in
  its own "Not reviewed" section that it could not confirm a producer of
  control-shaped legacy messages. **A stronger trigger needs neither.**
  `resolveTeamPrincipalByName` (`teammateMailbox.ts:422-432`) filters
  `r.status !== 'terminated'` and returns `null` otherwise; `docs/maps/tasks-workers.md`
  confirms a `terminated` record is a permanent tombstone, never reclaimed. So on
  a perfectly healthy version-2 team: a teammate writes a valid control envelope,
  the teammate is terminated before the leader's poll consumes it, and then
  `senderPrincipal` is `null` → `classified` is `null` →
  `isStructuredProtocolMessage` is true → `continue`, never acked, forever.

- **Trigger**: Terminate a teammate that has an unconsumed control message in the
  leader's inbox. The message is never acked; `readMailboxIfChanged` nulls the
  signature while it stays unread (`teammateMailbox.ts:229`), so every tick
  performs a full read plus a `readTeamSnapshot`.

- **Counter-arguments considered**:
  - *Does the stat fast path save it?* No — it is bypassed precisely because an
    unread message exists. Verified in source.
  - *Does something else eventually ack it?* `attachments.ts` would, on the
    mid-turn path, since it always adds to `consumedKeys`. That narrows the pin
    to a leader that is not taking turns — which is exactly the idle-leader case
    the report describes, so it survives.
  - *Is `readTeamSnapshot` really lock-taking per poll?* Yes:
    `src/utils/swarm/teamHelpers.ts:328-348` acquires the team lock, reads,
    `assertVersion2`, and returns `Object.freeze(structuredClone(teamFile))`,
    releasing in `finally` — so even the throwing path takes and releases the
    lock. Confirmed.

- **True consequence**: As described. Per second, per pinned session: 1 `stat`,
  1 full `readFile` + `JSON.parse` + zod validation, 1 team-file lock
  acquire/read/`structuredClone`/release. Multiplied across agent processes all
  contending on one `config.json.lock`.

- **Evidence**: `src/hooks/useInboxPoller.ts:202-206,346`;
  `src/utils/attachments.ts:3655-3663`; `src/utils/teammateMailbox.ts:229,422-432`;
  `src/utils/swarm/teamHelpers.ts:328-348`.

- **Disposition**: Report's fix is right (ack the dropped message the way
  `attachments.ts` does, and log it). Add: acking here requires a `messageId`,
  and `classifyInboxMessages` only populates `acknowledgeOnlyIds` when
  `m.messageId` exists (`:211`) — legacy writers stamp none. So the fallback must
  ack via the `consumedKeys`/`messageKey` path, not `acknowledgeOnlyIds`, or
  legacy messages stay pinned anyway. The report's own "Not reviewed" section
  spotted this gap but did not carry it into the fix.

---

### F5 — [MED] Nothing prunes the mailbox files or `pendingControls` — both are append-only for the life of a team

- **Verdict**: **PARTIALLY CONFIRMED** — the growth claim is confirmed; the
  performance consequence and the link to F2 are refuted.

- **Cited location holds?** Yes. `finishPendingControl`
  (`src/utils/teammateMailbox.ts:1012-1027`) maps the record to
  `state: 'consumed'` and writes it back; it never removes. `removePendingControl`
  (`:942`) has exactly one caller, `:895`, on the write-failure path — verified
  by `rg`. Messages are only appended and flipped `read: true`. `clearMailbox` is
  dead (F8).

- **Reachable in production?** Yes, trivially — it is the normal steady state.

- **Trigger**: Any long-running team. Growth is O(messages) in each inbox file
  and O(requests) in `config.json`.

- **Counter-arguments considered**:
  - *Is the O(n²) write cost actually harmful?* **No, and this refutes the
    report's stated impact.** Measured full read + zod validate + re-stringify +
    write at 20,000 messages / 14.4 MiB: **40.2 ms**. The asymptotic claim is
    correct but the constant is small enough that it is a disk-space and
    context-size problem, not a latency problem, at any size a real team reaches.
  - *Does it "directly feed the duplicate-delivery window in the HIGH above"?*
    **Refuted.** 40 ms against a 1000 ms tick. F2 does not depend on F5 at all.
  - *Is the proposed `pendingControls` deletion safe?* I checked this rather than
    assuming: `findMatchingPendingControl` (`:793-812`) requires
    `p.state !== 'consumed'`, so a deleted record and a consumed record both
    produce "no match" and both reject a replay identically. The report's
    proposal is safe — I verified it with forgery scenarios 6 and 7 below, which
    both return `invalid_control`.

- **True consequence**: Unbounded disk growth per inbox and unbounded
  `pendingControls` growth in `config.json`, plus a growing volume of read
  messages that `readTeamSnapshot`'s `structuredClone` and the attachment builder
  keep walking. Not a source of delivery latency.

- **Evidence**: `scratchpad/v22/repro-ack-timing.ts` section A;
  `src/utils/teammateMailbox.ts:942,1012-1027,793-812`.

- **Disposition**: Report's fix is sound and I verified the risky half of it
  (deleting consumed records preserves replay rejection). Prioritize it as
  housekeeping, not as a prerequisite for F2 — the report's ordering implies a
  dependency that does not exist.

---

### F6 — [MED] The mailbox lock can be stolen after 10 s and the loser's write silently wins, losing a message

- **Verdict**: **CONFIRMED**

- **Cited location holds?** Yes. `LOCK_OPTIONS`
  (`src/utils/teammateMailbox.ts:44-51`) sets only `retries`. I read the
  dependency rather than trusting the report:
  `node_modules/proper-lockfile/lib/lockfile.js:205-215` defaults
  `stale: 10000` and `onCompromised: (err) => { throw err; }`. The contrast is
  real: `teamLockOptions` (`src/utils/swarm/teamHelpers.ts:300-308`) explicitly
  sets `stale: 60_000`.

- **Reachable in production?** Yes — every mailbox lock in the module uses
  `LOCK_OPTIONS`.

- **Trigger**: A holder stalls or dies for >10 s. I observed the steal directly:
  in `repro-stale-lock.ts` an ownerless lock directory blocked every ack until
  t≈10 s, at which point the stale threshold let a new acquirer take it and the
  ack finally landed (deliveries stop after #11 at t=10018 ms). That is the steal
  firing, on the default `stale`.

- **Counter-arguments considered**:
  - *Does the mtime refresher prevent staleness?* Only while the holder's event
    loop runs. `proper-lockfile` refreshes on a timer, so a SIGKILLed process, a
    blocked loop, or a slept laptop cannot refresh. Confirmed.
  - *Does `onCompromised` surface the loss?* No. It throws into the global
    handler at `src/utils/gracefulShutdown.ts:315-324`, which I read: it calls
    `logForDiagnosticsNoPII` and `logEvent('tengu_uncaught_exception', ...)` and
    nothing else. No user-facing signal, no abort of the in-flight write. The
    report's characterization is accurate.
  - *Is the "silently discards the other's message" outcome real?* Yes — both
    processes are inside read-modify-write, and the last `writeFile` wins
    wholesale because there is no merge.

- **True consequence**: Under a >10 s stall, two writers can both hold the lock;
  the later `writeFile` silently drops whatever the other appended, with no
  user-visible error. Note the double edge: this same steal is what *terminates*
  the F2 duplicate-delivery storm, so raising `stale` without fixing F2 first
  would make F2 strictly worse.

- **Evidence**: `src/utils/teammateMailbox.ts:44-51`;
  `node_modules/proper-lockfile/lib/lockfile.js:205-215`;
  `src/utils/swarm/teamHelpers.ts:300-308`;
  `src/utils/gracefulShutdown.ts:315-324`; `scratchpad/v22/repro-stale-lock.ts`.

- **Disposition**: Report's fix (explicit `stale: 60_000` + a logging
  `onCompromised`) is correct in substance but **must not ship before F2's
  delivered-set guard**, or the duplicate-delivery window widens from ~10 s to
  ~60 s. Sequence: F2 guard first, then this. The report's suggestion to "treat
  compromise as a signal to re-read and retry rather than complete the write" is
  the right end state and pairs naturally with the atomic-rename work in F1.

---

### F7 — [LOW] The control-type union is enumerated in seven places; only the `switch`es are compile-time checked, and one is already stale

- **Verdict**: **PARTIALLY CONFIRMED** — the staleness and the design cost are
  real; the stated trigger is unreachable, though a different one is.

- **Cited location holds?** Yes.
  `isStructuredProtocolMessage` (`src/utils/teammateMailbox.ts:2138-2160`)
  enumerates 10 type literals and omits `shutdown_rejected`;
  `CONTROL_TYPE_LITERALS` (`:2167-2179`) lists all 11; the comment at `:2163-2166`
  documents the omission and deliberately leaves it. The direction sets at
  `:670`/`:678` and `RESPONSE_CONTROL_TYPES` at `:774` are plain `Set`s with no
  exhaustiveness tripwire, exactly as claimed.

- **Reachable in production?** The **stated** trigger is not. The report claims
  "on a legacy team a `shutdown_rejected` control JSON is delivered to the model
  as raw chat text". But `shutdown_rejected` has exactly one producer —
  `src/tools/SendMessageTool/SendMessageTool.ts:777` → `writeControlToMailbox` —
  and `writeControlToMailbox` throws `TeamProtocolVersionError` for a legacy or
  absent team by design. **A legacy team can therefore never contain a
  `shutdown_rejected` message.** That trigger is refuted.

- **Trigger** (the one that does work): the same terminated-sender route as F4.
  A valid v2 `shutdown_rejected` sits unread; its sender is terminated;
  `resolveTeamPrincipalByName` returns `null`; `classified` is `null`;
  `isStructuredProtocolMessage` returns **false** for it alone; it is pushed to
  `regularMessages` and the raw control JSON reaches the model as chat, while all
  ten siblings are excluded. The inconsistency the report describes is real —
  through a different door.

- **Counter-arguments considered**: Whether the omission is harmless because
  `shutdown_rejected` has no dispatch queue (`useInboxPoller.ts:259-263` notes it
  is handled by `SendMessageTool`/`inProcessTeammateHelpers`). It is not
  harmless: the fallback's job is to *exclude* control shapes from model context,
  and this one is not excluded. Also worth noting the divergence is
  self-limiting in one respect — because it lands in `regularMessages` it *is*
  tracked for ack, so unlike its siblings it does not pin the poller.

- **True consequence**: On a v2 team with a terminated sender, one control type
  out of eleven leaks raw JSON into the model's context instead of being
  suppressed. Cosmetic-to-minor, correctly rated LOW.

- **Evidence**: `src/utils/teammateMailbox.ts:2095-2109,2138-2179`;
  `src/tools/SendMessageTool/SendMessageTool.ts:777-790`;
  `src/hooks/useInboxPoller.ts:259-263`.

- **Disposition**: Report's fix is right — derive the check from
  `CONTROL_TYPE_LITERALS` and add a `never`-assignment tripwire so a new union
  member must appear in one of the two direction sets. Cheap, and it is the only
  finding here that prevents a whole class of recurrence.

---

### F8 — [LOW] Dead exports in `teammateMailbox.ts`

- **Verdict**: **CONFIRMED** (one supporting rationale refuted)

- **Cited location holds?** Yes, all six, verified individually with `rg` across
  the repo excluding `node_modules` and sibling worktrees:
  - `clearMailbox` (`:1270`) — **zero** references anywhere, including tests.
  - `markMessagesAsRead` (`:1200`) — only `teammateMailbox.test.ts:29,70`. The
    branch's replacement of the production call site with the predicate variant
    is consistent with `git diff main...HEAD`.
  - `isPermissionRequest` (`:1485`), `isSandboxPermissionRequest` (`:1594`),
    `isTeamPermissionUpdate` (`:2026`), `isModeSetRequest` (`:2073`) — each has
    exactly one hit, its own definition line.

- **Reachable in production?** No — that is the finding.

- **Counter-arguments considered**: Whether the four predicates are re-exported
  through a barrel or referenced dynamically. Checked: no barrel re-export, and
  the `rg` sweep covered `.ts`/`.tsx` repo-wide. Whether `clearMailbox` is used
  by scripts or docs — no hits.

- **Refuted sub-claim**: The report argues "The cost is concrete for
  `clearMailbox`: it is the only code that could repair the corrupt-mailbox state
  in the HIGH finding." **False**, per F1 — `legacyWriteToMailbox` repairs it, and
  does so on every legacy write. The stated cost evaporates; the finding stands
  purely as dead code.

- **True consequence**: Six unused exports. The four `is*` predicates are the
  only real hazard: they parse a control payload from raw text with no sender
  check, so a future call site could bypass `classifyMailboxMessage` entirely —
  that part of the report is a fair reading of the risk.

- **Evidence**: `rg -n '\bclearMailbox\b|\bmarkMessagesAsRead\b|\bisPermissionRequest\b|\bisSandboxPermissionRequest\b|\bisTeamPermissionUpdate\b|\bisModeSetRequest\b'` over the repo.

- **Disposition**: Delete the four predicates — they are an active invitation to
  bypass the authority layer and that is the whole justification. Deleting
  `markMessagesAsRead` requires also updating `teammateMailbox.test.ts:29,70`,
  which the report does not mention. Delete `clearMailbox` too; do **not** wire it
  into a repair path (see F1 disposition — a repair path must preserve the corrupt
  file, and `clearMailbox` blanks it).

---

### F9 — [LOW] The positional `writeToMailbox` overload's third argument is easy to pass wrong, and one call site does

- **Verdict**: **CONFIRMED**

- **Cited location holds?** Yes. The overload is declared at
  `src/utils/teammateMailbox.ts:1043-1064` as
  `(recipientName, message, teamName?)`. `src/tools/TaskUpdateTool/TaskUpdateTool.ts:292-303`
  passes `taskListId` in the `teamName` position.

- **Reachable in production?** Yes, behind `isAgentSwarmsEnabled()` (checked at
  `TaskUpdateTool.ts:284`) and only when `updates.owner` is set.

- **Trigger**: `getTaskListId()` (`src/utils/tasks.ts:199-209`) returns, in
  order: `CLAUDE_CODE_TASK_LIST_ID` if set; the teammate context's team name;
  else `getTeamName() || leaderTeamName || getSessionId()`. So with
  `CLAUDE_CODE_TASK_LIST_ID` set to anything other than the team name — or in a
  standalone session falling through to `getSessionId()` — the notification is
  written to `teams/<taskListId>/inboxes/<owner>.json`, which no poller reads.

- **Counter-arguments considered**: In the common in-team case `getTaskListId()`
  *does* return the team name, so the bug is latent rather than routine — which
  is why LOW is the right severity. I also checked whether the write failure
  would at least be reported: it would not. `legacyWriteToMailbox` swallows
  errors and returns `void`, and here there is no error anyway — the write
  succeeds into the wrong directory. Silent, as claimed.

- **True consequence**: A task-assignment notification is reported as sent and is
  never delivered.

- **Evidence**: `src/utils/teammateMailbox.ts:1043-1064`;
  `src/tools/TaskUpdateTool/TaskUpdateTool.ts:284-303`; `src/utils/tasks.ts:199-209`.

- **Disposition**: Report's fix is right. Prefer the minimal version — have
  `TaskUpdateTool` resolve and pass the team name — over retiring the positional
  overload, which has nine production call sites and would be a much larger change
  than this LOW justifies.

---

### F10 — [LOW] `teammateMailbox.ts` is a god module and `poll()` is a god function

- **Verdict**: **CONFIRMED**

- **Cited location holds?** Substantially. `wc -l` gives **2,436** lines, not the
  2,437 claimed — trivially off by one. `poll()` spans `useInboxPoller.ts:311-1127`
  as stated. The module genuinely owns file transport, lock protocol, v2
  envelope, principal resolution, direction matrix, payload factories/predicates,
  the `pendingControls` state machine, the classifier, and `getLastPeerDmSummary`
  (`:2402`), which walks `Message[]` and has no business in a transport module.

- **Reachable in production?** N/A — design finding.

- **Trigger**: N/A. The report's supporting claim is that `trackForAck` is called
  at "nine different points"; the real count is **10**
  (`useInboxPoller.ts:438,466,582,640,696,741,787,836,890,1035`). The
  understatement makes the argument slightly stronger, not weaker.

- **Counter-arguments considered**: Whether size alone is a finding. It is not,
  and the report does not rest on size — it correctly ties the structure to F3
  (an ack that precedes a `continue` in one of ten branches) and, as I found, to
  F2 (a dedup that exists in one of ten branches and not the other nine). That
  linkage is verified and is the finding's real content.

- **True consequence**: Acknowledgement correctness is a per-branch property
  spread over ten call sites, which is why F2 and F3 are both single-branch
  defects that survived review.

- **Evidence**: `wc -l src/utils/teammateMailbox.ts` → 2436;
  `rg -c 'trackForAck\(' src/hooks/useInboxPoller.ts` → 10.

- **Disposition**: Report's fix — extract each role-guarded block into
  `handleX(dispatch, deps): string[]` returning consumed keys, so acknowledgement
  is one join — is the right shape and should be done **as the vehicle for the F2
  and F3 fixes**, not as a standalone refactor. Moving `getLastPeerDmSummary` and
  the payload factories out is independent and safe. Do not attempt the module
  split and the ack fixes in separate passes; the ack fixes are what justify the
  restructure.

---

## Verification of the report's praise and framing

**The v2 authority layer fails closed — praise upheld.** I constructed eight
forgery scenarios against `classifyMailboxMessage` with schema-valid payloads, so
every rejection is an authority rejection rather than a shape rejection, plus two
positive controls to prove the classifier is not simply rejecting everything
(`scratchpad/v22/repro-forgery2.ts`):

```
PASS  closed  1. peer->peer permission_response (mallory -> bob)
              "permission_response" is not permitted from teammate to teammate
PASS  closed  2. teammate sends LEAD-ONLY shutdown_request to lead
              "shutdown_request" is not permitted from teammate to leader
PASS  closed  3. mallory impersonates bob in permission_request agent_id
              Control payload identity field does not match the resolved sender
PASS  ALLOW   3b. CONTROL: honest permission_request must be ACCEPTED
PASS  closed  4. envelope addressed to bob, classified by lead
              Envelope sender/recipient identity does not match the resolved principals
PASS  closed  5. legacy downgrade (control text, no v2 envelope)
              Control-shaped payload is missing the protocolVersion 2 envelope
PASS  closed  6. replay: response against a CONSUMED pending record
              No outstanding "permission_response" request matches this response
PASS  ALLOW   6b. CONTROL: same response, OPEN record, must be ACCEPTED
PASS  closed  7. response with an unknown/forged requestId
PASS  closed  8. response record belonging to a DIFFERENT teammate
```

All ten behave correctly. `bun test src/utils/teammateMailbox.test.ts` →
**34 pass / 0 fail**. The report's assessment of this layer is accurate and I
found nothing to refute in it.

**The "+1216 lines are new authority code" framing holds.**
`git diff main...HEAD --numstat` gives `1216 / 60`; the same diff with `-w` gives
`1207 / 51`. Only ~9 lines are whitespace-only, so this is not the
re-indentation illusion seen elsewhere in this review.

**Energy claim — the stat fast path is intact; there is no backoff.**
`readMailboxIfChanged` and `getMailboxSignature` are **byte-identical to `main`**
(`git diff main...HEAD -w` shows no change to either). The stat-before-read
behavior from the prior energy fix is preserved. Effective rates, per session:

| Mailbox state | Per second |
|---|---|
| Idle (no unread) | 1 timer wakeup, 1 `stat()`, **zero** reads |
| Any unread present | 1 `stat`, 1 full `readFile` + `JSON.parse` + zod validation, **plus** 1 `readTeamSnapshot` (team-file lock + read + `structuredClone` + release) |

There is **no backoff of any kind**: `INBOX_POLL_INTERVAL_MS = 1000` is a fixed
constant with exactly one use site (`useInboxPoller.ts:121`, `:1211`), and
`useInterval` never varies the delay. The idle wakeup rate is therefore a flat
**1 Hz per session, unconditionally** — the stat path reduces the *work* per
wakeup to one syscall, not the wakeup count. The "backoff" in the 2026-06-10
energy fix belonged to browser reconnect, not this poller. The branch's own
addition is the per-poll `readTeamSnapshot` in the unread state, which matches
the report's characterization.

## Findings the original report missed

1. **`legacyWriteToMailbox` silently discards an entire mailbox on any parse
   failure** (`src/utils/teammateMailbox.ts:290,306`). This is the actual
   data-loss bug behind F1, and the report inverted it — it listed `:306` as a
   broken write site without seeing that the lenient `readMailbox` at `:290` is
   what turns a transient parse failure into permanent loss of every unread
   message. `readMailboxStrict` already exists and is used by the two newer write
   paths; the legacy path was never updated. **Severity: MED**, and it is the
   change I would make first in this scope. Evidence: `repro-brick.ts`, which
   shows a two-message mailbox becoming a one-message mailbox with no error
   raised to anyone.

2. **An ack failure is indistinguishable from success to the poller.**
   `markMessagesAsReadByPredicate` swallows every error into `logError`
   (`:2385`) and returns `void`, and `markRead()` discards even that. Measured:
   past ~668 ms of lock contention the ack fails and is **never retried**. The
   report treats the ack as "late"; it is frequently "never", and nothing
   anywhere observes the difference. This is why the F2 fix needs a
   delivered-set rather than just an `await`. **Severity: MED**, folded into F2's
   disposition.
