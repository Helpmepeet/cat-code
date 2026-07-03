# Phase-0 cold adversarial review — 2026-07-02

**Scope:** the seams *between* the five P0 decisions (topology, tokens, types, isolation,
security), not re-verification of each task. Reviewed as a set: `PROGRAM-PLAN.md` §0/§4/§5/§7,
`STATUS.md`, `decisions/TRANSPORT.md` (incl. §6 + §P0-4), `decisions/SECURITY-MINIMUM.md`,
`backlog/phase0-1.md`, and the on-disk artifacts in `~/cat-code` (`migration` @ `979985e`,
one commit above the `234da9e` pin).

**Verification ledger (ran, not just read):**
- `bun test src/app-runtime/multiSessionIsolation.probe.test.ts` → **4 pass / 0 fail / 17 assertions** (matches the STATUS claim exactly).
- `bunx tsc --project scripts/typecheck/renderer-engine-types/tsconfig.json --noEmit` → **PASS**.
- `renderer-theme/` `bun run build` → **PASS** (Tailwind v4 theme compiles).
- `git diff 234da9e..HEAD` over every anchored source file → only the probe test itself; **no anchor/snapshot drift on the branch yet**.
- Re-verified every load-bearing `src:line` anchor against HEAD: `state.ts:435/:437/:474/:533/:537`, `QueryEngine.ts:245`, `AppSessionController.ts:87/:91-96/:127/:142-143/:189/:192-195`, `appSessionProtocol.ts:21/:43-48`, `sessionEvents.ts:20-23`, `appSessionEventMapper.ts` (`mapSdkMessage` has no `tool_use` case — the flatten claim is real), `AppSessionWebSocketServer.ts:69-74/:79-87/:113`, `PermissionPromptToolResultSchema.ts` (allow/deny + `updatedInput` fallback), `scripts/build.ts` (externals + `--compile --target bun` flags), `package.json:7`. **All accurate.**

---

## 1. VERDICT

**CLEARED WITH CAVEATS.** The two load-bearing decisions — Electron + Bun sidecar with raw
`SDKMessage` over IPC (P0-1), and N-process-per-session (P0-4) — are sound, mutually
compatible, and adequately evidenced for a Phase-0 gate; I attacked both compositions and
could not break either decision. But the *handoff* out of the gate is defective: **two
CONFIRMED defects must be fixed in the docs before P1-0 executes** (the P0-5 security
contract is orphaned behind a stale "P0-3" pointer in the P1-0 brief; the renderer code-home
is specified three contradictory ways), and the four decisions were produced in parallel
without a reconciliation pass — P0-5's security model describes a single-session world that
P0-4 outlawed the same day. Nothing here reopens a decision; everything here is a cheap doc
fix — but un-fixed, the gate's requirements do not actually reach the sessions that must
honor them.

---

## 2. Cross-cutting findings (ranked by severity)

### F1 — The P0-5 security contract never reaches P1-0 (seam C: security × plan) — **CONFIRMED · BLOCKS P1-0 execution**

`decisions/SECURITY-MINIMUM.md`'s entire enforcement theory is "P1-0 acceptance criteria": §3 opens
with *"Each item is a checkable gate. P1-0 is not done until every one passes"*, and §0 says
the doc *"constrains what P1-0 is allowed to build."* But the pasteable P1-0 brief — the
thing a cold agent actually executes — is `backlog/phase0-1.md:100-119`, and its only
security line is:

> "Electron security baseline on from day one (sandbox, contextIsolation, no nodeIntegration
> — **see P0-3 when it lands**)." (`backlog/phase0-1.md:118`)

