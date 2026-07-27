# Test-evidence quality audit — 2026-07-26

**Verdict: YELLOW — the repository has substantial and often excellent tests,
but the suite is not consistently sufficient evidence for live renderer,
restore, process, and runtime-lifecycle claims.**

The dominant problem is not test quantity. It is **proof depth**: a test often
proves a helper, fixture, source string, in-memory boundary, or same-process
simulation while the material production join remains one layer higher.
Engine identity/concurrency and desktop sidecar-boundary work frequently meet a
high bar. Renderer interaction and web lifecycle work do not.

This is a review report only. It does not implement the recommendations or
change STATUS.

## Scope and method

Audit window: **2026-05-26 through 2026-07-26**, inclusive. The comparison base
is `4f200c5a3d9911c53ca6aa10680554abaf61a070` (2026-05-23), the last commit
before the window. The audit intentionally did not read every test file.

The review used four evidence lanes:

1. Git-history inventory of test attachment, paths added/touched, and net test
   churn under `src/`, `app/`, `web/`, and `scripts/`.
2. A stratified source sample across engine identity/concurrency, tools,
   desktop host/sidecar/protocol, renderer state/components, and the web client.
3. Re-examination of historical defects and cold reviews to determine whether
   green tests had actually caught the production failure.
4. Focused test execution on representative clean paths. Passing counts were
   treated as execution evidence only, not as proof that the asserted behavior
   was sufficient.

Each material test was judged using the repository cold-review gate:

- Which production entry point does it exercise?
- What exact pre-fix failure would it catch?
- Does it cover pairwise/composed states, not only one axis?
- Which GUI, live-client, process, timing, or concurrency layer remains
  unverified?
- For identity/concurrency, does it cover the applicable missing, unknown,
  stale, duplicate, two-actor, and ordering cases?

The working tree contained unrelated user work during the review. Historical
counts use committed `HEAD`; the report does not evaluate or claim ownership of
those unrelated changes.

## Quantitative signal

| Measure | Result | Interpretation |
|---|---:|---|
| Commits in the window | 432 | Large change volume |
| Unique test paths touched | 253 | Broad test activity |
| Unique test paths added during the window | 209 | Significant suite expansion |
| Net committed test diff vs the base | 243 files, +57,278 / -598 lines | Test quantity is not the constraint |
| Non-merge source-bearing commits with a conventional test path | 231 / 265 (87.2%) | Strong attachment, but attachment does not measure adequacy |
| Same attachment measure, 2026-05-26 through 2026-06-30 | 43 / 57 (75.4%) | Earlier baseline |
| Same attachment measure, 2026-07-18 through 2026-07-26 | 54 / 59 (91.5%) | Clear recent improvement |

The commit measure is deliberately conservative and mechanical: a
source-bearing commit changes a non-`*.test.*`/`*.spec.*` path under the four
scopes, and a test-attached commit also changes a conventional test path.
Test-support fixtures whose names do not follow those suffixes remain in the
denominator, so the percentage is a lower-bound indicator rather than a
quality score.

No current `test.only`, `describe.only`, `test.skip`, or `test.todo` marker was
found in the inspected scopes. That is healthy hygiene, but it does not address
the proof-depth findings below.

## What is already strong

The repository contains several patterns worth turning into the default:

- `src/codex-core/accountRefreshContention.probe.test.ts:340-716` uses two real
  Bun processes, a deterministic file barrier, a strict rotate-once server,
  and assertions on both contenders plus durable config/vault state. It covers
  the config, vault, crash/identity, and image-auth compositions rather than
  testing only a lock helper.
- `src/utils/settings/settingsWriteContention.probe.test.ts:116-146` calls the
  real production persistence path from two processes sharing one settings
  file and asserts that both distinguishable rules survive.
- `src/services/api/codexTokenRefresh.test.ts:108-703,706-1271` exercises a
  meaningful identity and refresh-state matrix, including identity mismatch,
  transport ambiguity, durable state, and concurrency behavior.
- `src/tools/SendMessageTool/SendMessageTool.test.ts:832-1095` enters through
  the public tool call and covers absent, idle, ambiguous, partial-broadcast,
  stale, and authority-loss cases rather than testing only a resolver helper.
