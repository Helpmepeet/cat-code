# Next-task handoff → launch — PARKED design study (2026-07-29)

> ## ⛔ PARKED — NOT A DECISION. NOTHING HERE IS RULED, OWNED, OR APPROVED.
>
> The operator stopped this feature on 2026-07-29. This file is a **historical record of a
> design attempt that did not converge**, kept for the source-verified analysis in it. It was
> drafted as `decisions/HANDOFF-LAUNCH.md` and moved here when the work stopped.
>
> **Every cross-file claim it makes was reverted the same day. Specifically, all four of these
> are FALSE as of the move:**
>
> - There is **no** `SECURITY-MINIMUM.md` **HC1-W** amendment. It was written, then reverted;
>   HC1 still admits exactly two cwd sources (native picker, existing registry row).
> - **D5 Q2 was NOT reversed.** `backlog/phase4.md` still lists worktree-at-launch as deferred
>   past v1, on its do-not-reopen list.
> - `PARITY-LEDGER.md:2012` is **still an unowned deferral**. There is no P4-35 owner.
> - There is **no P4-35 row in `STATUS.md`**, and no P4-35 session exists.
>
> Treat the "OPERATOR RULING" block in §3 and every `HC1-W` reference below as **void**.
>
> **Why it stopped.** Two independent adversarial reviews returned `VERDICT: REVISE` — twelve
> findings on rev. 1, fourteen on rev. 2 — and every finding in both rounds landed on the same
> half of the design: **creating a git worktree from the Electron host**. The rev-2 review
> showed that half was not merely under-specified but structurally wrong: `git worktree add`
> runs repository-controlled hooks by design, so refusing Cat Code's own `WorktreeCreate` hook
> refused the wrong surface; the host cannot see the handing-off session's real cwd or HEAD
> (`EnterWorktree` moves the engine without touching the registry row); and the chosen
> primitive `createAgentWorktree` has **no base-ref parameter at all**
> (`src/utils/worktree.ts:236` takes only `prNumber`), so the headline rev-2 fix was not
> implementable as written.
>
> **What is still worth reading.** The half of the design that both reviews left completely
> untouched: §2 (the draft crossing outbound as an ordinary tool_use, needing no new inbound
> vocabulary and no `protocol.ts` change), §5.1 (submit-here vs pre-fill-in-a-new-session, and
> why the trust gate makes auto-submit lose the prompt), and §5.3 (staying clear of P4-32).
> Zero findings, across twenty-six, touched any of it. Anyone restarting this should keep that
> part and choose a different mechanism for worktree creation — most plausibly letting the
> handing-off session's own engine create it under the permission gate it already has, rather
> than the host doing git work in a repo it knows nothing about.
>
> Anchors below were verified on 2026-07-29 and will drift. **Source wins; re-verify before
> acting on anything here.**

**Revision history.** Rev. 1 (2026-07-29) was reviewed adversarially the same day and returned
`VERDICT: REVISE` on twelve findings, all of which reproduced against source. Rev. 2 is the
response. §9 lists what changed and what was wrong, because several rev-1 claims were not merely
imprecise — they were false, and a reader who saw only the corrected text would not know which
guarantees were ever load-bearing.

| # | Question | Verdict |
|---|---|---|
| **H1** | How does an agent-drafted next-task prompt reach a *different* session without the renderer authoring engine state? | **DECIDED** — it does not cross inbound. The draft rides **outbound** as an ordinary `Handoff` tool_use the renderer already receives; every launch outcome lands on an existing rail plus one new host method. **No new inbound vocabulary, no `protocol.ts` frame kind.** |
| **H2** | Worktree-at-launch — still deferred? | **UN-DEFERRED (reverses D5 Q2, operator ruling 2026-07-29).** Lands where `WELCOME-LAUNCHER.md` §6 said it would: spawn-config pre-processing in the host, under `SECURITY-MINIMUM.md` HC1-W. |
| **H3** | Where does the review-and-choose UI live? | **Renderer, driven by the tool_use row**, claiming no chrome slot (§5). |
| **H4** | Terminal (Ink REPL) behaviour | **Absent — gated on a real app-runtime signal**, not left to the implementer (§6). |
| **H5** | What does a new worktree branch FROM? | **The handing-off session's current HEAD**, explicitly passed. Not the engine default (§4.3). |

---

## 1. The problem

The operator's loop today: finish a task → ask the agent to draft the prompt for the next task →
read it → open a session by hand → pick or create a worktree by hand → paste. Steps 4–6 are
manual and the agent already holds what is needed to do them.

