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

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| **P1-0** Scaffold: Electron + Bun sidecar + IPC frame | CLAUDE (sys-arch) | 7 | ✅ 2026-07-02 | Empty topology walks. Fresh renderer in `~/cat-code/app/` (React19+Vite+Tailwind v4, P0-2 theme + P0-3 type snapshot re-synced). **IPC = Unix-domain socket** (D6 pin 1 — confirmed NOT stdio/child-IPC; length-prefixed JSON framing). **Supervisor is Electron-free** (`app/supervisor/`, zero `electron` imports; spawn/kill/restart keyed by sessionId — N-ready map). Sidecar (`app/sidecar/`) builds the real `AppSessionController` via `createQueryEngineSessionController` (same class CLI builders wrap), raw-forwards `AppSessionEvent` (NOT `appSessionEventMapper`). **tool_use frame round-trips sidecar→supervisor→main INTACT** (name+structured input preserved) — proven by `bun test app/` (25 pass) AND a real `electron .` smoke (`[main-smoke] frame event message`). Protocol v1 has a `sessionId` slot (F3). Security baseline ON: sandbox/contextIsolation/nodeIntegration-off, CSP, nav+window.open lockdown, default-deny 4-channel preload. **T4** (goalSnapshot→parseThreadGoal safeParse), **T6** (updatedInput echo-only), **T6b** (updatedPermissions stripped on allow), **T7** (frame-size+rate+prompt caps) all implemented + unit-tested. Landmine 1 (JSON-safe assert) + Landmine 2 (clone-on-serialize) handled. ⚠️ macOS `sun_path` 104-byte limit forced short socket dir (`/tmp/catcode-<pid>`). ESLint root config doesn't cover `app/**` yet (Phase-5 CI). dep: P0-1 ✅ |
| **P1-1** Connect, get `app.ready` | ANY | 5 | ✅ 2026-07-03 | Normal Electron startup launches `createRuntimeBackedWebAppSession` → `createQueryEngineAppSession` → real `QueryEngine`; IPC ready payload now carries canonical `type: 'app.ready'`, and renderer shows only `connecting`→`ready` from both discriminants. Probe remains opt-in via `CATCODE_SIDECAR_PROBE=1`; no credentials/turn used. ⚠️ P1-1 temporarily hardcodes cwd `/Users/pt/cat-code`; replace with session-owned cwd in the later shell/session phase. dep: P1-0 ✅ |
| **P1-2** Submit prompt, raw stream | ANY | 4 | ✅ 2026-07-03 | Real credentialed Codex turn completed end-to-end through renderer → Electron IPC → Unix-socket sidecar → `AppSessionController.submit` (no fixture/probe). Raw `<pre>` received 17 SDK messages: `system`, 13 incrementally rendered `stream_event` partial frames, `assistant`, and `result` (`success`); observed nested stream events `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`. First-turn bootstrap now runs engine `init()` + dev `MACRO`; serializer omits undefined optional object fields on its clone while retaining fail-closed JSON/secret guards. dep: P1-1 ✅ |
| **P1-3** First adapter slice (text + tool_use) | CLAUDE (sys-arch) 🖐 GUI | 7 | ✅ 2026-07-03 | **Live-verified by operator (2 runs): real `tool_use` rendered as tool cards** (`Skill` + `Read` w/ full structured `{file_path}` input) + markdown text rows, from a live credentialed Codex turn — rich content survives engine→socket→IPC→projector→UI. Projector entry point = `app/renderer/src/transcriptProjector.ts` (§5 layer 2; reducer over raw `AppSessionEvent`; variants = switch cases to extend; blocks narrowed at runtime, zero casts; W3 domains must plug in via own selectors). Two latent defects found+fixed en route: **(1) sidecar session had `tools: []`** (P1-2 `sessionController.ts` — model literally could not emit tool_use; run-1 proved it live; now `getTools()` from the SAME `toolPermissionContext` the runtime enforces → 28 tools) and **(2) `theme.css` never imported Tailwind** — every utility class since P1-0 silently no-opped (built CSS 1→7 kB once imported). Field note for Phase 2: Codex path emits ONE assistant message PER content block (same msg id) — grouping must not assume 1 msg/turn; `input_json_delta` stream deltas + `tool_result` rows are Phase-2 scope. ⚠️ pre-existing carry-forward: `tsc -p app/sidecar/tsconfig.json` is red independent of this work (include-override drops root `env.d.ts` → `MACRO` unresolved; `strict:true` overlay on engine graph ≈5.7k errors). `bun test app/` 107 pass. dep: P1-2 ✅, P0-2 ✅, P0-3 ✅. |
| **P1-4** One permission round-trip | ANY 🖐 GUI | 6 | 🟡 | **DISPATCHED 2026-07-03** (orchestrator, ∥ with P1-3). Prompt = `backlog/phase0-1.md` P1-4 block. Anchors re-verified live: `AppSessionController.ts` :34/:78/:87/:162 exact; `PermissionPromptToolResultSchema.ts` :47 `updatedInput` + :67-68 deny exact; **fixed drift** `appSessionProtocol.ts` permission.response :35→:33. dep: P1-2 ✅. |

## PHASE 2 — transcript spine + first domain (Permissions)
Gate: real multi-tool transcript renders; a real permission approved/denied through UI. **Sessions not generated yet** — split when Phase 1 gate passes.

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| _(to be generated after Phase 1 gate)_ | — | — | ⬜ | generate from INVENTORY W3 + W4-Permissions rows; stamp 🧠 tags. |

## PHASE 3 — shell + multi-session build-out
Gate: two real sessions in one window, each its own engine process, switchable, app-owned registry. **Sessions not generated yet.**

| Session | Model | Diff | Status | Note |
|---|---|---:|---|---|
| _(to be generated when Phase 3 opens)_ | — | — | ⬜ | INVENTORY W2 rows; D1 registry decision required first. |

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
