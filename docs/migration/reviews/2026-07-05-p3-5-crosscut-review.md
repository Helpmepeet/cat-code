# P3-5 cross-cutting review (5a + 5b + e4a4be6 kill/close parity, as one system)

**Status: DONE 2026-07-05.** Per-scope review of `git diff 9dcbebd..e4a4be6 -- app/`
(a51cb96 renderer shell + e4a4be6 kill/close parity), in context of the P3-4 stores and the
P3-3 host. This is NOT layer review B (P3-4..P3-7) — that still runs later. Headless;
every claim verified in source.

**One-line recommendation: P3-6/P3-7 may proceed as-is.** No BLOCKER. The two SHOULD-FIX
findings (raw-log replay duplication, restore-path spawn-fail `session-removed`) are
contained defects that do not undermine the shell semantics P3-6/P3-7 build on; land them
before or alongside, at the operator's call.

## Landed LOW fixes (commit `3c73b94`, each with a pre-fix-failing regression test)

- **L1 — empty-id ghost descriptor** (`app/host/host.ts` descriptorFor): a terminal
  tombstone whose registry row was bound-reaped (enforceBound while the tombstone
  lingered) fell through to `descriptorFromRow(undefined, live.status)` → a listed
  descriptor with `appSessionId: ''`. Now `undefined` (SF7: neither live nor restorable).
- **L2 — ⌘1..9 slot mismatch** (`app/renderer/src/shellState.ts` sessionAtSlot): indexed
  the FULL roster (`state.order`, which includes hydrated restorable-only Sidebar offers)
  while the TabBar numbers its ⌘n hints by tab index. One hydrated offer shifted every
  jump: ⌘2 focused a dead non-tab row → stale/blank pane, no tab highlighted, no recovery
  affordance. Now indexes `selectLiveSessions` (the tab order the hints show).
- **L3 — Sidebar labels a live socket-drop "crashed"** (`app/renderer/src/sidebarState.ts`):
  `disconnected` is overloaded (hostApi.ts status doc) — crash-marked dead row
  (`restorable:true`) vs live socket-drop (F13, `restorable:false`, child possibly alive).
  The Sidebar labeled both "crashed". Now only the restorable one; the live drop reads
  "disconnected" (its affordance was already correct: kind:live → focuses the tab).

## Findings NOT landed (operator decides)

### SF-1 (SHOULD-FIX) — raw message log duplicates history on in-run restore
`app/renderer/src/rawMessageLog.ts:69-81` keeps prior messages on `ready` and has no
uuid dedupe; an in-run restore reuses the same `appSessionId`, so the resumed sidecar's
`replay:true` frames (same uuids — F1/F2 same-source) append the whole history AGAIN
under the retained pre-crash rows. **Proven by probe test** (see appendix): transcript
projector PASSES (seenFrameIds dedupes at every projection site —
transcriptProjector.ts:503,588,632,668,775 — so the GUI "pineapple visible" was also
*exactly once* in the transcript pane), raw log FAILS (2 copies).
Blast radius: the raw SDKMessage debug pane + the "Copy for LLM" export show doubled
history; the 512-msg/8-MiB retention budget is spent twice (earlier real rows evicted,
`truncated` flips early). Renderer RELOAD does **not** duplicate: main's buffer is
cleared on the crash's terminal lifecycle frame (main.ts:253-254) — which is also why
`restoreSession`'s missing `evictReplay` is currently safe (every path into "restorable"
already cleared the buffer).
**Proposed minimal fix:** in `reduceServerFrameWithLimits`, when the frame carries
`replay === true`, skip the message if a retained message with the same `uuid` already
exists in that session's log (scan only on replay frames; live path unchanged; restart
semantics unchanged).