- `app/sidecar/sidecarServer.test.ts:1-35` accurately describes its proof level:
  a real `AppSessionController` over an injectable in-memory framed socket. It
  is strong boundary evidence without pretending to be a subprocess test.
- `app/host/registry.test.ts:430-460` pins the exact historical 32-row failure
  with a literal historical bound, while `app/host/host.test.ts:574-595`
  separately protects the live-process cap. This is a good example of an exact
  regression plus a pairwise invariant.

These examples show that the project already knows how to write high-confidence
tests. The gap is consistency and workflow enforcement.

## Area assessment

| Area | Assessment | Evidence boundary |
|---|---|---|
| Engine security, identity, and concurrency | Strong | Frequently uses real public entry points, real processes, durable state, barriers, and identity matrices |
| Desktop host, sidecar, and protocol | Strong with follow-ups | Good layered boundary/process probes; the complete restore acceptance remains partly live-GUI-only |
| Renderer markup and pure reducers | Strong for their stated layer | SSR and pure-state assertions are fast and useful |
| Renderer interaction and transitions | **Insufficient** | No DOM mount/event/effect/rerender harness |
| Web runtime lifecycle | **Insufficient to moderate** | Helper coverage exists; hook/socket lifecycle is not exercised |

## Findings

### F1 — High — SECOND STRIKE — renderer interaction has no automated harness

**Defect.** At committed `HEAD`, all 31 renderer `*.test.tsx` files use
`renderToStaticMarkup`; none mounts a live DOM tree and drives click, keyboard,
focus, effect, or rerender behavior.

**Evidence.**

- `app/renderer/src/AccountsPage.test.tsx:21-31` explicitly records that the
  package has no DOM harness and that live click/effect behavior is exercised
  only in the running app.
- `app/renderer/src/AskQuestionFlow.test.tsx:39-43` states that the keydown
  handler and active-pane gate are not exercised.
- `app/package.json:19-32` contains no jsdom, happy-dom, React Testing Library,
  or equivalent DOM test dependency.
- `docs/migration/reviews/2026-07-12-phase4-review.md:252-258` already called
  this a systemic blind spot after several headless-green interaction and
  transition defects. The harness is still absent, so this is a second strike.

**Concrete failure.** A control can continue rendering the expected label and
ARIA attributes while its click handler is disconnected, a keydown listener
fires in every split pane, or a pending state never rerenders to error. Every
SSR assertion remains green.

**Disposition.** **React now.** Proposed owner session:
`renderer-dom-test-harness`. Add the smallest approved DOM harness and a narrow
interaction suite covering at least navigation click, composer/flow keyboard
gating, an effect-driven result, and a pending-to-error rerender. Dependency
addition requires operator approval under `CLAUDE.md`.

### F2 — High — durable automated restore evidence does not retain the full gate

**Defect.** The live restore behavior was previously accepted with strong GUI
and on-disk evidence, but the checked-in automated probes do not preserve the
full two-session anti-Potemkin contract. A future regression can therefore
remain headless-green until another live gate run.

**Evidence.**

- `docs/migration/backlog/phase3.md:944-958` requires two live sessions, clean
  quit and host crash, restored context, the same `engineSessionId`, a new
  engine PID, and a post-restore answer depending on a pre-quit fact.
- `app/sidecar/resumeSeed.probe.test.ts:1-15` uses one minted transcript and
  explicitly leaves the credentialed answer-from-context proof to the P3-8
  gate.
- `app/host/lifetimeChain.probe.test.ts:129-151` carries one registry row and
  uses a registry-side sentinel for transcript existence. It proves a valuable
  chain, but not two-session identity/PID/context composition.
- `docs/migration/STATUS.md:172` records the exact escape: the synthetic
  fixture lacked a trailing system diagnostic, so the probe passed while live
  restore selected the wrong leaf and lost prior context.

**Concrete failure.** Tip selection, registry composition, or PID/session
threading regresses for realistic transcripts with trailing diagnostics. A
single synthetic transcript still resumes and echoes its ID, while one or both
real restored sessions have no usable context.