Only the **draft** requires the session's model. The **launch** is control-plane: which session,
which directory. Splitting the feature on that seam is what keeps it small.

## 2. H1 — the draft crosses outbound, as a tool_use

```ts
Handoff({ prompt: string, title?: string })
```

The model calls it as the last act of a finished task. `call()` returns immediately; it does not
block on the user.

The renderer already receives the tool_use — raw `AppSessionEvent` fidelity is a locked decision,
so `input.prompt` is in the stream `app/renderer/src/transcriptProjector.ts` already consumes. The
renderer renders a handoff card for that row instead of the tolerant unknown-tool fallback. No new
outbound frame kind either; `secretGuard` already covers the stream.

| Outcome | Rail | Anchor |
|---|---|---|
| Run it here | `app.submit` | one of the four engine frames, `SECURITY-MINIMUM.md` §2 |
| New session, same directory | `createSessionInWorkspace(appSessionId)` | `app/host/host.ts:382` |
| New session, existing worktree | `createSessionInWorkspace(worktreeRowId)` when that worktree is already a registry row; otherwise §4.4 | — |
| New session, new worktree | `createSessionInWorktree(appSessionId, slug, baseRef)` | **new**, §4 |
| Pre-fill the new session's composer | `reducePromptDrafts(drafts, sessionId, text)` | `app/renderer/src/App.tsx:1692` — renderer-plane, no boundary crossed |
| Cancel | nothing | no request was pending |

**Why this satisfies the standing rule.** `backlog/phase4.md:74-81` requires new data to arrive as
a read-only outbound snapshot frame or a host-API read, never a renderer-authored write of engine
state, and forbids new inbound vocabulary absent a decided control action. This needs neither: the
draft is outbound event data, and the control actions are host-API methods (a main↔renderer
contract, not a wire frame — `hostApi.ts:1-12`).

### Deliberately NOT the C5 shape

`ASK-USER-QUESTION-ANSWER.md` (C5) needed an inbound frame because `AskUserQuestion` **blocks**:
the engine holds a pending permission request that the answer must resolve, which T6's echo-only
`updatedInput` cannot carry. Handoff has no such constraint — nothing engine-side waits, because
the answer is a control-plane action, not a tool input.

Adopting C5's shape anyway would buy a spinner and a model-visible outcome, and cost a new inbound
verb, a sidecar-local schema, a T5a gate, a tool gate, boundary tests and a live-path test.
**§0 flag: ⬜ deferred(blocking handoff + model-visible outcome — additive, needs the C5 shape).**

### Two consequences to accept, not hide

- **The model does not learn the outcome.** It cannot revise the draft after a rejection and does
  not know whether the task was taken up. The tool result reads "Handoff offered to the user. Stop
  here." If the user picks *run it here*, the model sees the task itself, just not its provenance.
- **"Stop here" is not enforcement.** A tool result cannot make a turn end, so a model could emit
  two `Handoff` calls, and a transcript row is re-rendered on every restore. Idempotency is
  therefore a **renderer** obligation, not a prompt-wording one: see §5.2.

## 3. H2 — worktree-at-launch, and why the deferral is reversed