### SF-2 (SHOULD-FIX, low reachability) — restore-path spawn failure erases the offer
`app/host/host.ts` spawn() failure handler (`markClean` + `emitRemoved`) is correct for a
fresh create (row has no engineSessionId → genuinely outside the union) but WRONG for the
restore path: the row keeps its engineSessionId and stays in live∪restorable, yet
`session-removed` makes the renderer drop it (and `removedIdsRef` blocks hydrate
resurrection) until app relaunch, and `markClean` erases the `crashed` flag. Reachability
is low (a synchronous `spawnSession` throw: socket-path overflow / duplicate id).
**Proposed:** in the failure handler, emit `session-removed` only when
`row.engineSessionId === null`; otherwise `emitStatus` (and skip the clean relabel of a
crashed row).

### F-3 (LOW) — liveCount counts tombstones toward the spawn cap
`host.ts:510-511` counts every supervisor record, including terminal tombstones (crashed
tabs linger BY DESIGN now, and `failed` spawn records also linger). In a long always-on
run, dead tabs eat `MAX_REGISTRY_SESSIONS` (32) slots: create refused with "at most 32
live sessions" while few/none are actually running; a restore at the cap even counts its
own tombstone. Bound-reaped tombstones (L1's shape) hold invisible slots until quit.
User-recoverable (ack-close the dead tabs), bound is generous — LOW.
**Proposed:** `liveCount()` filters `isTerminalStatus`; registry-row bound stays enforced
by `upsertOnSpawn`'s reap (terminal rows are exactly the reapable ones — consistent).

### F-4 (LOW) — restartSession with a reaped row writes a `cwd:''` garbage row
`host.ts` restartSession: `row?.cwd ?? ''` upserts a new row with empty cwd when the row
is gone (tombstone-only). Self-heals at next launch (`validateRow` drops empty-cwd rows);
hard to reach via UI after L1. **Proposed:** skip the upsert (log) when the row is gone.

### F-5 (design note, operator decision) — the fake/real kill-exit divergence
FakeSupervisor.killSession emits a **synchronous exit** the REAL supervisor can never
emit: `killSession` deregisters first (supervisor.ts:324) and the F11 identity guard
(supervisor.ts:262) then suppresses the child's real exit. The host's `closing` set —
and the comment at host.ts:113-116 ("killSession fires an async exit event") — model the
FAKE's behavior, not the real world. Harmless in direction (the fake emits MORE events;
the suppression is defense-in-depth), but it is exactly the divergence class that hid the
original 5b bug, and two older drivers (host.test.ts:668, :888 raw `emit({type:'exit'})`)
leave record status non-terminal + row `crashed` — a state the real supervisor cannot
produce (it sets `exited` immediately after emitting). **Proposed:** point the older
drivers at `emitCrash`, correct the two comments; keep `closing` as belt-and-braces.
Do NOT make the fake swallow the kill-exit silently — that would un-test the guard.