**Disposition.** **React now.** Proposed owner session:
`restore-anti-potemkin-probe`. Build a two-session process probe with distinct
markers, realistic trailing diagnostic/sidechain shapes, stable
`engineSessionId`, changed PID, and the production transcript resolver. Keep
credentialed answer generation explicitly `UNVERIFIED` unless the operator
runs the live gate; do not replace that remaining layer with replay evidence.

### F3 — Medium — “terminal-barrier failure” tests fail before the durable barrier

**Defect.** Two tests named for a terminal durable-barrier failure actually
fail in the result-entry validator before
`flushCurrentTranscriptDurably()`.

**Evidence.**

- `src/services/deferredContinuationRunner.test.ts:143-162` explicitly states
  that the test never reaches the durable barrier.
- `src/services/deferredContinuation.test.ts:681-694` records the same
  mechanism for the foreground path.

The comments are commendably honest, and the tests validly pin the common
“leave submitted for reconciliation” transition. The names and acceptance
surface nevertheless overstate what is protected.

**Concrete failure.** The validator remains correct while the real terminal
flush stops running, targets the wrong transcript, or mishandles a sync error.
Both named tests remain green.

**Disposition.** Proposed owner session:
`deferred-continuation-barrier-evidence`. Retain or rename the existing tests
as post-turn persistence-failure tests, then add a materialized transcript with
test persistence enabled and inject the failure at the actual durable barrier.

### F4 — Medium — a sampled startup migration has no direct regression test

**Defect.** The retired-model migration rewrites several persistent settings
surfaces and is wired into startup, but no test directly references its
production function.

**Evidence.**

- Definition: `src/migrations/migrateRetiredGptModelsToGpt56.ts:22`.
- Startup import/call: `src/main.tsx:188,345`.
- `rg 'migrateRetiredGptModelsToGpt56' --glob '*.test.ts'
  --glob '*.test.tsx'` returns no test reference.

**Concrete failure.** One settings surface or override retains a retired model,
the migration ceases to be idempotent, or the startup call is removed. Build
and adjacent model tests can remain green while users repeatedly start with
stale configuration.

**Disposition.** Proposed owner session: `gpt56-migration-regression`. Exercise
the migration entry point against each affected surface, mixed old/new state,
and a second idempotent run. Add a small wiring tripwire for the startup call;
do not treat that tripwire as a substitute for the functional migration test.

### F5 — Medium — same-process isolation tests must not count as process evidence

**Defect.** `multiSessionIsolation.probe.test.ts` models processes by resetting
module globals sequentially. That is useful unit evidence but not evidence of
OS-process kill, survivor behavior, or inter-process timing.

**Evidence.**

- `src/app-runtime/multiSessionIsolation.probe.test.ts:201-220` calls
  `resetStateForTests()` and labels each sequential call a fresh process.
- `src/app-runtime/multiSessionIsolation.probe.test.ts:229-242` models a crash
  as one controller turn throwing while the other controller remains in the
  same runtime.

**Concrete failure.** A real process inherits unexpected environment/state,
holds an open resource, exits its sibling through shared supervision, or races
cleanup differently. The simulation stays green.

**Disposition.** **Named owner or explicit waiver.** On the next
process-isolation change, either replace this acceptance use with `Bun.spawn`
children and a deterministic barrier, or classify the current file explicitly
as same-process namespace simulation and cite a separate real-process probe for
process claims.

### F6 — Medium — source-string guard tests are useful tripwires, not complete callers

**Defect.** The preload test titled “every fixed renderer-to-main sender passes
through the shared IPC guard” checks named source strings and an aggregate
`sendGuard.assertAllowed` count rather than executing every sender.

**Evidence.** `app/preload/preloadSource.test.ts:4-78` checks sender signatures,
channel constants, and an aggregate count of 26 guard calls.

**Concrete failure.** A new payload-bearing sender is added without a guard.
The existing 26 guard calls and all named strings remain present, so the test
passes. A source rewrite that preserves the searched strings but changes
execution order can also evade it.

**Disposition.** Keep this fast tripwire, but rename/describe its proof level
accurately and pair it with executable bridge-caller tests or a structural AST
check that enumerates actual payload-bearing sender bodies. Owner: the next
preload/boundary session.