`WELCOME-LAUNCHER.md` W3 established the capability is real and correctly shaped ("computed
host-side *before* spawn (it produces the cwd — composes with HC1)"), and §6 pre-specified the
landing ("spawn-config pre-processing in the host … plus copy from `worktreeUxCopy.ts` for
parity"). Q2 deferred it on scope grounds on 2026-07-04, and `backlog/phase4.md:11-21` then baked
that deferral into the phase's do-not-reopen list.

`PARITY-LEDGER.md:2012` records the resulting orphan: the row "carries a ruling but no named
session, so it fails the '⬜ needs a named owner' rule — it needs an explicit operator waiver at
the gate, or a P4-N id."

> **✅ OPERATOR RULING 2026-07-29.** Worktree-at-launch ships. D5 Q2's deferral is reversed and
> the corresponding line in `backlog/phase4.md` is amended in place; `PARITY-LEDGER.md:2012` gains
> P4-35 as its named owner. The HC1 widening this requires is recorded as `SECURITY-MINIMUM.md`
> HC1-W, also operator-ruled, and is the authoritative statement of the constraints.

**This doc is not the record of those changes** — the three files above are. A reader who finds
this doc and not those should treat the discrepancy as this doc being stale (§10).

## 4. The host method

```ts
createSessionInWorktree(
  appSessionId: SessionId,
  slug: string,
  baseRef: 'session-head',
): Promise<HostResult<SessionDescriptor>>
```

Modelled on `createSessionInWorkspace` (`app/host/host.ts:382-415`), which is already the
"renderer names a registry id, host derives the cwd" pattern. Every clause of HC1-W applies; that
rule, not this section, is normative.

### 4.1 Order of operations

1. **HC2** — `isUuid(appSessionId)`, else `session_not_found`. A renderer-supplied path is not a
   UUID and dies here (`host.ts:389`).
2. **Registry lookup** — `findSession(appSessionId)`; missing → `session_not_found`.
3. **HC1** — `validateCwd(row.cwd)`; failure → `invalid_cwd`. Repo root comes from the host's row.
4. **Hook refusal (HC1-W.4)** — if a `WorktreeCreate` hook is configured, refuse with
   `worktree_unavailable`. See §4.2 for why this check cannot live in the host process.
5. **Slug validation (HC1-W.2)** — the engine's `validateWorktreeSlug` rules; plus rejection of
   slugs matching the ephemeral-sweep patterns, which would make the operator's worktree eligible
   for the 30-day agent-worktree cleanup. **Both live in the worker** (§4.2), because
   `EPHEMERAL_WORKTREE_PATTERNS` is module-private (`src/utils/worktree.ts:1031` — `const`, not
   exported) and the host must not import the engine.
6. **HC4 reservation (HC1-W.5)** — reserve a spawn slot *now*, not at `spawn()`. Released on any
   failure below. Without this, concurrent calls all pass `checkSpawnLimits` and mutate the disk
   before any slot is recorded (`host.ts:711` vs `:433`).
7. **Create the worktree** in the worker, based on `baseRef` (§4.3).
8. **Prove containment (HC1-W.3)** — `realpath` the produced path; it must resolve inside
   `realpath(<repoRoot>/.cat-code/worktrees/)`. Failure → remove the artifact, release the
   reservation, `worktree_unavailable`.
9. **Spawn** — new `appSessionId`, no `resumeEngineSessionId`. **On spawn failure, remove the
   worktree** (§4.5).

### 4.2 Where the worktree work runs

`app/host/` must stay Electron-free *and* must not import the engine graph, so steps 4, 5 and 7
cannot execute there. Precedent exists: main already re-spawns **disposable engine-graph workers**
for the sessions catalog and the accounts pool (`hostApi.ts:153-169`,
`app/sidecar/sessionsCatalogWorker.ts`, `app/sidecar/accountsPoolWorker.ts`). A worktree worker is
the third instance of a settled shape.

The worker owns every engine-dependent decision and returns a typed result. The host owns
addressing, HC4, containment proof, and spawn. Rev. 1 put steps 4-5 in the host and called them
"pure functions of the engine's own rules"; they are neither pure nor reachable from there.

**Primitive:** `createAgentWorktree` (`src/utils/worktree.ts:903`) is the no-global-state variant —
it sets no `currentWorktreeSession`, does no `chdir`, writes no project config, which is what a
throwaway worker needs. `createWorktreeForSession` (`:703`) is the wrong one here: its session
state would die with the worker. **But `createAgentWorktree` tries the `WorktreeCreate` hook first
(`:912-919`) and returns the hook's stdout as the path**, which is exactly the escape HC1-W.4
forbids — hence the refusal at step 4, inside the worker, *before* calling it.

### 4.3 H5 — the base ref

`getOrCreateWorktree` resolves its base to `origin/<defaultBranch>`, falling back to `HEAD` only
when the fetch fails (`src/utils/worktree.ts:289-302`). Taking that default would branch the next
task from `origin/main` — **a worktree that does not contain the work the handing-off session just
finished**, which inverts the purpose of a handoff.

The worker therefore passes the handing-off session's **current HEAD** as the base explicitly.
`baseRef` is a closed enum (`'session-head'`) rather than a free string: the renderer names an
intent, never a git ref, so no renderer bytes reach a git command line. Additional bases (default
branch, a named branch) are additive later — and that is where `WELCOME-LAUNCHER.md:54-55`'s
"keep branch chooser as the worktree name/base input" lands if it ever ships.
**§0 flag: ⬜ deferred(base choice beyond session-head).**

### 4.4 Selecting an EXISTING worktree

Rev. 1 said the picker would list all worktrees and select by "index or slug". Those are not
interchangeable, and the promise was unmeetable: a slug only addresses paths the engine resolves
under `.cat-code/worktrees/`, so hand-made trees (this repo's own `.worktrees/<slug>` convention,
CLAUDE.md §4) and harness trees (`.claude/worktrees/agent-*`) are enumerable but **not
addressable** that way.

Resolution, in two tiers:

- **Already a registry row** → it is an ordinary workspace; use `createSessionInWorkspace(rowId)`.
  No new mechanism, HC1 source (b), works for any path regardless of who created it.
- **Not a registry row** → **out of scope for v1.** Admitting it needs a host-minted opaque
  selection id over a host-owned enumeration, which is its own read API (worker + host method +
  preload sender + result schema + stable identity across refreshes). **§0 flag:
  ⬜ deferred(select an unregistered existing worktree — needs a host-owned enumeration seam).**

So v1 offers: stay here · a worktree the app already knows · create a new one. Enumeration is not
free, and the picker must not display what it cannot launch.

### 4.5 Failure, cleanup, and the error vocabulary

`HostErrorCode` (`app/shared/hostApi.ts:118`) has no worktree case; one is added:
**`worktree_unavailable`** — hook configured, slug rejected, containment failed, git failed, or
the worker timed out/crashed/returned malformed output. It is a control-plane code and must not be
merged into the transport `ErrorFrame['code']` union (F3 §3).

The engine helpers **throw** for a missing repo (`worktree.ts:729-737`) and for a failed
`git worktree add` (`:331-335`); the worker converts those to typed results and never lets an
exception cross into main.

**Rollback is required and does not exist today.** Existing spawn-failure cleanup removes only the
registry row (`host.ts:456-480`). A worktree created at step 7 whose spawn fails at step 9 would be
orphaned on disk. Step 9 therefore removes it, and the reservation is released on every failure
path.

### 4.6 Branch collisions

`getOrCreateWorktree` resumes when the worktree **directory** exists (`worktree.ts:249-257`), so a
name collision there is benign — but the UI must say "use existing", not imply a fresh branch.

The dangerous case is the directory being absent while the **branch** `worktree-<slug>` exists:
`git worktree add -B` then **force-resets that branch to the base** (`worktree.ts:322-330`; the
in-source comment states the intent outright). An honest name collision can move a branch tip and
orphan commits. The worker therefore rejects a slug whose branch already exists without a matching
worktree directory, with `worktree_unavailable` and a message naming the branch. Recovering such a
branch is a git operation the operator does deliberately, never a side effect of a handoff.

## 5. H3 — the UI is renderer-owned

The card reads the tool_use row and drives host calls plus `app.submit`. The sidecar gains nothing.

Steps: **review** the prompt (editable; the edit is renderer-local and never returns to the engine)
→ **where** (here / new session) → **worktree** (stay / a known worktree / new). Then launch.

### 5.1 Submit vs pre-fill — decided, not left open

- **Run it here** → `app.submit` into the *current, already-trusted* session, reusing the CC-16
  parked-prompt drain (`App.tsx:1661`) so a choice made mid-turn does not race.
- **New session** → **pre-fill only** (`reducePromptDrafts`). It does **not** auto-submit.

The second is a decision, not a preference. A new session in a not-yet-trusted directory has its
submits rejected by the sidecar until workspace trust is accepted (`sidecarServer.ts:982-1004`),
while the renderer clears a parked prompt right after sending (`App.tsx:1665-1678`) — so an
auto-submitting launch could silently lose the prompt against the trust gate. Pre-fill sidesteps
the race entirely and matches the operator's stated intent ("pre-filled automatically"). A
trust-aware launch queue is the only way to auto-submit safely. **§0 flag: ⬜ deferred(auto-submit
into a new session — needs a trust-aware, error-correlated launch queue).**

Related: the per-cwd trust gate (`STARTUP-GATES.md` G1) fires post-spawn and has only ever been
exercised from `onOpenFolder`. The implementer must confirm it is reachable for a session created
through this path — a new worktree directory is always untrusted on first open.

### 5.2 Idempotency

A handoff card is a transcript row: it re-renders on restore and its buttons can be clicked twice.
Neither may spawn a second session. The card carries a **consumed-once marker keyed by tool_use id**
in renderer-plane state, set before the host call and surviving restore; a consumed card renders as
a result ("started a session in …"), not as live controls. This is the renderer's obligation
precisely because §2 established the tool result cannot enforce it.

### 5.3 Adjacency to P4-32, respected

`ORCHESTRATOR-IN-SESSION.md` (P4-32) is **PROPOSED, no implementation authorized**, and holds that
"there is no Orchestrator page… the target is small chrome attached to the ordinary session."

P4-35 is therefore scoped to **a transcript row renderer for one tool** and claims no chrome slot,
panel, or dock. If P4-32 later rules that in-session chrome exists, the card is a candidate tenant —
additive, not a re-architecture. P4-35 must not pre-empt that ruling.

## 6. H4 — absent in the terminal, on a real signal

One terminal tab holds one session, so of the two destinations only "run it here" exists, and that
is just "keep talking". Registering the tool there offers a choice the runtime cannot honour.

Rev. 1 cited `src/tools.ts:259` as precedent and left the condition to the implementer. That was
not a decision: desktop sidecars build their tool list from the **same global** `getTools()` the
terminal uses (`app/sidecar/sessionController.ts:292`), so no app-vs-terminal discriminator exists
at that layer today.

**Decision:** the discriminator is the sidecar's own runtime identity — the session-id environment
variable main sets when it spawns a sidecar (`CATCODE_SIDECAR_SESSION_ID`, named in
`SECURITY-MINIMUM.md` §Addendum as main-owned spawn input). The implementer reads the exact name
and reader from source, cites it, and adds a test asserting the tool is absent in a terminal
session and present in a sidecar one. It must be a signal main actually sets — not a new env var
invented for the gate, and not a GrowthBook-style flag.

This is a **capability** decision, not a product cut: nothing in the terminal degrades and no
prototype element is dropped.

## 7. Adversarial self-review

- **A1 — can a hostile renderer author a filesystem path?** Not under HC1-W. Inputs are a UUID, an
  allowlisted slug, and a closed-enum base. The repo root is the host's, the join is the host's,
  and containment is **proven by realpath after creation** (HC1-W.3) rather than assumed from
  construction — which is what defeats a pre-planted symlink at the target name. The hook escape,
  the one path that could return an arbitrary directory, is refused outright (HC1-W.4).
  *Rev. 1 asserted this guarantee without clauses 3 and 4 and was wrong to.*
- **A2 — is the handoff prompt an escalation?** No. It reaches the engine only via `app.submit` (a
  decided, T4-capped frame) or as renderer-local composer text. A compromised renderer can already
  say arbitrary things to the model through `app.submit`.
- **A3 — does the outbound draft leak anything?** No. It is a tool_use in the existing event
  stream, already `secretGuard`-scanned, already delivered to the renderer that rendered it.
- **A4 — fork-bomb / disk exhaustion?** Bounded only because of HC1-W.5: the slot is reserved
  before creation and held across the await, so N concurrent calls cannot all pass one check.
  Worktrees are real checkouts costing real disk, and the sweeper deliberately spares
  operator-named slugs (§4.1 step 5), so accumulation is the operator's to manage — as with
  `git worktree add`. *Rev. 1's fork-bomb conclusion was unsupported: it checked, then awaited,
  then spawned.*
- **A5 — TOCTOU on the row's cwd?** Re-validated at step 3, and the produced path again at step 8.
  A directory removed between them yields a typed error, not a spawn into nothing.
- **A6 — two sessions in one worktree?** Permitted; `createSessionInWorkspace` already allows N
  sessions per cwd. Concurrent edits are the operator's problem, as with two terminal tabs.
- **A7 — a worker that hangs or lies?** It runs under a timeout; timeout, crash, non-zero exit and
  malformed output are all `worktree_unavailable` with the reservation released. The host trusts
  the worker's *path* only after its own realpath containment check (A1).
- **A8 — replay?** A restored transcript re-renders the card; §5.2's consumed-once marker is what
  stops a restore or a double-click from spawning duplicates.

## 8. Tests

Host (`app/host/host.test.ts`):
- accept: valid id + slug → descriptor whose cwd is the worktree path, no `resumeEngineSessionId`;
- accept: worktree is based on the handing-off session's HEAD — **asserted by commit, not by
  flag** (a commit made in the parent before handoff is present in the new worktree);
- reject: non-UUID id (incl. a raw path) → `session_not_found`, nothing created on disk;
- reject: unknown id → `session_not_found`; vanished cwd → `invalid_cwd`;
- reject: slug failing validation (traversal, over-length, empty segment) → `worktree_unavailable`,
  **asserting no directory was created**;
- reject: slug matching an ephemeral sweep pattern;
- reject: `WorktreeCreate` hook configured → `worktree_unavailable`, **asserting no hook ran**;
- reject: branch `worktree-<slug>` exists without its directory → `worktree_unavailable`,
  **asserting the branch tip did not move**;
- reject: target resolves outside `.cat-code/worktrees/` via a pre-planted symlink → typed error,
  artifact removed;
- reject: spawn limit reached → `session_limit` **before** any worktree exists on disk;
- concurrency: N simultaneous calls with one slot left → exactly one worktree created;
- rollback: worktree created, spawn then fails → worktree removed, reservation released;
- worker: timeout / crash / malformed output → `worktree_unavailable`, no partial state;
- **live-path**: a real registry row + a real git repo produces a real worktree the spawned session
  is rooted in — real data flowing, not a shape test (CLAUDE.md §8.1).

Preload + hardening: the new method uses the HC3 fixed-sender pattern and is test-pinned;
`bun run --cwd app test:hardening` all-pass.

Renderer: handoff card selector, consumed-once marker across a simulated restore, static markup.
**Known blind spot, stated not papered over:** the `app/` renderer suite is SSR-only
(`renderToStaticMarkup`, no DOM harness without operator sign-off), so the card's step machine and
click handling are structurally invisible to it — the gap that hid the P4-0 recall and P4-18a
live-frame defects. Those checks are GUI acceptance or they are unverified.

Engine (`src/`): the tool's registration condition — absent in a terminal session, present in a
sidecar one.

## 9. What rev. 2 changed, and what rev. 1 got wrong

Recorded so the corrections are auditable rather than invisible.

| # | Rev. 1 defect | Rev. 2 |
|---|---|---|
| 1 | Claimed HC1 was "intact"; a created path is a third provenance class | `SECURITY-MINIMUM.md` HC1-W, an explicit operator-ruled amendment (§3) |
| 2 | A1 claimed containment that the `WorktreeCreate` hook path breaks | HC1-W.4 refusal + HC1-W.3 realpath proof (§4.1, §4.2) |
| 3 | HC4 checked, then awaited creation, then spawned | Reservation across the await, released on failure (§4.1 step 6) |
| 4 | Picker promised "index or slug" over all worktrees — unaddressable and no read API | Two tiers; unregistered worktrees deferred with the seam named (§4.4) |
| 5 | Base ref unspecified → would branch from `origin/main`, omitting the finished work | H5: explicit `session-head` (§4.3) |
| 6 | Only directory collisions considered; `-B` can reset an existing branch | Branch-collision rejection (§4.6) |
| 7 | Submit-vs-prefill left ambiguous; parked drain vs the trust gate could lose a prompt | Decided: prefill for new sessions, submit only in-session (§5.1) |
| 8 | Claimed `/exit` could manage these worktrees — it cannot | Corrected in §10 carry-forwards |
| 9 | Put engine-dependent validation in an engine-free host; one constant is unexported | All of it moves into the worker (§4.2) |
| 10 | No typed worktree error, no rollback, thin failure tests | `worktree_unavailable`, rollback, expanded tests (§4.5, §8) |
| 11 | Asserted a ruling the program-truth files did not record | The three files are amended at source; this doc defers to them (§3) |
| 12 | H4 unresolved; no idempotency against replay/double-click | §6 decides the signal; §5.2 adds the consumed-once marker |

## 10. Carry-forwards

- Blocking handoff + model-visible outcome (§2) — needs the C5 inbound shape; additive.
- Base choices beyond `session-head` (§4.3) — where `WELCOME-LAUNCHER.md:54-55`'s branch input lands.
- Selecting an unregistered existing worktree (§4.4) — needs a host-owned enumeration seam.
- Auto-submit into a new session (§5.1) — needs a trust-aware launch queue.
- If P4-32 rules that in-session chrome exists, the card is a candidate tenant (§5.3).
- `src/tools/EnterWorktreeTool/prompt.ts:30` names `.claude/worktrees/`; the code uses
  `.cat-code/worktrees/` (`src/utils/worktree.ts:205`). Stale doc, unowned, not P4-35's to fix.
- **Worktree removal is out of scope, and no existing flow covers it.** `ExitWorktreeTool` refuses
  any worktree whose `createWorktreeForSession` did not run in that same process
  (`src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:174-186`), and §4.2's worker deliberately leaves
  no session state — so worktrees created this way are **manual git management only**. Rev. 1
  claimed the TUI `/exit` flow would cover them; it will not.