"P0-3" is the **old** numbering for security; under the canonical IDs (declared in the same
file at :52) P0-3 is *types*. So the pointer resolves to the wrong deliverable, and P0-5
**has** landed with no one updating the reference. Concretely orphaned from the P1-0 brief:
the §3 hardening checklist (CSP, sanitizer, `will-navigate`/`setWindowOpenHandler`, preload
constraints, the crafted-Markdown smoke test), the §2 allowlist rules (A1 `.strict()` +
`goalSnapshot` re-type closing T4 — `appSessionProtocol.ts:21` is confirmed `z.unknown()`;
A3's T6 echo-only rule; R4 frame/rate caps; R5 outbound secret-key assertion), and the §4
secret rules. The backlog was regenerated at 02:46, P0-5 landed at 02:53, and the gate was
stamped at 02:55 — no one plumbed the new requirements back into the brief.

A requirement nobody is forced to read is a latent regression, exactly as the risk table
(PROGRAM-PLAN §7) warns about anchors. **Fix before P1-0:** replace the stale pointer with
`decisions/SECURITY-MINIMUM.md` and inline its acceptance-criteria status into the P1-0/P1-4 blocks.

### F2 — The renderer code-home is specified three contradictory ways, and P1-0 is the scaffold session (seam F/C) — **CONFIRMED · BLOCKS P1-0 execution**

- `PROGRAM-PLAN.md:29-31` (§0, fixed constraint): *"a fresh build in `~/cat-code` (**not**
  the old `web/` scaffold — that's treated as empty and gets **cleared**)"*.
- `backlog/phase0-1.md:37` (standing rule, in the file P1-0 pastes): *"Code home:
  `~/cat-code/web/` (**replace the stale app in place; reuse its Vite/TS/Tailwind
  scaffold**)"* — survived the 2026-07-02 "regeneration" untouched.
- `renderer-theme/README.md` (the P0-2 artifact): *"intentionally outside the **deprecated**
  `web/` scaffold because **P1-0 owns the final renderer location**."*

`~/cat-code/web/` really exists (old scaffold, last touched 2026-06-12), so "reuse it" is
executable — a cold P1-0 agent following the standing rule will resurrect the directory the
program plan says to clear, and won't find the P0-2/P0-3 artifacts (which live at
`renderer-theme/` and `scripts/typecheck/renderer-engine-types/`, neither mentioned in any
backlog block). The BACKLOG's P0-2/P0-3 blocks (:63-87) still describe `web/`-based work
with `web/`-based done-criteria that is **not** what was delivered and marked ✅. **Fix
before P1-0:** one sentence deciding the code home, and rewrite the standing rule + point
P1-0 at the two artifact directories.

### F3 — P0-5 models a single-session world; P0-4 mandates N processes the same day (seam A×B: the topology × security composition) — **CONFIRMED · no hard block for P1-0, must be resolved in P1-0's protocol design**

`decisions/SECURITY-MINIMUM.md` contains **zero** occurrences of "multi-session", "N-process",
"supervisor", "per-session", or "P0-4" (grep-verified). Its §1 trust zones enumerate exactly
two parties — untrusted renderer, privileged engine sidecar — and its §2 posture is *"the
preload exposes exactly ONE channel… four types, **nothing else**"*, with A1 demanding
`.strict()` frame rejection. P0-4's verdict (same file set, same day) requires the Electron
main supervisor to own N sidecars and *"route `app.submit` / permission responses to the
owning sidecar by that id"* (TRANSPORT-DECISION §P0-4, Phase-3 implications). Two
incompatibilities follow:

1. **No session addressing.** None of the four allowed frame types carries a session
   identifier (`appSessionProtocol.ts:13-48`), and A1's `.strict()` forbids adding one as an
   extra key. Solvable transport-level (e.g. one MessagePort per session, addressing by
   channel instance rather than payload field) — but that design exists nowhere; if P1-0
   freezes a single-channel protocol v1 per the letter of P0-5, Phase 3 must break it.
2. **The supervisor plane is outside the model entirely.** Electron main — the most
   privileged process in the topology, and the one P1-0 explicitly builds
   ("spawn/kill/restart") — is not assigned a trust zone, and renderer-initiated session
   lifecycle (create-session-with-cwd, close, list, restart; crash notifications flowing
   *from main*, which the engine-originated `subscribe(cb)` cannot carry) is privileged,
   mandatory-by-P0-4 functionality that the "default-deny, nothing else" allowlist has no
   row for. Choosing a session's cwd from the renderer is security-relevant (it scopes what
   the engine's tools touch), and it is unmodeled.