### F7 — Medium — web coverage stops at reconnect-delay calculation

**Defect.** The web hook test covers the pure backoff helper, not the socket
lifecycle implemented by the hook or its integration into the app.

**Evidence.**

- `web/src/hooks/useWebSocket.test.ts:3-21` imports and tests only
  `getReconnectDelayMs`.
- `web/src/hooks/useWebSocket.ts:27-96` owns connect, message, error,
  disconnect, timer cleanup, reconnect, and send state.

**Concrete failure.** Reconnect schedules twice, a stale socket wins, cleanup
leaks a timer, a received message never reaches state, or `send` uses a closed
socket. Backoff-helper tests remain green.

**Disposition.** Proposed owner session: `websocket-lifecycle-test`. Extract a
small socket state machine if needed and use fake time plus a fake WebSocket to
cover connect → message → disconnect → reconnect → submit. Add one App-level
integration assertion for the state handoff.

## Historical pattern: green was sometimes camouflage

The two-month history supplies stronger evidence than a style-only review:

- `docs/migration/reviews/2026-07-03-phase1-build-test.md:67-101` found that
  normal startup could restore `tools: []` while fixture/probe tests stayed
  green because the real tool-list wiring was not asserted.
- `docs/migration/reviews/2026-07-04-phase2-review.md:228` found four
  acceptance-fixture samples with shapes the engine could not emit; one masked
  a real empty web-search result display.
- `docs/migration/reviews/2026-07-05-postmortem.md:72-94` catalogued the local
  signature: a forged-session rejection test sent a valid ping, copied policy
  was tested instead of production policy, and impossible fixtures produced
  reassuring results.
- `docs/migration/reviews/2026-07-12-phase4-review.md:252-258` found five
  interaction/transition/live-path defects that were all headless-green.
- `docs/migration/STATUS.md:172` records the restore regression that synthetic
  data did not expose but the anti-Potemkin live gate did.

The trend is improving: current real-process contention probes, explicit
comments about unverified layers, and exact historical regression locks are
materially better than the early-window examples. The remaining workflow
should standardize those stronger habits before implementation, rather than
depending on cold review to discover weak evidence afterward.

## Evaluation of the proposed mechanisms

| Proposal | Decision | Reason |
|---|---|---|
| Create a test-writing skill | **Adopt** | Correct semantic core and portable across agent runtimes |
| Force a dedicated agent to write every test | **Reject as a blanket rule** | Adds latency/conflicts and can reproduce the same shallow proof with a second model |
| Force a dedicated test author for high-risk changes | **Adopt** | Separates contract/reproduction from implementation and reduces patch-mirroring |
| Keep an independent verifier after implementation | **Adopt** | Test author and implementer should not approve their own evidence |
| Add only more prose to `CLAUDE.md` | **Insufficient alone** | The repository already has good prose that did not prevent the recurring escapes |
| Require a test file on every change | **Reject** | Test attachment is already high; it measures presence, not production-path proof |
| Use coverage percentage or blanket snapshots as the gate | **Reject** | Both reward exercised lines/shapes without proving the historical failure |
| Ban source-string tests | **Reject** | They are valuable tripwires when honestly classified and paired with executable proof |

## Proposed `writing-cat-code-tests` skill

### Trigger

Use when an agent:

- writes or edits a test;
- fixes a bug or changes user-visible behavior;
- changes security, protocol, provider, persistence, identity, concurrency,
  process, session-state, GUI-transition, or heuristic-evaluator behavior; or
- is asked to add regression coverage.

Pure documentation edits and mechanical test renames do not trigger it.

### Required workflow

1. State the behavioral contract and exact reachable failure.
2. Identify the production entry point before selecting the test seam.
3. Demonstrate red-before-green, or perform a bounded mutation/revert proving
   that removing the load-bearing guard/join/barrier makes the test fail.
4. Cover success, failure, boundary, and pairwise/composed states that matter.
5. For concurrency/identity, use real barriers where timing matters and cover
   the applicable correlation matrix.
6. Classify the highest proven layer:
   `helper | caller/wiring | process | DOM | GUI | credentialed-live`.
