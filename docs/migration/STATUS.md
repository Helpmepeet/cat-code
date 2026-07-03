# CatCode migration — STATUS dashboard

**This is the single source of truth for "what's done."** A session asked to report migration
progress reads THIS file first. When a session finishes a unit of work, it updates the row here
(status + date + one-line note) as its last step.

Status legend: ⬜ not started · 🟡 in progress · ✅ done · 🛑 blocked
Model tag: **CLAUDE** = visual-design / system-architecture judgment · **ANY** = model-agnostic.
Difficulty: 1–10 (operator picks reasoning effort from it).
**🖐 GUI** = stamped only on sessions whose verification needs the operator to drive a live
GUI/browser step (launch the Electron app, click, keypress); absent = fully headless-verifiable.

> **When a phase's sessions are all ✅, the next phase's backlog gets generated** (per
> PROGRAM-PLAN §8) — with the 🧠 Model/Difficulty tag stamped on every task it produces.
> Phases 2–5 are NOT split into sessions yet; they appear here only as coarse rows until opened.

---

## PHASE 0 — topology bake-off + foundations
Gate: topology chosen w/ packaged evidence (P0-1 ✅) · scaffold builds with tokens (P0-2 ✅) ·
types importable (P0-3 ✅) · **multi-session isolation known (P0-4 ✅)** · **security minimum drafted (P0-5 ✅)**.
→ **✅ GATE CLEARED WITH CAVEATS 2026-07-02** (whole-phase cold review: `reviews/2026-07-02-phase0-review.md`).
The two load-bearing decisions (Electron+Bun sidecar/IPC; N-process) survived adversarial attack and
are NOT reopened. But the review found handoff defects now **fixed in the backlog**: F1 (P1-0's
security line pointed at a stale ID — SECURITY-MINIMUM was orphaned) and F2 (code-home specified 3
contradictory ways). Carry-forward into P1-0/Phase-3 tracked in the backlog + review doc.
**Phase 1 (P1-0) is open.**

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| **P0-1** Transport/topology bake-off | CLAUDE (sys-arch) | 9 | ✅ 2026-07-02 | **Electron + Bun sidecar (IPC, raw `SDKMessage`)**. Packaged probes: raw-forwarding preserves `tool_use`, current mapper drops it; N-sidecar spawn + crash-restart proven; `bun --compile` binary (real engine ~159MB) runs + codesigns. (c) loopback-WS eliminated. Engine=Bun-only re-confirmed. **Adversarial review passed** (§6): decision stands; transport contract tightened to JSON-safe payloads; `emit()` aliasing + anchor fix noted. → `decisions/TRANSPORT.md`. |
| **P0-2** Design tokens → Tailwind | ANY | 3 | ✅ 2026-07-02 | Portable Tailwind-v4 `@theme` layer + Vite smoke harness in `renderer-theme/`; build verified, accent remains themeable via `--accent`; unresolved tone hexes are explicit TODOs for P1-0. |
| **P0-3** Engine TS types importable | ANY | 4 | ✅ 2026-07-02 | Portable type-only renderer aliases + fixture in `scripts/typecheck/renderer-engine-types/`; strict typecheck verified. Direct source aliases pull in the non-isolated engine graph, so the cited commit-`234da9e` snapshot fallback requires P1-0 re-sync. |
| **P0-4** Multi-session isolation probe | ANY | 6 | ✅ 2026-07-02 | **VERDICT: N-process** (each session = its own engine process; single-process needs an out-of-scope engine refactor). The 1-proc **stomp is real** (A saw B's cwd) — the forcing state that makes N-process mandatory: `STATE` singleton `state.ts:435`, `STATE.cwd`/`STATE.sessionId` mutated per-submit via `setCwd` `QueryEngine.ts:245`. Perm round-trip is instance state (isolated even 1-proc). ⚠️ **Scope (per PHASE0-REVIEW F-A):** the "2-proc isolates" rows are *sequential in-process emulation* via `resetStateForTests()`, and P0-1's 3-process spawn only printed READY — **two real engines never ran concurrent work**. N-process *sufficiency* over shared EXTERNAL state is assumed, not proven; concrete unexamined race → **Codex token refresh rotates the refresh token with no cross-process lock (`codex-core/accounts.ts:150-180`) — Phase-3 carry-forward.** Probe re-run (4 pass/17 assert) + anchors re-verified. → `decisions/TRANSPORT.md` §P0-4; test `src/app-runtime/multiSessionIsolation.probe.test.ts`. |
| **P0-5** Boundary-security minimum | CLAUDE (sys-arch) | 7 | ✅ 2026-07-02 | Threat model + **default-deny IPC allowlist** (4 msg types only, no raw command/FS passthrough, no self-approval) + **secret owner = engine only** (`auth.ts`, `codex-core/accounts.ts`; renderer sees redacted status). Renderer hardening = P1-0 acceptance criteria. Flagged 3 real source holes for P1-0: `goalSnapshot` `z.unknown()` → session identity (T4), `updatedInput` command-rewrite on allow (T6), no length caps (T7). **Orchestrator scrutinized doc + re-verified T4/T5a/T6 anchors.** → `decisions/SECURITY-MINIMUM.md`. |

✅ **P0 IDs are now unique across all docs** (fixed 2026-07-02): P0-1 topology · P0-2 tokens ·
P0-3 types · P0-4 isolation · P0-5 security. No label means two things anymore.
**✅ Phase-0 gate CLEARED 2026-07-02** — P0-4 (isolation, verdict N-process) and P0-5 (security)
both ✅ and independently verified by the orchestrator (P0-4 probe re-run; P0-5 doc + anchors
scrutinized). The multi-session existential risk is **retired**. **Phase 1 (P1-0) opens.**

## PHASE 1 — walking skeleton
Gate: the seam *walks* — connect → render one real `tool_use` → prompt → resolve one permission. P0-1 ✅ (unblocked); topology = Electron + Bun sidecar, raw `SDKMessage` over IPC.
→ **✅ GATE CLEARED 2026-07-03.** A live unallowlisted `Bash("date")` paused on the real
`permission.requested`, resumed after the operator allowed it from the renderer, returned a
successful tool result, and completed the turn. **Phase 2 opens; generate its backlog next in a
separate session per PROGRAM-PLAN §8.**

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| **P1-0** Scaffold: Electron + Bun sidecar + IPC frame | CLAUDE (sys-arch) | 7 | ✅ 2026-07-02 | Empty topology walks. Fresh renderer in `~/cat-code/app/` (React19+Vite+Tailwind v4, P0-2 theme + P0-3 type snapshot re-synced). **IPC = Unix-domain socket** (D6 pin 1 — confirmed NOT stdio/child-IPC; length-prefixed JSON framing). **Supervisor is Electron-free** (`app/supervisor/`, zero `electron` imports; spawn/kill/restart keyed by sessionId — N-ready map). Sidecar (`app/sidecar/`) builds the real `AppSessionController` via `createQueryEngineSessionController` (same class CLI builders wrap), raw-forwards `AppSessionEvent` (NOT `appSessionEventMapper`). **tool_use frame round-trips sidecar→supervisor→main INTACT** (name+structured input preserved) — proven by `bun test app/` (25 pass) AND a real `electron .` smoke (`[main-smoke] frame event message`). Protocol v1 has a `sessionId` slot (F3). Security baseline ON: sandbox/contextIsolation/nodeIntegration-off, CSP, nav+window.open lockdown, default-deny 4-channel preload. **T4** (goalSnapshot→parseThreadGoal safeParse), **T6** (updatedInput echo-only), **T6b** (updatedPermissions stripped on allow), **T7** (frame-size+rate+prompt caps) all implemented + unit-tested. Landmine 1 (JSON-safe assert) + Landmine 2 (clone-on-serialize) handled. ⚠️ macOS `sun_path` 104-byte limit forced short socket dir (`/tmp/catcode-<pid>`). ESLint root config doesn't cover `app/**` yet (Phase-5 CI). dep: P0-1 ✅ |
| **P1-1** Connect, get `app.ready` | ANY | 5 | ✅ 2026-07-03 | Normal Electron startup launches `createRuntimeBackedWebAppSession` → `createQueryEngineAppSession` → real `QueryEngine`; IPC ready payload now carries canonical `type: 'app.ready'`, and renderer shows only `connecting`→`ready` from both discriminants. Probe remains opt-in via `CATCODE_SIDECAR_PROBE=1`; no credentials/turn used. ⚠️ P1-1 temporarily hardcodes cwd `/Users/pt/cat-code`; replace with session-owned cwd in the later shell/session phase. dep: P1-0 ✅ |
| **P1-2** Submit prompt, raw stream | ANY | 4 | ✅ 2026-07-03 | Real credentialed Codex turn completed end-to-end through renderer → Electron IPC → Unix-socket sidecar → `AppSessionController.submit` (no fixture/probe). Raw `<pre>` received 17 SDK messages: `system`, 13 incrementally rendered `stream_event` partial frames, `assistant`, and `result` (`success`); observed nested stream events `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`. First-turn bootstrap now runs engine `init()` + dev `MACRO`; serializer omits undefined optional object fields on its clone while retaining fail-closed JSON/secret guards. dep: P1-1 ✅ |
| **P1-3** First adapter slice (text + tool_use) | CLAUDE (sys-arch) 🖐 GUI | 7 | ✅ 2026-07-03 | **Live-verified by operator (2 runs): real `tool_use` rendered as tool cards** (`Skill` + `Read` w/ full structured `{file_path}` input) + markdown text rows, from a live credentialed Codex turn — rich content survives engine→socket→IPC→projector→UI. Projector entry point = `app/renderer/src/transcriptProjector.ts` (§5 layer 2; reducer over raw `AppSessionEvent`; variants = switch cases to extend; blocks narrowed at runtime, zero casts; W3 domains must plug in via own selectors). Two latent defects found+fixed en route: **(1) sidecar session had `tools: []`** (P1-2 `sessionController.ts` — model literally could not emit tool_use; run-1 proved it live; now `getTools()` from the SAME `toolPermissionContext` the runtime enforces → 28 tools) and **(2) `theme.css` never imported Tailwind** — every utility class since P1-0 silently no-opped (built CSS 1→7 kB once imported). Field note for Phase 2: Codex path emits ONE assistant message PER content block (same msg id) — grouping must not assume 1 msg/turn; `input_json_delta` stream deltas + `tool_result` rows are Phase-2 scope. ⚠️ pre-existing carry-forward: `tsc -p app/sidecar/tsconfig.json` is red independent of this work (include-override drops root `env.d.ts` → `MACRO` unresolved; `strict:true` overlay on engine graph ≈5.7k errors). `bun test app/` 107 pass. dep: P1-2 ✅, P0-2 ✅, P0-3 ✅. |
| **P1-4** One permission round-trip | ANY 🖐 GUI | 6 | ✅ 2026-07-03 | **Live-verified by operator:** real `Bash({command:"date", description:"Show current date and time"})` paused for the renderer permission prompt; `Enter` sent allow with required `updatedInput` echo, the tool returned `Fri Jul 3 … 2026`, and the turn resumed to `PERMISSION_ROUNDTRIP_RESUMED` + final `result:success` with zero permission denials. Permission state is separate from the transcript projector; `Enter` allow, `N`/`⌫` deny, `Esc` dismiss; no resolving flash. T6 echo-only and T6b updatedPermissions rejection/strip remain covered by the sidecar boundary tests. Canonical `can_use_tool` mapped cleanly; no unmatched permission variant observed. dep: P1-2 ✅. |

## PHASE 2 — transcript spine + first domain (Permissions)
Gate: real multi-tool transcript renders; a real permission approved/denied through UI.
→ **BACKLOG GENERATED 2026-07-03** (Scenario 2, from INVENTORY W3 + W4-Permissions rows + PROGRAM-PLAN §5/§Phase-2). 5 sessions. P2-0 (projector completeness) is the spine and gates P2-1/P2-2/P2-3; P2-4 (Permissions domain) depends on P2-0+P2-2. P1-3 already seeded `transcriptProjector.ts` (text + one tool_use); Phase 2 hardens it to production + adds the first domain. Prompts pasteable from the rows below.
> ✅ **P2-4 UNBLOCKED 2026-07-03 — the C1–C4 boundary decision is made: `decisions/PERMISSION-BOUNDARY.md`.** The S2 spec (`specs/2026-07-03-S2-permission-update.md`) had found the rich permission protocol could not flow through the IPC boundary (T6b rejects `updatedPermissions`; no mode/read frames). Resolution: **C1** "always allow" = suggestion-**SELECTION** validated at the sidecar (renderer sends `applySuggestions` indices into the request's engine-minted `permission_suggestions`; the sidecar re-attaches the ENGINE's own update objects — renderer never authors rules, T6/T6b intent preserved) — **decided AND implemented + tested at the boundary same day** (`bun test app/` 122 pass); **C2** = `permission.setMode` inbound frame (session destination only, `bypassPermissions` rejected at the boundary) and **C3** = `permission.context` read-only outbound snapshot, both spec'd in the decision for P2-4 to implement; **C4** stays cut (`app.abort` covers it).

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| **P2-0** Projector completeness + exhaustive `SDKMessage` fixture | CLAUDE (sys-arch) | 8 | ⬜ | The spine. §5 requires an exhaustive adapter fixture covering every real `SDKMessage` variant (~19 union members / 15 discriminants, `coreTypes.generated.ts:760`; assistant content / stream events typed `unknown[]`/`unknown` at `:90` → read discriminants WITHOUT casts) before the projector is "done". Extends P1-3's `app/renderer/src/transcriptProjector.ts` from a switch to full coverage; every unhandled variant = a documented `default`, not a crash. Case-by-case conflict checkpoint (§5 layer-2). **Gates P2-1/P2-2/P2-3.** dep: P1-3 ✅. |
| **P2-1** Core transcript rows | ANY | 5 | ⬜ | The `Messages.jsx` core row families → real content blocks: `MessageRow`/`ThinkingBlock`/`RedactedThinkingBlock`/`UserImageRow`/`CommandEchoRow`/`SystemNoticeRow` + markdown via `react-markdown`+`shiki` (`Prose`/`ProseCode`) + boundary rows (`Compact/Snip/SessionInit/Result/Tombstone`). INVENTORY W3 rows (⚓8/⚓1/⚓6), disposition=adapt (real msgs are nested SDK content blocks, not a flat row zoo). dep: P2-0. |
| **P2-2** Tool-card families + `tool_use`/`tool_result` correlation | CLAUDE (sys-arch) | 7 | ⬜ | `ToolCard`+`ToolResultRow` derived by CORRELATING `tool_use`↔`tool_result` by id (status is NOT stored — derived); `DiffView`/`MultiDiffCard`. INVENTORY W3 (⚓4/⚓2), S1. ⚠️ **S1 spec corrections (read `specs/2026-07-03-S1-streaming.md`):** (a) ONE assistant frame per `content_block_stop` for **EVERY provider** (not a Codex quirk — supersedes P1-3's under-scoped field note); correlation must NEVER assume 1 frame/message. (b) **stop_reason/usage trap:** assistant frames arrive `stop_reason:null` and the engine mutates its copy AFTER serialize — read stop_reason/usage from the `message_delta` event + `result` frame ONLY, never the assistant frame. (c) subagent deltas never arrive (`parent_tool_use_id` hardcoded null) — no nested-stream UI. dep: P2-0. |
| **P2-3** Streaming/activity engine | ANY | 6 | ⬜ | Real incremental rendering off `message.delta`/`SDKPartialAssistantMessage` (`Chat.jsx` streaming engine; prototype `runPlaygroundTurn`/timers are demo-only — CUT). Faked (**S1**) → spec-first: confirm delta/partial behavior against source before wiring. **Spec ✅ 2026-07-03: `specs/2026-07-03-S1-streaming.md`** — nested event = Anthropic `RawMessageStreamEvent` verbatim; state keys by `(message.id, index)`; deltas accumulate from `''`; `result` is the ONLY turn-end marker; stream events are droppable garnish (non-streaming fallback yields assistant frames only). dep: P2-0. |
| **P2-4** Permissions domain — real queue + round-trip (the domain-recipe template) | CLAUDE (sys-arch) 🖐 GUI | 7 | ⬜ | **UNBLOCKED 2026-07-03: C1–C4 decided → `decisions/PERMISSION-BOUNDARY.md`** (spec: `specs/2026-07-03-S2-permission-update.md`). C1 "always allow" is decided **and already live at the boundary**: allow may carry `applySuggestions` (indices into THIS request's engine-minted `permission_suggestions`); sidecar validates fail-closed and re-attaches the ENGINE's own update objects (renderer never authors rules — T6/T6b preserved; 7 new boundary tests, `bun test app/` 122 pass). P2-4 implements C2 (`permission.setMode`, session-only, bypass rejected — decision §3) + C3 (`permission.context` snapshot frame — decision §4) + the UI. Build = `PermissionQueue` (`Permissions.jsx` ⚓6) + `PermissionRulesEditor` (`PermissionRules.jsx` ⚓2 — read-only + C1 writes); multiple pendings are real (Map, no timeout); `permission.resolved` = universal dismiss; prototype's `ruleImplication` client-side rule-guessing is a CORRECTNESS BUG → replace with engine `permission_suggestions`, not restyle. C4 (`deny.interrupt`) stays cut — `app.abort` covers it. ⚠ Must also fix: sidecar session loads NO settings rules (`getEmptyToolPermissionContext` — decision §8, same defect class as P1-3's `tools:[]`). **This templates the domain recipe every later W4 domain copies.** **Phase-2 GATE session.** dep: P2-0, P2-2. |

## PHASE 3 — shell + multi-session build-out
Gate: two real sessions in one window, each its own engine process, switchable, app-owned registry. **Sessions not generated yet.**

> ✅ **Phase-3 pre-work DONE — drafted 2026-07-03, independently pressure-tested (subagent
> review, verdicts RED/RED/YELLOW/YELLOW), all Critical/High/Medium findings fixed 2026-07-04.**
> (Parallel track alongside Phase 2 + the P1 review; per
> `reviews/2026-07-02-direction-review.md` these four gate Phase-3 backlog generation, which can
> now consume them.)
> **D1 registry → `decisions/REGISTRY.md`** — host-plane durable *index* over engine-owned
> transcripts (registry loss ≠ data loss); two-id model (`appSessionId` address ↔
> `engineSessionId` transcript key, bridged once per attach); v1 restore = re-spawn + resume
> through the engine's REAL resume machinery (`conversationRecovery.ts:465` /
> `sessionRestore.ts:493` — `switchSession` alone only adopts the id); launch liveness-sweep
> kills orphaned sidecars (v1) and offers restore; single-writer + advisory lockfile + atomic
> writes. **§6.1 executes DR-4**: typed control-plane contract (`CreateSessionRequest` /
> `SessionDescriptor` / `HostErrorCode` / `HostEvent`, five methods) with its trust zone landed
> in `SECURITY-MINIMUM.md` (Addendum 2026-07-04: threat T8 renderer-authored cwd, rules
> HC1–HC4). `concurrentSessions.ts` re-verified ephemeral per-PID (`:64,:77` writes,
> `:186-201` sweep) — liveness idiom only.
> **D6 lifetime → `decisions/SESSION-LIFETIME.md`** — formalizes the 2026-07-02 owner ruling
> (die-with-window v1; behavior, NOT welding — socket + Electron-free supervisor stay
> mandatory). DR-1's "quit+relaunch with turn in flight → re-attach" gate line is **explicitly
> waived for v1**; substitute Phase-3 gate line (§4): quit/relaunch restores both sessions from
> the registry with transcript history (+ crash-sim: orphans reaped, restore still offered),
> with an **anti-Potemkin clause** — restore is proven by a post-restore prompt depending on a
> pre-quit fact + the same `engineSessionId` transcript appended by a new engine PID, not by
> re-rendered JSONL.
> **F3 envelope → `decisions/PROTOCOL-ENVELOPE.md`** — AUDIT (rescoped: envelope already shipped
> P1-0): v1 envelope **SUFFICIENT** for Phase-3 multiplexing; inbound sessionId routing is live
> code (supervisor map + sidecar self-check), NOT a dead slot; unknown-session sends currently
> vanish silently at main (one undifferentiated throw, `supervisor.ts:217-221`); no version
> negotiation (sidecar fails closed per frame). Additive gaps for Phase 3 (no version bump, §6):
> `ReadyFrame.engineSessionId` (do first — unblocks registry), typed forward-failure outcomes
> (`session_not_found` / `session_not_ready` / `session_disconnected`), outbound sessionId
> tripwire, ready-frame **schema** check at attach (version number alone misses additive-field
> skew), per-session replay eviction. P2-4's decided C2/C3 frames acknowledged in E-7.
> **DR-2 shared-state fix → LANDED IN ENGINE, review-hardened** — `src/codex-core/accounts.ts`
> raw refresh branch (config-source / vault-less accounts; NB: `initAccountPool` imports the
> config login as exactly this kind) now has in-process single-flight + cross-process advisory
> lockfile (compromise-guarded, retry budget > worst-case holder) + adopt-under-lock recovery +
> a **durable attempt ledger** (`codex-raw-refresh.state.json`: `in_flight` written BEFORE the
> network spend; crash-after-rotation → probe-once then terminal `reauth_required`; persist
> failure → `unknown`, never silent success; identity-rotation tombstone with
> `rotatedToAccountId`) + typed credential-vs-transport errors in `codex-client.ts` (15s
> timeout; `invalid_grant` no longer reported as "server could not be reached"). Two-REAL-process
> probe `src/codex-core/accountRefreshContention.probe.test.ts` (+ `.probe.child.ts`,
> strict-rotation mock OAuth, fail-closed network): **pre-fix reproduced the clobber**, post-fix
> **4 scenarios green ×3 runs** — config contention (one rotation, both converge), vault branch
> with two real processes, crash-after-rotation (survivor probes once, third process fails fast
> off the tombstone), identity-switch contention (winner adopts new account id, loser gets a
> truthful error, config holds the new identity). The vault path (`refreshAccountTokens`) was
> found ALREADY protected (proper-lockfile + recovery, landed 5a7b744 2026-06-16 — narrows
> DR-2's stated blast radius) and is now **proven with two real processes** (retires P0-4's
> "sufficiency assumed, not proven" caveat for this file). Brokered-vault-access redesign **not
> needed** — zero Phase-1 protocol impact. Same-class NOT solved (flagged only):
> `persistPermissionUpdates` settings writes, `GenerateImageTool.ts:496` raw refresh.

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| _(to be generated when Phase 3 opens)_ | — | — | ⬜ | INVENTORY W2 rows; D1/D6/F3 decided + DR-2 fixed, all four pressure-tested + review findings applied (pre-work note above) — backlog generation unblocked. |

## PHASE 4 — remaining domains (fanned out)
Gate: prototype feature parity (~80% wireable), each surface real. **Sessions not generated yet.**

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| _(to be generated when Phase 4 opens)_ | — | — | ⬜ | INVENTORY W4 rows; most parallel phase. |

## PHASE 5 — production hardening & release
Gate: installable, signed, auto-updating, tested build. **Sessions not generated yet.**

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| _(to be generated when Phase 5 opens)_ | — | — | ⬜ | packaging/signing/perf/a11y/test suite. |

---

## How to update this file (for the finishing session)
1. Flip the session's **Status** (⬜→🟡→✅) and add today's date + a one-line note.
2. If you just cleared a **phase gate**, say so in that phase's header.
3. If you generated the next phase's backlog, add its sessions as rows here **with 🧠 tags**.
