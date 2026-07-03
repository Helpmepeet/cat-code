# Direction review — 2026-07-02

**Scope:** the destination and the path, not execution. A separate cold review
(`reviews/2026-07-02-phase0-review.md`) already audited the Phase-0 gate; this review asks whether the
program is pointed at the right place and whether the locked bets survive a long-horizon attack.
Reviewed against: `PROGRAM-PLAN.md`, `INVENTORY.md`, `STATUS.md`, `decisions/TRANSPORT.md`
(+§P0-4), `decisions/SECURITY-MINIMUM.md`, `backlog/phase0-1.md` (post-review regeneration), and the engine
source at `~/cat-code` (`migration` @ `6365755`). Every source-derived claim below was
re-verified against source this session, not taken from the docs.

**Verification ledger (independently checked, not read off the plan):**
- Bun-only engine: `src/QueryEngine.ts:1` (`import { feature } from 'bun:bundle'`),
  `package.json:7` (`"packageManager": "bun@1.3.11"`). Confirmed.
- Process-global session state: `src/bootstrap/state.ts:435` (`const STATE: State =
  getInitialState()`), `state.ts:69` (`cwd`), `state.ts:105` (`sessionId`), mutated per-submit at
  `src/QueryEngine.ts:245` (`setCwd(cwd)`). Confirmed.
- Size of the hypothetical single-process refactor: `getSessionId()`/`getCwdState()` alone have
  **246 call sites across 117 files** (rg count), plus 274 direct `STATE.` references inside
  `state.ts`. Confirmed: threading session identity through is a whole-engine refactor.
- Mapper flatten: `src/web/appSessionEventMapper.ts:77` maps assistant messages via
  `extractTextFromContent` only; no `tool_use`/`tool_result` case exists. Confirmed.
- Raw rich seam: `src/app-runtime/sessionEvents.ts:19-22` (`{ type:'message'; message:
  SDKMessage }`). Confirmed.
- Protocol frames carry no session identity: `src/web/appSessionProtocol.ts:13-48` — four inbound
  types, `requestId` is per-request correlation, no session field. Confirmed.
- Shared-external-state race: `src/codex-core/accounts.ts:153-186` — token refresh **rotates** the
  refresh token and persists it (`saveCodexTokenToVault` / `saveCodexOAuthTokens`); no locking
  primitive anywhere in the file. Confirmed.
- Fork↔upstream: `git remote -v` shows **origin only** (no upstream remote); 171 commits, no
  upstream merges in history. The fork is permanently diverged — engine changes carry **no
  upstream-merge tax**.