7. Mark every higher required layer `UNVERIFIED`; never imply it passed.
8. Run the area-specific battery from `verifying-cat-code-changes`.

### Required handoff block

```text
TEST EVIDENCE
- Claim:
- Exact pre-fix failure:
- Production entry point:
- Test path:
- Proof layer:
- Red/mutation evidence:
- Pairwise/adversarial cases:
- UNVERIFIED:
- Commands and outcomes:
```

Keep the semantic contract in the skill. Add only a short routing rule to
`CLAUDE.md`; copying the whole checklist into multiple prompt surfaces will
drift.

## Dedicated-agent design

Use two separate roles:

1. **`test-author` before implementation** for high-risk work. It receives the
   contract and existing repository state but not an implementation patch. It
   owns test files only and must show the exact pre-fix failure.
2. **`verification` after implementation**, independent and read-only. It
   verifies the production entry point, reruns the evidence, attempts at least
   one adversarial mutation/probe, and reports `PASS | FAIL | PARTIAL`.

Force the pre-implementation test author for:

- security/authentication/protocol/provider boundaries;
- persistence, restore, session-state, and cross-process behavior;
- identity, authority, allocation, settlement, or correlated results;
- GUI interaction/transition behavior;
- heuristic evaluators whose false pass changes orchestration; and
- bug fixes without an existing exact reproduction.

Let the implementer own ordinary pure-helper and small local tests. Invoke the
independent verifier when the change is material or the proof layer is above a
pure helper.

The repository already contains a strong adversarial verifier:
`src/tools/AgentTool/built-in/verificationAgent.ts:12-42,220-239`. It is
read-only by design. The hard mandatory-spawn contract is currently gated by
`VERIFICATION_AGENT` plus `tengu_hive_evidence`, whose default is false:
`src/constants/prompts.ts:476-480`. Strengthen and risk-gate this existing
verifier; do not turn it into the writer and destroy role independence.

## Deterministic enforcement

A model-judged skill is not enforcement. Use layered enforcement:

1. **Semantic layer:** the skill and independent verifier judge production
   entry, exact failure, composition, and proof honesty.
2. **Agent-runtime layer:** a Stop/SubagentStop hook blocks completion of a
   high-risk implementation when the required `TEST EVIDENCE`, verifier
   verdict, or explicit waiver is absent.
3. **Repository layer:** a tracked command checks only machine-verifiable
   facts—no focused/disabled tests, declared commands executed, and required
   evidence/waiver present. It must not pretend to judge semantic adequacy.

The normal root build gate currently contains no test command
(`package.json:14-22`). Adding a targeted test-routing gate is therefore more
useful than demanding a bare whole-repository `bun test`, which this repository
explicitly does not support because some account suites require file isolation.

## Structural and testing recommendations

Priority order:

1. **P0 — add the minimal renderer DOM harness.** Process changes cannot
   compensate for a missing test capability.
2. **P1 — add `writing-cat-code-tests` and its evidence block.**
3. **P1 — copy the cold-review test-confidence gate into the independent
   verifier's actual decision criteria.**
4. **P1 — add the risk-gated pre-implementation `test-author`.**
5. **P1 — require bounded mutation evidence for high-risk regression tests.**
6. **P2 — add a tracked test-routing/evidence check and Stop-hook enforcement.**
7. **P2 — split the largest test files by behavioral contract when next
   touched.** File length is not a correctness defect, but multi-thousand-line
   suites make it harder to see duplicated setup, unreachable branches, and
   which production entry point each block protects.

Do not globally rewrite existing tests. Apply the stronger contract when a
test is touched, and react immediately only where the reachable consequence
justifies it—F1/F2 first.

## Proposed evaluation before full enforcement

Build a 12–16 case historical defect corpus from known escapes, including:

- normal startup `tools: []`;
- forged-session test that sent a valid ping;
- impossible web-search/tool-result fixture;
- null trust snapshot;
- pending-to-error renderer transition;
- slash-command catalog wiring;
- restore with a trailing system diagnostic;
- active-index/split-layout restoration;
- settings-write lost update;
- account allocation/refresh contention;
- registry-row bound vs live-process cap; and
- one or two legitimate helper-only/GUI-only waivers.