Root cause is structural: PROGRAM-PLAN §8 dispatched P0-4 and P0-5 as "independent,
parallelizable," STATUS:33 records them "**independently** verified," and neither document
cites the other. Per-task verification passed both; the seam between them was never owned.
**Fix:** version SECURITY-MINIMUM with a supervisor-plane section + session-addressing rule
before P1-0 freezes the frame format (PROGRAM-PLAN §5 layer 1 already demands a *versioned*
protocol, so this is consistent with the plan's own architecture).

### F4 — "2-proc proven" overstates: no two real engine processes ever ran concurrently anywhere in Phase 0 (seam A: topology × multi-session) — **CONFIRMED (overstatement) / PLAUSIBLE (residual risk) · no block; Phase-3 gate item**

The N-process **verdict is safe** — the 1-proc stomp is real, deterministic, driven through
the real `AppSessionController`, and I reproduced it (probe re-run, 4/17). Hidden extra
globals could only *strengthen* N-process. But walk what actually ran:

- P0-4's "TWO processes" rows are titled in the test itself *"simulated by per-process
  global reset"* and run the two sessions **sequentially in one process**, calling
  `resetStateForTests()` between them (`multiSessionIsolation.probe.test.ts:201-227,
  229-274`). `resetStateForTests()` re-initializes only the `STATE` singleton + two token
  counters (`state.ts:947-956`).
- P0-1's Measurement 2 spawned 3 **real** concurrent Bun processes — which only imported a
  module and printed `READY` (no controllers, no streams, no turns).
- P0-1's packaging probe constructed a real `QueryEngine` and submitted — in **one** process.

So the composition the desktop app actually is — **N real engine processes doing real
concurrent work under one supervisor** — was never demonstrated; each half was proven
separately and joined by reasoning. The reasoning is fine for *module-global* state (a real
process trivially gets a fresh module graph; the emulation is even conservative there). What
it structurally cannot see is **cross-process shared *external* state**, which the sequential
emulation never contends on. Concrete unexamined candidate: Codex token refresh **rotates**
the refresh token and persists it (`codex-core/accounts.ts:150-180` — `refreshCodexToken` →
new `refreshToken` → `saveCodexTokenToVault`/`saveCodexOAuthTokens`) with **no cross-process
locking** (grep-verified); two sidecars sharing the account pool can race a rotating refresh
token and invalidate each other. Same class: `persistPermissionUpdates`
(`PermissionUpdate.ts:349`) writing settings from N processes is last-writer-wins.

STATUS:27's phrasing ("**2-proc** + crash-one-restart isolate cleanly… **Proven** by
runnable probe") reads as if two processes ran; only TRANSPORT's parenthetical discloses the
emulation. **Fix:** re-word STATUS; add "two real engine processes, real concurrent turns,
shared vault/settings contention" as an explicit Phase-3 gate criterion (it is currently
implied by the Phase-3 gate but the *external-state* class is named nowhere).

### F5 — The three tracking docs tell three different stories; STATUS's "IDs unique across all docs" claim is false (seam F: ID/status integrity) — **CONFIRMED · no block; mechanical doc pass required**

- **Gate state:** STATUS:20 says "✅ GATE CLEARED 2026-07-02". PROGRAM-PLAN — marked
  AUTHORITATIVE — still says P0-4/P0-5 "⬜ NOT RUN" (:198, :206), "Gate (**NOT yet
  cleared**)" (:214-215), "still ⬜" (:349, :402), and instructs "**Next session:** run P0-4
  and P0-5" (:405) and "the multi-session existential risk is NOT yet retired" (:410).
  BACKLOG:52 likewise still shows "P0-4 ⬜ · P0-5 ⬜", marks P0-2/P0-3 🟡 (:63, :74) against
  STATUS's ✅, and its Count section (:189-195) says "Remaining to the Phase-1 gate: P0-2,
  P0-3, P1-0..4". The finishing sessions updated STATUS only. (STATUS being the declared
  single source of truth mitigates but does not excuse an AUTHORITATIVE doc asserting the
  opposite in imperative voice.)