### F-6 (semantics note) — closing a crashed tab relabels the row clean
`closeSession` on a crashed tombstone (isLive counts records) runs `markClean`, which has
no terminal-state guard (registry.ts:692 vs markCrashed's at :680) — the crash marking is
overwritten and the Sidebar/next-launch offer reads "closed", not "crashed". Verified
this is LOAD-BEARING, not an accident: revoking the tab requires the clean-close
descriptor shape (`exited`+restorable) — preserving `crashed` would emit
`disconnected`+restorable and `foldTabMembership` would KEEP the tab the user just
closed. Close-as-crash-acknowledgment is coherent; flagging only the history loss.

## Hot-area verdicts (all 9)

1. **Three liveness predicates** — no defect at any call-site beyond L1/F-3/F-4 above.
   closeSession tombstone-with-no-row does NOT 404 (`isLive` is true on the record);
   genuine unknowns 404 correctly. markClean-on-crashed = F-6 (deliberate). The
   hasRecord/isRunning single-predicate-pair idea remains a reasonable refactor for the
   operator to schedule; not needed for correctness after L1.
2. **liveCount tombstones** — confirmed-defect, LOW (F-3, proposed fix above).
3. **Replay duplication** — SPLIT: transcript projector confirmed-safe (uuid dedupe,
   probe passes); raw message log confirmed-defect (SF-1, probe fails 2≠1). Reload path
   confirmed-safe (crash clears main's buffer). P3-6/P3-7 not blocked.
4. **foldTabMembership edges** — confirmed-safe: subscribe-before-snapshot +
   `removedIdsRef` + the `lastAttachedAt >=` tie-break keep every fresher live event
   (crash/close don't bump lastAttachedAt, so ties correctly resolve to the live-event
   descriptor). `restorable+ready` is unreachable (isRestorable forces false when live);
   its defensive revoke is consistent with sidebarState's kind:restorable. Noted, by
   design: a renderer reload demotes a this-run crashed tab to Sidebar-offer-only
   (run-local tabs).
5. **restoreSession tombstone kill** — confirmed-safe by two independent guards: real
   supervisor emits NO post-kill exit at all (F11 record-identity, registry.delete first),
   so nothing outlives the synchronous `closing` window (which exists for the fake); and
   `markCrashed` both early-returns on terminal rows AND performs its in-memory mutation
   before its first await (registry.ts:674-684), so no interleaving relabels the fresh
   live row.
6. **FakeSupervisor fidelity** — divergence confirmed, conservative direction (F-5,
   needs-operator-decision).
7. **'disconnected' overload** — one label lie found and FIXED (L3); every other
   renderer path distinguishes via `restorable` correctly (TabBar 'disconnected' +
   restart is truthful for both shapes — restart is host-accepted for tombstone and
   live-drop alike).
8. **Security baseline** — NO REGRESSION. The diff range touches no preload/main/
   sidecar/protocol/limits file; hostApi.ts change is doc-only; HostErrorCode union
   unchanged and still separate from transport ErrorFrame codes; renderer authors no
   path (create = pickDirectory token, restore/close/restart pass ids only); zero new
   wire frames; outbound secretGuard/size caps untouched; hardening-smoke change is
   probe-side session-id stamping only. 18/18 green.
9. **Focus semantics** — confirmed-intended: a crashed tab keeps liveOrder membership
   and may hold focus (the pane shows the dead state + restart affordance);
   crash→restore keeps the same id active through the re-spawn; clean close revokes and
   `activeAfterLiveChange` moves to the first live tab / empty shell. The general pass
   found the adjacent ⌘n mismatch (L2, fixed).

## Verification

`bun test app/` **351 pass / 0 fail** · `bunx tsc --noEmit -p app/tsconfig.json` clean ·
sidecar tsc **0 errors outside src/** (baseline ≈5549 all in src/) ·
`bun run --cwd app test:hardening` **18/18**. All three landed fixes' regression tests
verified failing on pre-fix code (stash/run/pop).

## Appendix — SF-1 probe test (drop-in when landing the fix)

```ts
// in-run restore: same appSessionId, stores never torn down, replay carries the
// same uuids (F1/F2 same-source). Transcript dedupes; raw log must too.
const S = 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa'
const ready = (): ServerFrame => ({ kind: 'ready', protocolVersion: 1, sessionId: S,
  engineSessionId: 'engine-1', payload: { type: 'app.ready', inputEnabled: true } as never }) as ServerFrame
const msg = (uuid: string, text: string, replay?: true): ServerFrame => ({
  kind: 'event', protocolVersion: 1, sessionId: S, ...(replay ? { replay: true } : {}),
  event: { type: 'message', message: { type: 'assistant', uuid, session_id: 'engine-1',
    message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] } } },
}) as never

test('in-run restore: raw message log does not duplicate replayed history', () => {
  let r = createRawMessageLogState()
  r = reduceServerFrame(r, ready())
  r = reduceServerFrame(r, msg('m1', 'pineapple'))
  r = reduceServerFrame(r, ready())            // crash → restore, same appSessionId
  r = reduceServerFrame(r, msg('m1', 'pineapple', true))
  expect(selectRawMessageLog(r, S).messages).toHaveLength(1) // FAILS pre-fix: 2
})
```