Run the same model and effort under three conditions:

- **A:** current workflow;
- **B:** skill plus required evidence block;
- **C:** B plus risk-gated test author and independent verifier.

Blind-score production-entry coverage, exact seeded-defect kill, pairwise and
adversarial coverage, mutation kill, honest `UNVERIFIED` reporting, false
blocks, wall time, token cost, conflicts, and rework. Run ten tasks in shadow
mode, then twenty high-risk tasks with enforcement. A reasonable adoption rule
for the extra test-author hop is at least a 10-percentage-point mutation-kill
improvement over B with no more than 35% median wall-time overhead; adjust that
threshold if real task value warrants a different cost tradeoff.

## Final recommendation

Adopt the skill, but do not rely on it alone. Use a **risk-gated,
pre-implementation test author**, retain a **different independent verifier**,
and add objective hook/repository enforcement. The first engineering investment
should be the renderer DOM harness, because no prompting topology can test
interaction behavior with an SSR-only toolbox.

The suite is good enough to provide strong engineering signal. It is not yet
good enough to treat every green result as acceptance evidence without first
classifying the production entry point and highest layer actually proven.

## Verification

Audit-time focused execution:

```text
- bun test app/main/mainSource.test.ts app/preload/preloadSource.test.ts web/src/appState.test.ts
  → 31 pass / 0 fail
- bun test app/sidecar/spawnConfig.probe.test.ts
  → 4 pass / 0 fail
- bun test app/host/lifetimeChain.probe.test.ts
  → 1 pass / 0 fail
- bun test src/codex-core/accountRefreshContention.probe.test.ts
  → 5 pass / 0 fail
- bun test src/utils/settings/settingsWriteContention.probe.test.ts
  → 1 pass / 0 fail
```

Independent stratified samples also returned 134 pass / 0 fail across eleven
engine files and 265 pass / 0 fail across twelve desktop/web files. These sets
can overlap the focused list and are not summed.

```text
VERIFICATION
- git diff --check
  → clean for tracked working-tree changes
- git diff --no-index --check /dev/null
  docs/reports/2026-07-26-test-evidence-quality-audit.md
  → no whitespace errors (exit 1 is the expected new-file diff status)
- cited-path existence sweep
  → all cited repository paths exist
Stale-reference sweep: N/A — no rename, removal, or interface change
Not run: full ENGINE/DESKTOP/WEB batteries — report-only DOCS change; the
         applicable repository battery is git diff --check
Not run: GUI/credentialed restore acceptance — no product behavior changed;
         those layers remain explicitly UNVERIFIED where discussed above
```

## Disposition addendum — 2026-07-27

Recorded after operator review of the program; the audit body above is
unchanged history. Per-unit closure lives in
`docs/test-evidence/2026-07-26-program-backlog.md`.

**Adopted and landed:**

- `writing-cat-code-tests` skill, rewritten to a lightweight form (no
  mandatory evidence template, no forced test-author/verifier roles) and
  republished 2026-07-27 to the Claude Code and Cat Code mirrors (canonical
  hash `d8652b01…`); Codex reads the canonical `~/.agents` source directly.
- F2 — two-session restore anti-Potemkin process probe: `9bb3a3c`, hardened
  in `10dfe33`.
- F3 — deferred-continuation actual durable-barrier regression: `bda89ee`.
- F4 — retired-GPT-model migration matrix plus startup tripwire: `381585e`.
- F5 — real-process sidecar kill/survivor evidence: `2cb6217`.

**Deliberately not pursued (operator decision, 2026-07-27):**

- F1/F7 — the `happy-dom` DOM harness and renderer/WebSocket interaction
  suites. Renderer interaction stays SSR-plus-live-GUI verified.
- Mandatory independent-verifier spawning (the hard-off flag conditions
  stand).
- The measured A/B/C shadow-evaluation program beyond the read-only TE-10
  pilot.
- Stop/SubagentStop hook enforcement and repository evidence checks.
- Enforcement thresholds and the policy around them.

F6 keeps its in-finding disposition: the source-string test stays as an
honestly classified tripwire, owned by the next preload/boundary session.