- **Stale old-numbering IDs** (STATUS:30 claims "✅ P0 IDs are now unique across all docs…
  No label means two things anymore" — refuted, six survivors):
  1. `decisions/TRANSPORT.md:26` — "(P0-3)" meaning *security* (now P0-5).
  2. `decisions/TRANSPORT.md:155` — "(P0-2's job, not this one)" meaning *isolation* (now P0-4).
  3. `decisions/TRANSPORT.md:160` — "its existential proof is **P0-2**" meaning *isolation*.
  4. `decisions/TRANSPORT.md:200` — "that's P0-2/W2's problem" meaning *isolation/registry*.
  5. `backlog/phase0-1.md:118` — "see P0-3 when it lands" meaning *security* (= F1, the harmful one).
  6. `INVENTORY.md:136` — "the plan's P0-2 existential risk" meaning *isolation* — and
     INVENTORY is live (Step 0 of every future session reads it).

### F6 — The P0-1 evidence base has been deleted; the gate's "packaged evidence" is now testimony (seam E: gate honesty) — **CONFIRMED · no block; note-for-record**

TRANSPORT-DECISION §2 says spike code "**lives in** `~/cat-code/.spike-p0-1/`" — the
directory **does not exist** (never committed; deleted or lost). None of the four
measurements (seam probe, 3-sidecar supervisor, crash-restart, 159 MB compiled binary +
codesign) can be re-run or inspected. Mitigation, and why this doesn't reopen the decision:
the *discriminating* fact — the mapper drops `tool_use` while raw forwarding keeps it — is
independently re-verifiable from source, and I re-verified it (`appSessionEventMapper.ts`
`mapSdkMessage` handles `assistant` by `extractTextFromContent` only; no
`tool_use`/`tool_result` case). The fixture-not-live-turn limitation is honestly disclosed
in §2 and explicitly closed by P1-2/P1-3 ("first live credentialed turn"), which is a
legitimately conditional structure — the gate chose a topology; it did not claim the seam
*walks* (that is Phase 1's gate, by design). One inflation to correct: PROGRAM-PLAN:190
says P0-1 "spiked the three candidates **against the real `QueryEngine`** in packaged
probes" — the seam measurement drove the real *controller* with a fixture adapter; only the
packaging probe constructed a `QueryEngine`. The distinction is exactly the one P0-1's own
§2 is careful about; the summary sentence isn't.

### F7 — P0-3's outcome quietly hollows a §0 rationale, and its repair obligation isn't enforced (seam D/E) — **CONFIRMED · no block; carry to P1-0**

PROGRAM-PLAN §0 justifies the code-home constraint with "Same repo as the engine **so types
version together**." P0-3's actual finding (`scripts/typecheck/renderer-engine-types/README.md`)
is that direct type import **does not work today** — the engine's module graph can't be
checked from an isolated renderer config — so the deliverable is a hand-copied, commit-pinned
**snapshot** (`sdk-types.snapshot.d.ts`, `engine-types.snapshot.d.ts`). A snapshot does not
"version together"; it drifts silently the moment `coreTypes.generated.ts` changes (no drift
yet — verified via git diff against the pin — but the fork drifts by design). The re-sync
obligation exists only in the artifact README and a STATUS table note; the P1-0 backlog
block doesn't mention it, and no mechanism (CI check, drift-diff script) enforces it.
"Types importable ✅" on the gate line is true only under this weaker reading. The projector
correctness stakes are real: PROGRAM-PLAN §5 requires exhaustive handling of the ~19-member
union, *typed against truth* — a stale snapshot is precisely how a new variant slips past an
"exhaustive" switch.

### F8 — The outbound serializer has two half-plumbed contracts, and outbound size is uncapped (seam B, minor) — **CONFIRMED (plumbing) / PLAUSIBLE (impact) · no block**

The raw outbound stream is *inside* the P0-5 trust model (R5), so "raw forwarding" does not
contradict "default-deny" — default-deny governs inbound; outbound is display data whose
threat is T1 (rendering), which §3 covers. But two contracts now apply to the same sidecar
serializer: P0-1 §6's JSON-safe/POJO assertion and P0-5 R5's never-a-token-key assertion.
Only the first reached the backlog (landmine list, BACKLOG:14-20); R5 lives nowhere P1-0
looks (part of F1). Today no `SDKMessage` variant carries token material
(`SDKAuthStatusMessage` = `isAuthenticating?/output?/error?`, `coreTypes.generated.ts:706-711`),
so this is a missing-filter risk, not a live leak. Also asymmetric: R4 caps **inbound**
frames (the WS reference implementation already enforces `MAX_MESSAGE_BYTES = 128 KB`,
`AppSessionWebSocketServer.ts:29/:42/:90`), but nothing caps **outbound** frames — legit
outbound frames can be huge (base64 image `tool_result`s), so a naive symmetric cap breaks
them, while an uncapped outbound lets hostile giant tool output balloon the renderer.
Note-for-P1-0: the two outbound assertions are one function; write them together, and decide
outbound sizing deliberately (chunking vs. cap) rather than by omission.

---

## 3. Single-decision catches (secondary to the seams)

- **S1 — P0-5 missed `updatedPermissions` inside its own cited range — CONFIRMED, should be
  added to A3 before P1-4.** The allow schema carries not just `updatedInput` (T6) but
  `updatedPermissions` (`PermissionPromptToolResultSchema.ts`, inside the very `:44-63`
  range the appendix cites), and on allow the engine both applies them to the live
  `toolPermissionContext` **and persists them to settings** via `persistPermissionUpdates`
  (`PermissionUpdate.ts:349` — "Persists… to the appropriate settings sources"). T5b already
  concedes a T1-compromised renderer can auto-allow every prompt; `updatedPermissions` makes
  that compromise **durable** — one forged allow can install "always allow"-class rules that
  survive restart and suppress future prompts. Strictly worse than T6 in persistence, and A3
  says nothing about it. Suggested rule: reject or strip `updatedPermissions` at the IPC
  boundary until a deliberate always-allow UI exists, then constrain it like `updatedInput`.
- **S2 — T6's "echo-only" rule collides with two legitimate uses — design tension to resolve
  in the Permissions domain, not silently.** Source comments document mobile clients sending
  `{}` (engine substitutes original input, `PermissionPromptToolResultSchema.ts:107-111`),
  and `updatedInput` exists so a human can *edit* a command before approving (the prototype's
  permission surfaces may rely on it). A hard `bad_request` on any difference (A3 as written)
  forbids edit-and-approve. The rule is right for P1-4's minimal UI; flag it as a case-by-case
  conflict (per §0's own rule) before Phase-2/4 Permissions builds on it.
- **S3 — T7's "no length caps" is imprecise as summarized.** STATUS:28 calls it a "real
  source hole"; in source the WS transport *does* enforce a 128 KB frame cap
  (`AppSessionWebSocketServer.ts:29`). The real gaps: per-field caps (prompt/reason/nonce
  are unbounded within a frame) and the fact that the *new* IPC loop must re-implement the
  frame cap. SECURITY-MINIMUM's own §2 phrasing ("schema has none today") is accurate; the
  STATUS one-liner inflates it.
- **S4 — minor anchor nits, all inconsequential:** PROGRAM-PLAN:49 cites `package.json:6`
  for the Bun declaration (it's `:7`; `:6` is `"type": "module"` — TRANSPORT already cites
  `:7` correctly); PROGRAM-PLAN §0's `state.ts:434` / `QueryEngine.ts:215` are the
  acknowledged pre-verification drifts (verified values `:435`/`:245` are in TRANSPORT/P0-4
  and are correct at HEAD).
- **S5 — verified-good (earned, not rubber-stamped):** every load-bearing anchor in
  TRANSPORT-DECISION §3/§P0-4 and SECURITY-MINIMUM's appendix checks out at HEAD; the P0-4
  probe re-runs green (4/17) and its 1-proc stomp is real; the P0-3 fixture typechecks; the
  P0-2 theme builds; the snapshot content is genuine (spot-checked union members incl.
  `auth_status`, `streamlined_tool_use_summary`); T5a's structural guarantee is real
  (`AppSessionController.ts:91-96` no-ops on unknown requestId — confirmed in the probe's
  cross-controller assertion); the P0-4 permission-isolation nuance (instance vs. global
  state) is correct and worth the ink.

---

## 4. What P1-0 must carry forward — and whether it currently would

| # | Requirement / landmine | Source of truth | Visible from the P1-0 brief today? |
|---|---|---|---|
| 1 | §3 renderer hardening checklist (sandbox/contextIsolation/CSP/sanitizer/navigation/smoke test) | SECURITY-MINIMUM §3 | **NO** — stale "see P0-3" pointer (F1) |
| 2 | A1: `.strict()` frames; `goalSnapshot` re-typed from `z.unknown()` to `ThreadGoal` + `safeParse` (T4) | SECURITY-MINIMUM §2 | **NO** (F1) — note: a Zod schema for `ThreadGoal` must be authored; only the TS type exists |
| 3 | A3: `updatedInput` echo-only (T6) **+ add `updatedPermissions` rule (S1)** | SECURITY-MINIMUM §2 / this review | **NO** (F1; S1 exists nowhere yet) — bites at P1-4 |
| 4 | R4 inbound frame+rate caps (reuse the 128 KB WS precedent); decide outbound sizing deliberately (F8) | SECURITY-MINIMUM §2 / this review | **NO** |
| 5 | R5 outbound secret-key assertion (one serializer with #6) | SECURITY-MINIMUM §2 | **NO** |
| 6 | JSON-safe/POJO assertion at the sidecar serializer | TRANSPORT §6 + BACKLOG landmine 1 | **YES** ✅ |
| 7 | `emit()` aliasing — treat emitted events as immutable at >1 subscriber | TRANSPORT §6 + BACKLOG landmine 2 | **YES** ✅ |
| 8 | Re-sync both type snapshots from canonical sources before adoption; add a drift check | typecheck README + STATUS note | **NO** — not in the P1-0 block (F7) |
| 9 | Resolve the four `TODO(P1-0)` tone hexes before using tone utilities | `renderer-theme/theme.css` + STATUS note | **NO** — not in the P1-0 block |
| 10 | Decide the code home explicitly; the standing rule, program plan, and P0-2 artifact disagree | this review (F2) | **NO** — actively contradictory |
| 11 | Design the protocol/frame envelope with session addressing + a supervisor plane in mind, so protocol v1 survives Phase 3 (F3) | this review; consistent with PROGRAM-PLAN §5 layer-1 versioning | **NO** — exists nowhere |

**Phase-3 gate must additionally inherit** (not P1-0's job, but record it now so it isn't
lost the way the P0-5→P1-0 plumbing was): a **real** two-engine-process concurrent probe —
real turns, shared account vault and settings under contention (the token-rotation race,
F4) — as an explicit gate criterion next to the existing "two sessions in one window" line;
and the exhaustive ~19/25-variant adapter fixture already assigned to Phase 2 (PROGRAM-PLAN
§5, TRANSPORT §6) should be stamped into the Phase-2 gate line in STATUS when that backlog
is generated.

---

*Reviewed cold against `~/cat-code` @ `979985e` (`migration`) and the audit doc set as of
2026-07-02. No code or doc changes made beyond this file.*