- Product identity: `package.json:5` ("personal **always-on** agent system"), `README.md:7-10`
  (goal: "an always-on personal agent that can run on a **server Mac**, keep working while the
  main Mac sleeps"), `docs/vision/2026-04-30-GOAL_PLAN.md:16,20,22,75` ("controlled from the main
  Mac (or phone, eventually)"; main Mac "**may sleep or disconnect at any time**"; "must function
  independently"; "durable background service… survives reboots, disconnects").
- Prototype scale/invention: `cat-app/*.jsx` = **15,524 lines**; ≥10 invented permission `variant`
  ids in `Permissions.jsx` (`bash`, `computer-use`, `file-edit`, `file-write`, `filesystem`,
  `powershell`, `sandbox`, `skill`, `web-fetch`, `worker`) vs. the engine's single
  control-request shape. The docs' "prototype invented a taxonomy" claim is real.

---

## 1. Verdict

**The direction is right, with one structural pin missing.** The destination type (a dedicated
desktop GUI on the real engine), the topology (Electron + Bun sidecar, raw `SDKMessage` over
IPC), the N-process bet, the three-layer boundary, and risk-first phasing all survive the
strongest attacks I could construct — most of them because the program already attacked itself
harder than an outside reviewer usually would. The one change I would make, in one sentence:
**before P1-0 runs, separate "the host" from "the window" — pin the supervisor + sidecar plane as
a window-independent module speaking over a filesystem socket, with session lifetime an explicit
decision — because the program is currently about to build the agent's new home inside the one
structure the product's own vision statement says the agent must outlive.** That change costs
roughly a paragraph today and prevents the only failure I found that would force reopening a
completed phase later. Nothing else here reopens a locked decision; the remaining findings adjust
sequencing and gates.

---

## 2. The strongest case against the current direction

**The attack: you are building a container, and the product is a resident.**

Cat Code's stated identity — in `package.json:5`, in `README.md:7-10`, and in the vision doc the
README points to — is an **always-on personal agent system**: an agent that runs on a server Mac,
keeps working while the control surface sleeps or disconnects, and is "controlled from the main
Mac (or phone, eventually)" (`GOAL_PLAN.md:16-22`). The control surface is, by the product's own
definition, the *detachable* part.

The migration's locked topology inverts that relationship. Decision #3 makes **Electron main the
supervisor and parent of the N engine processes**; the regenerated P1-0 brief pins "Electron main
= supervisor" (`backlog/phase0-1.md:156`) and delegates the actual IPC channel to a cold agent —
"stdio / MessageChannel / local socket — **your call**" (`backlog/phase0-1.md:151`). Walk that
choice forward:

- A cold agent will pick stdio or a Node-style child IPC pipe, because it is the easiest thing
  that satisfies the done-criteria. Of the three listed options, **only a filesystem socket
  survives the parent**: stdio and child-IPC channels are parent-bound by construction, and an
  Electron `MessagePort` cannot be handed to a non-Electron Bun child at all (so that option is
  not even feasible — a detail the brief doesn't know).
- Phase 3 then builds the registry, attach/multiplex, and crash semantics around
  parent-child ownership. `decisions/TRANSPORT.md:342` already conflates the two structurally
  different options in one breath — the registry must "persist enough to **re-attach or
  re-spawn**" — but under parent-bound pipes, re-attach is impossible and the phrase silently
  degrades to "re-spawn from transcript," which loses all in-flight work.
- Phase 5 then adds **auto-update** — meaning routine, automatic app relaunches. Under
  child-ownership, every update kills every running engine turn, every background agent, every
  long autonomous task. For a chat viewer that's a shrug; for a system whose reason to exist is
  "keeps working while you're away," it is a product defect installed by the release machinery.
- Post-ship, Milestone 4 of the vision ("agent runs as a durable background service… survives
  reboots, disconnects", `GOAL_PLAN.md:75`) requires exactly the piece Phase 3 built — a
  supervisor + registry — but living in a daemon instead of a window. The protocol frames survive
  (they're transport-agnostic JSON); the supervisor plane, lifecycle, and crash orchestration get
  rebuilt. That is Phase 3 done twice.

The tell that this was never weighed: across `PROGRAM-PLAN.md`, `decisions/TRANSPORT.md`,
`INVENTORY.md`, and `decisions/SECURITY-MINIMUM.md` there is **zero occurrence** of "always-on," "server
Mac," "daemon," or any session-outlives-app language (grep-verified). The program plan's §0 rules
out a browser app because "the N-process + local-FS need still rules out a pure browser app" —
and that justification is **technically false**: the N processes and filesystem access live in
whatever long-lived process hosts the engines, never in the chrome. A local host process plus a
browser tab is a standard shape (that's what the engine's own `--web` mode already is). The
desktop-app call is actually justified by product feel — a real window, dock presence, no
browser chrome, one toolchain, a mature signing story — and for a daily-driven personal tool
those are legitimate, decisive reasons. But because the *stated* reason was a technical
impossibility that doesn't exist, the plan never noticed that **host and chrome are separable
decisions**, and it fused them. Fused, the chrome's lifetime becomes the agent's lifetime.

There is a second, product-thesis layer to the attack: this program spends ~50 sessions
rebuilding chrome while the milestones that actually differentiate the product (agent identity,
persistent memory, server-Mac host — `GOAL_PLAN.md` Milestones 1/3/4) sit idle, and the UX being
rebuilt was never validated by use — it's a mock-data fiction for 28 of the inventory's rows.
Argued to its conclusion, the worst case looks like this: **mid-Phase-4, the operator owns a
beautiful signed multi-session desktop app and still lives in the TUI — because the app kills his
running agents every time it updates or quits, and the surfaces Phase 4 faithfully rebuilt were
prototype storytelling rather than things he uses — and the server-Mac vision now requires
re-architecting what was just shipped.** Each leg of that scenario is independently plausible,
and the plan as written has no gate that would catch any of the three before Phase 4.

**Where the attack fails — and why the verdict stands.** None of this reopens Electron
(right chrome), N-process (forced by the engine, see §3), raw-IPC frames (right seam), or the
phase order (right risk sequence). The scope-priority leg is the owner's explicit, twice-confirmed
call (interview 2026-06-26; Electron confirmed 2026-07-02), and Phases 2–3 deliver a usable core
long before the 50-session figure matters. The fidelity leg is already half-mitigated by the
plan's own source-wins conflict rule and D1–D5 quarantine — it needs a dogfood gate, not a
U-turn (finding DR-3). And the container leg — the strongest leg — is fixable today for the cost
of a paragraph, because nothing has been built yet. That is what DR-1 pins. A wrong direction
would require killing a bet; this direction requires **unfusing two decisions that were welded by
an incorrect premise**, before P1-0 pours the concrete.

---

## 3. What the plan gets right that a naive review would miss

Defending these explicitly so later phases don't second-guess them:

1. **N-process is not a workaround; it is the correct price.** A naive review sees "N × 159 MB
   sidecars because of one global variable" and prescribes an engine refactor. The refactor is
   not one variable: session identity is read through **246 call sites in 117 files**
   (`getSessionId()`/`getCwdState()` alone), against a module-level singleton
   (`state.ts:435`) mutated on every submit (`QueryEngine.ts:245`). Threading a session context
   through that graph is a whole-engine rewrite whose regression risk lands on the *working TUI*
   — the one asset the program must not damage. The OS process is the only isolation boundary
   that costs zero engine changes, and it buys crash isolation (proven in P0-1 measurement 3)
   that a single-process design would have to build by hand. On a personal Mac with a handful of
   live sessions, N× memory is the cheapest thing on this list.

2. **Eliminating loopback-WS was right *as evaluated* — and finding DR-1 does not resurrect
   it.** The flatten is real: `appSessionEventMapper.ts:77` reduces assistant messages to
   extracted text with no `tool_use` case, so candidate (c) as-built cannot render the
   prototype's core surface. Add a listening TCP port next to a renderer displaying untrusted
   model output, and elimination is correct twice over. DR-1's socket recommendation is the same
   *chosen* raw-frame protocol over a non-listening filesystem socket — a different animal from
   the eliminated candidate (the existing WS server + its mapper + its port). Nobody should
   re-litigate P0-1 on the back of this review.

3. **The three-layer boundary looks like enterprise ceremony for a solo app; it is actually the
   load-bearing wall.** The real stream is 19–25 message variants with `unknown[]`-typed content,
   and the prototype invented a taxonomy on top (≥10 permission variants verified in
   `Permissions.jsx`; a `tool` message type; `escalate:user`) that the engine has never emitted.
   The projector — stateful, correlating, exhaustive over the real union — is the genuinely hard
   part of this program, and the §5 split (protocol / projector / per-domain selectors) is
   precisely what stops prototype fictions from metastasizing into the production contract *and*
   what makes Phase 4's parallel fan-out safe. If a future session proposes "simplify: merge the
   adapter layers," that is the regression.

4. **The gates are designed to resist Potemkin passes.** Phase 1's gate requires rendering a real
   `tool_use` — chosen specifically so the known flatten failure mode cannot hide behind a
   text-only demo. P0-4's probe distinguished instance state (permission plumbing — genuinely
   isolated) from global state (cwd/sessionId — genuinely fatal) instead of hand-waving
   "shared state bad." This is unusually honest gate engineering; keep it.

5. **The program's epistemic hygiene is its actual safety net.** There is no strangler-fig
   fallback here — no shared code, no traffic to shift back. What substitutes for it is process:
   the program *refuted its own locked decision* (Electron in-process) against source and
   withdrew it; every gate got an adversarial review; packaged-vs-reasoned evidence is scoped
   honestly; and the Phase-0 review's findings were absorbed into the regenerated backlog within
   hours (F1's security inlining, F2's code-home fix, and F3's `sessionId` slot are all verifiably
   present at `backlog/phase0-1.md:141-167`). Under Phase 4's parallel fan-out there will be
   pressure to economize on this. Don't — it is the only mechanism that has caught every real
   error so far.

6. **INVENTORY's D1–D5 quarantine and "prototype = spec, source wins" are the right fidelity
   contract.** The plan does *not* actually commit to blind fidelity with a mock — it commits to
   the prototype as design intent with a named human escape hatch per conflict, and it explicitly
   forbids cold agents from making product calls (D1–D5). A naive reading of "UI/UX matches the
   prototype" misses that the dangerous version of that sentence was already defused. What's
   missing is only the *validation* half (DR-3).

---

## 4. Findings, ranked by how much they'd change the plan

### DR-1 — Unfuse the host from the window before P1-0 pours concrete
**REOPEN-A-DECISION** *(narrowly: the supervisor-placement clause of locked decision #3 and the
unpinned IPC-channel clause of decision #2 — not Electron, not N-process, not the frame format)*

- **Claim.** The engine-host plane (supervisor, sidecars, registry) must be structurally
  independent of the Electron window, or the product's stated identity — always-on, survives the
  control surface (`package.json:5`, `README.md:7-10`, `GOAL_PLAN.md:16-22,75`) — is foreclosed
  by an implementation detail a cold agent is about to pick by default
  (`backlog/phase0-1.md:151,156`).
- **Why it matters.** Full argument in §2. Compressed: parent-bound pipes ⇒ Phase-3 registry
  hard-codes child-ownership ⇒ Phase-5 auto-update kills live agent work on every release ⇒ the
  two-Mac vision reopens Phase 3 post-ship. "Re-attach or re-spawn"
  (`decisions/TRANSPORT.md:342`) are opposite architectures, and the docs currently treat them as
  synonyms.
- **Phase it bites.** Decided (implicitly) in P1-0, days from now; hurts in Phase 3, Phase 5, and
  every day of post-ship life.
- **Course-correction (≈ one paragraph added to the P1-0 brief / TRANSPORT §4):**
  1. **Pin the channel: a filesystem (Unix-domain) socket**, not stdio/child-IPC. Note in the
     brief that Electron `MessagePort` cannot reach a Bun child at all, so the listed menu is
     wrong as written. Non-listening socket file ⇒ no new network attack surface; P0-5's
     allowlist applies unchanged.
  2. **Supervisor = an Electron-free module** (own package/folder, no `electron` imports) that
     Electron main *calls*. Its spawn/attach/registry API is the host API; the window is client
     #1 of it.
  3. **Session lifetime becomes an explicit decision — add it as D6** to INVENTORY's
     human-decision list ("do sessions die with the window? v1 may say yes") rather than an
     accident of process parenting. "Yes, die-with-window" is an acceptable v1 answer *if
     chosen* — parity with today's TUI — but it must be chosen.
  4. **Phase-3 gate gains one line:** quit and relaunch the app with a turn in flight; sessions
     re-attach (or D6 explicitly waived it for v1).
- **Cost now ≈ 0; cost of not doing it = rebuilding Phase 3's hardest workstream later.**

### DR-2 — Shared external state is a design input for Phases 1–2, not a Phase-3 test item
**ADJUST-THE-PLAN**

- **Claim.** N-process solves in-*process* isolation but creates N concurrent writers to shared
  *files*. Verified concretely: Codex token refresh **rotates the refresh token and persists it
  with no cross-process lock** (`codex-core/accounts.ts:153-186`; no lock primitives in the
  file). Two sidecars refreshing the same account race the rotation; the loser holds a dead
  refresh token — the account drops out of the pool, and OAuth reuse-detection can revoke the
  grant server-side. Same class: `persistPermissionUpdates` settings writes are
  last-writer-wins; history/statsig/log files unexamined.
- **Why it matters.** This fires under completely normal use — two long sessions on the shared
  Codex pool — i.e., on day one of Phase-3 dogfooding, and it presents as "my accounts keep
  logging out," the worst kind of trust-destroying bug for an always-on system. The Phase-0
  review (F4) correctly flagged it but parked it as a *Phase-3 gate criterion*; that's a
  verification-time answer to a design-time question. If the fix were "supervisor brokers vault
  access," it would change the Phase-1 protocol and Phase-2 assumptions — better to know now.
- **Phase it bites.** Manifests in Phase 3; shapes contracts in Phases 1–2.
- **Course-correction.** Schedule a bounded task — parallel to Phase 1/2, **gating Phase-3
  start, not Phase-3 end**: (a) a two-real-engine contention probe (forced concurrent refresh of
  one account; concurrent settings writes), (b) the likely fix, an engine-side advisory lockfile
  + single-flight around refresh-and-persist — small, contained, and **cheap for this fork**:
  there is no upstream remote (origin only; no upstream merges in 171 commits), so the plan's
  "don't touch the engine" instinct — correct for the 117-file state refactor — over-generalizes
  here. A 30-line lock in `accounts.ts` carries no merge tax and no protocol change. If the
  probe instead forces brokered access, Phase 1's envelope learns it while still wet.

### DR-3 — Add a dogfood gate; demote Phase-4 parity from promise to cut-line
**ADJUST-THE-PLAN**

- **Claim.** The Phase-4 gate — "prototype feature parity (the ~80% that's wireable)"
  (`PROGRAM-PLAN.md:249`) — commits the largest, most parallel phase to fidelity with a mock that
  no one has ever *used* (28 inventory rows are faked/partial fictions; the permission taxonomy
  is invented). The only UX validation that exists for an N=1 product is the owner living in it,
  and the plan never forces that before Phase 5.
- **Why it matters.** Phase 4 is where the session budget goes. Without a usage signal, the
  program will faithfully rebuild prototype storytelling (the D2 agent chrome, D4 startup gates,
  D5 welcome launcher are already suspected storytelling — that's why they're open decisions),
  and the ~50-session estimate inflates in the least valuable direction.
- **Phase it bites.** Phase 4 (wasted parallel capacity), Phase 5 (shipping surfaces nobody
  exercised).
- **Course-correction.** (a) End Phase 3 with an explicit **dogfood gate**: the operator
  daily-drives the app for ≥1 week and produces a keep/cut/change list; (b) generate the Phase-4
  backlog *from that list*, ranked, with parity reframed as the cut-line's outer bound, not the
  gate; (c) answer D2/D4/D5 from observed use instead of armchair rulings. This converts the
  prototype from contract to hypothesis at exactly the moment real data exists, and it is the
  cheapest possible test of the whole product thesis.

### DR-4 — Protocol v1's control plane is still unmodeled (the sessionId slot alone isn't enough)
**WATCH-ITEM**

- **Claim.** The regenerated P1-0 brief bakes a `sessionId` slot into v1
  (`backlog/phase0-1.md:167` — good, that was the breaking half of PHASE0-REVIEW F3). Still
  unowned: the **supervisor/control plane** — create-session-with-cwd, close, list, restart,
  crash notifications — messages that originate in *main*, not the engine, and that the four
  engine frame types (`appSessionProtocol.ts:13-48`) cannot carry. Renderer-chosen cwd is
  security-relevant (it scopes what tools touch) and sits in no trust zone.
- **Why it matters / phase.** If Phase 3 improvises the control plane ad hoc, the versioned
  protocol (§5 layer 1) gets a second, unversioned sibling. Bites at Phase-3 build-out.
- **Course-correction.** Keep v1's envelope versioned with `.strict()` applied *per frame type*
  so new control frame types are additive; if DR-1 is adopted, the control plane **is** the host
  module's API — design it there once, and give it a row in SECURITY-MINIMUM's trust zones (the
  Phase-0 review's F3 fix, which is still pending "in P1-0's protocol design").

### DR-5 — The real make-or-break residue is P1-2's live turn; don't let the gate soften
**WATCH-ITEM**

- **Claim.** All seam evidence so far is fixture-level (honestly disclosed), and the P0-1 spike
  artifacts are deleted (PHASE0-REVIEW F6) — so the first **live credentialed, tool-rich turn
  through the compiled sidecar over real IPC** (P1-2/P1-3) is the moment make-or-break #1
  actually retires. This is sequenced correctly; the risk is social, not technical — a
  walking-skeleton demo that "basically works" with a text-only turn.
- **Course-correction.** None needed beyond vigilance: the Phase-1 gate already requires a
  rendered real `tool_use`; hold it, and re-create the evidence as committed probe code this
  time (the F6 lesson).

### DR-6 — Type-snapshot drift has no enforcement mechanism yet
**WATCH-ITEM**

- **Claim.** P0-3's deliverable is a commit-pinned hand-copied snapshot, not live type imports
  (PHASE0-REVIEW F7); the projector's required exhaustiveness over 19–25 variants is only as
  true as that snapshot, and the re-sync duty lives in a README no backlog block cites.
- **Phase it bites.** Phase 2 (projector correctness), silently.
- **Course-correction.** When P1-0 installs the type aliases, add a one-script CI drift check
  (diff snapshot vs. `coreTypes.generated.ts` at the pin; fail on mismatch). Ten minutes now,
  or an invisible hole in "exhaustive" later.

---

## 5. The one question that, if answered wrong, sinks this program

**"When the window closes, does the agent stop?"**

Every other existential risk is either retired (topology, isolation — retired with real
evidence) or scheduled (the live seam turn, Phase 1). This one is currently being answered by
default — by whichever IPC mechanism a cold agent finds easiest next week — and the default
answer is "yes, the agent stops," which contradicts the product's own definition of itself
(`package.json:5`, `GOAL_PLAN.md:22`). Answered wrong, the failure is quiet and compounding: the
registry (Phase 3) encodes child-ownership, the release machinery (Phase 5) turns every update
into a massacre of running work, the operator keeps living in the TUI because the TUI at least
only dies when *he* closes it, and the server-Mac milestone — the actual point of Cat Code —
begins by tearing out the supervisor that ~an entire phase was spent building. The program would
not look sunk on any status dashboard; every gate would be green. It would simply have shipped a
very good window onto the wrong architecture.

**How to answer it earliest:** this week, before P1-0 executes — one addendum paragraph to
`decisions/TRANSPORT.md` §4 and the P1-0 brief (DR-1's four points: socket channel, Electron-free
supervisor module, lifetime as explicit D6, Phase-3 reattach gate line). Even if the deliberate
v1 answer is "sessions die with the window" — defensible, and parity with today's TUI — making it
a *decision* with the socket + host-module structure underneath turns the eventual correction
into a feature (attach the window to a daemon; attach a phone to the daemon) instead of a
rewrite of Phase 3. The direction of this migration is right; this is the one place it must be
pointed on purpose rather than by default.

---

*Reviewed cold against `~/cat-code` @ `6365755` (`migration`) and the audit doc set as of
2026-07-02. No file other than this review was modified.*
