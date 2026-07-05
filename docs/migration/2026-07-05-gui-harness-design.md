# GUI-verification harness — DESIGN (2026-07-05)

**Status: PROPOSED rev 2 — pressure-tested 2026-07-05, all 8 findings applied.**
This is the design answering `2026-07-05-gui-harness-proposal.md` (the requirements
handoff). The proposal's §4 constraints are binding and restated in §6 below with how
each is held. Anchors re-verified against the working tree 2026-07-05 (branch
`migration`, post-`e4a4be6`). Findings from the pressure test are tagged inline
(**PT-1**…**PT-8**); the rulings it issued on rev 1's open questions are in §11.

**Reviewer orientation:** the payload is D1 (picker bypass); D2–D5 ride along. The
whole build adds exactly ONE new preload sender (present only in the DEV preload
bundle — stripped from the packaged bundle at build time, PT-3), ONE new
main-registered channel (dev-double-gated), two new source files, and three new env
flags. No engine-socket change, no registry write-point change, no renderer-authored
path anywhere.

---

## 0. New surface at a glance

| Flag (main-read env) | Gate | Effect |
|---|---|---|
| `CATCODE_TEST_CWD_ALLOWLIST=/d1:/d2` | `!app.isPackaged` AND set | `pickDirectory()` resolves allowlist entries; NSOpenPanel becomes UNREACHABLE while set (PT-6) |
| `CATCODE_INITIAL_CWD=/dir` | `!app.isPackaged` AND set | primary startup session roots here instead of main's `process.cwd()` |
| `CATCODE_DEBUG_STATE=1` | `!app.isPackaged` AND set | main registers the debug-state channel + writes the export file |

All three are resolved ONCE at startup into a frozen `DevHarnessConfig` (no per-call
env reads — a runtime env mutation cannot flip behavior mid-run; when
`app.isPackaged` the config is unconditionally `disabled`). Every activation logs one
loud line at startup; every bypass use logs per-use.

---

## 1. D1 — Trusted-cwd session creation (the picker bypass)

**Mechanism.** In main's `CH_HOST_PICK_DIR` handler (`app/main/main.ts:416-429`):
when the allowlist flag is set (and dev), the handler NEVER calls
`dialog.showOpenDialog` — it resolves the **next allowlist entry** instead.
Everything downstream is byte-identical to a real pick: the dir still goes through
`validateCwd` (realpath + isDirectory + NFC, `main.ts:123-135`), still becomes a
one-time `mintCwdToken` token (`main.ts:488`), still gets consumed by
`createSession` exactly once. The renderer surface is unchanged —
`CreateSessionInput` still cannot express a path (`hostApi.ts:60-65`), and the
renderer cannot tell a bypassed pick from a real one.

**Cursor semantics: cyclic.** The allowlist is a ring; each pick advances and wraps.
A single-entry allowlist therefore yields the same dir on every pick — which is
exactly the P3-5a same-cwd two-session case with the minimal config
(`CATCODE_TEST_CWD_ALLOWLIST=/Users/pt/catcode-gui-scratch`). Rejected alternative:
exhaust-then-fall-through to the real dialog — that recreates the exact mid-run
blocker this exists to kill; and exhaust-then-null makes same-cwd need the dir
listed twice for no gain. (Ruled acceptable, §11.)

**Validation posture: fail CLOSED, never fall back to the dialog (PT-6).** While the
flag is set, the native dialog is structurally unreachable:
- At startup: every allowlist entry is `validateCwd`-checked. ANY invalid entry puts
  the bypass in a `broken` state with a loud stderr line — subsequent picks return
  `null` (= picker-cancelled semantics, which the UI already handles) + loud per-call
  log. They do NOT open NSOpenPanel (rev 1 "disable the whole bypass" would have
  reopened the exact blocker on the next click) and do NOT skip to the next entry
  (a silently shifted cursor creates sessions in the *wrong* dirs — for a
  verification harness, a wrong-cwd session is worse than no session; anti-Potemkin
  applies to the harness itself).
- Per pick: `validateCwd` runs again (the dir may have vanished mid-run); failure
  returns `null` + loud log. Never advance-and-retry, never dialog.
- Per use: `[main] DEV picker bypass -> <realpath> (<i>/<n>)` on stderr.

**`CATCODE_INITIAL_CWD` (the subsumed sugar).** Main already creates the primary
startup session from its own `process.cwd()` (`main.ts:664-675`) — but the dev
launcher spawns Electron with `cwd: appRoot` (`scripts/dev.ts:33-37`), so today the
primary session ALWAYS roots at `~/cat-code/app` regardless of where the operator
launched from. That is why the verifier asked for this. Implementation: in
`ensureHost`, the primary-session cwd is `config.initialCwd ?? process.cwd()`,
`validateCwd`-checked. An invalid `CATCODE_INITIAL_CWD` logs loudly and creates
**no** primary session (an empty shell is unmistakable; a fallback session in the
wrong dir is a trap — ruled fine, §11). Composition for the standard
two-same-cwd-session run: `CATCODE_INITIAL_CWD=<scratch>` + single-entry allowlist
`=<scratch>` → session 1 exists at launch, session 2 is one New-Tab click.

**Packaged-build reachability (ruled acceptable, §11).** The §4 rule "channel not
registered, not merely refusing" targets NEW channels. D1 modifies the *existing
production picker channel*, which must stay registered. The guarantee: the bypass
branch is (a) main-side only, (b) behind the frozen startup config which is
unconditionally `disabled` when `app.isPackaged`, and (c) not renderer-influenceable
in any mode (env is main-read; no renderer input selects the dir). A packaged build
runs the real dialog unconditionally. The "not registered" rule is applied in full
to D3's genuinely new channel (§3).

## 2. D2 — Picker `defaultPath` (permanent product fix, unconditional)

Add `defaultPath` to the `showOpenDialog` options (`main.ts:419-424`), sourced from
the **renderer's active session — passed as an id hint (PT-2)**:
`pickDirectory(activeSessionId?)`. Main treats the argument as an untrusted hint:
UUID-shape check + membership in `host.listSessions()` (the HC2 idiom), then
resolves `defaultPath` from the matching descriptor's cwd — a value main already
owns. Invalid/unknown/absent hint degrades to the most-recently-attached live
session's cwd (`max(lastAttachedAt)` over live rows), then to `undefined` (OS
default). Ships in packaged builds, no flag.

This is NOT a renderer-authored path (HC1 intact): the renderer supplies an id that
*selects among* main-known cwds; it cannot introduce a path main doesn't already
have, and the user still confirms in the native dialog. Rev 1 used only the
most-recent-attached fallback, which is wrong exactly when two tabs have different
cwds — the case the proposal's "active session's cwd" wording targets. The
`pickDirectory` sender shape changes; the HC3 pins in `preloadSource.test.ts` are
updated to match (the hint is the sender's ONLY argument, guarded like every
payload).

## 3. D3 — Debug-state export (dev-only)

**Data split (who owns what):**
- MAIN owns: `SessionDescriptor`s (`host.listSessions()`) + registry advisory
  fields per row (enginePid, socketPath, shutdown) via a read-only accessor on the
  registry instance main already holds. Reads only — no new write points.
- RENDERER owns: tab model (order, run-local `tabs` membership, active id, per-tab
  chip via `deriveTabVisualState`), sidebar rows (`selectSidebarRows`), and the
  per-session pending-permission queue (`permissionState`). These never exist in
  main, so a renderer→main bridge is required (per the proposal).

**Bridge: one new FIXED channel, one-way, renderer→main push.**
`catcode:debug:shell-state`, exposed in preload as `reportDebugShellState(snapshot)`
— an `ipcRenderer.send` sender in the exact style of the existing seven frame-plane
senders, payload through `sendGuard.assertAllowed` (T7 size/rate posture). No
invoke, no reply, nothing flows back to the renderer.

**Gating — three layers, one per process (PT-3 applied):**
- PRELOAD: the sender is **compiled out of the packaged preload bundle**.
  `build-electron.ts` emits two bundles from the same `preload.ts` — `preload.cjs`
  (packaged: built with a `__CATCODE_DEV_HARNESS__ = false` define, the sender and
  its channel constant dead-code-eliminated) and `preload.dev.cjs` (define true).
  Main selects the bundle by `IS_DEV`. The packaged bridge surface is therefore
  byte-identical to today, and the hardening smoke's exact packaged-bridge-key
  assertion (`hardening-smoke.ts:172`) continues to pass UNCHANGED — that untouched
  assertion is itself the enforcement that no debug key leaked into packaged builds.
  (Rev 1 left the sender present-but-void in packaged preloads; the pressure test
  rejected that, correctly — it would also have broken the exact-keys assertion.)
- MAIN registers the `ipcMain.on` handler ONLY when `!app.isPackaged &&
  CATCODE_DEBUG_STATE=1`. Unregistered channel ⇒ a send is dropped by Electron.
- RENDERER pushes only under Vite's `import.meta.env.DEV` (build-time constant; a
  packaged renderer bundle has the push code eliminated). Pushes are computed from
  the SAME pure selectors the UI renders from (`selectLiveSessions` /
  `selectSidebarRows` / `deriveTabVisualState` / permission selectors) — one
  derivation step from the rendered DOM, which is what makes the export honest to
  cross-check against (and why §5-rule-1 still requires the AX observation: the
  export is upstream of React, not proof of paint). Trigger: debounced (250 ms
  trailing) effect on shell/permission state change, plus once on mount.

**Main-side validation before disk (PT-4).** Main never writes the renderer's bytes
as received. A strict `parseDebugSnapshot` runs on every push: exact
`debugStateVersion` match, bounded array lengths (sessions/tabs/sidebar/pending ≤
`MAX_REGISTRY_SESSIONS`-scale bounds), bounded string lengths, enum-checked `tone` /
`kind` / `mode` / `status` values, no unknown top-level keys. A malformed payload is
dropped with a loud log — never partially written. (The renderer is untrusted in
every mode; a dev flag doesn't change that.)

**File: `<claude-config-home>/desktop/debug/state.json`, mode 0600, dir 0700.**
Same config-home derivation the registry already re-implements host-side
(`registry.ts:160-170`) — one location family, and agents already know
`registry.json` lives there. NOT /tmp (proposal §3). Written by MAIN only:
atomic temp+fsync+rename (the registry's own idiom), debounced (250 ms), on
validated renderer push AND on every HostEvent, plus once when the readiness latch
fires (D5).

**Shape (`app/shared/debugState.ts`, versioned `debugStateVersion: 1`).** Rev 2
adds the VISIBLE-TEXT fields (PT-5): the export must let an agent cross-check the
exact strings the UI paints, not just internal enums — visible tab title, sidebar
row title/subtitle, permission prompt title + tool display name, and the rendered
suggestion labels (the `PermissionPrompt.tsx:88` formatting), while the full tool
INPUT object stays excluded (ruled, §11 — it remains visible in AX + transcript;
keeping it out holds the file's sensitivity ≤ registry.json):
```jsonc
{
  "debugStateVersion": 1,
  "writtenAt": 1751700000000,        // main's write time
  "rendererStateAt": 1751699999750,  // when the renderer computed its half (staleness check)
  "sessions": [ /* SessionDescriptor + { enginePid, socketPath, shutdown } */ ],
  "renderer": {
    "activeSessionId": "…",
    "tabs":    [ { "appSessionId", "title",          // the VISIBLE tab label text
                   "label", "tone", "restartable", "needsAttention" } ],   // TabBar order
    "sidebar": [ { "appSessionId", "title", "subtitle",                     // visible row text
                   "kind", "label", "tone", "restorable" } ],               // Sidebar order
    "permissions": { "<sessionId>": { "mode": "default",
      "pending": [ { "requestId", "toolName", "displayTitle",               // visible prompt title
                     "suggestionLabels": ["Always allow: …"] } ] } }        // visible strings, NOT input
  } | null                            // null until the first push (or renderer crashed)
}
```
Agents must treat `rendererStateAt` as the freshness signal — a crashed renderer
leaves a stale `renderer` half while `sessions` stays live.

**Info-leak posture:** content ⊆ (registry.json content ∪ strings the renderer
already displays on screen). Frames reaching the renderer already passed
`secretGuard`; registry rows carry no secrets by §3 exclusion. NOT transcript
content (§3 non-goal).

## 4. D4 — Dev app name

`if (!app.isPackaged) app.setName('Cat Code Dev')` in main before `whenReady`, plus
the window title. **PT-8:** a `BrowserWindow` `title` option is overwritten by the
document's `<title>CatCode</title>` (`app/renderer/index.html:15`) on load — so in
dev, main also handles `page-title-updated` with `event.preventDefault()` after
setting `'Cat Code Dev'`, making the title authoritative; packaged builds keep the
document title untouched. The scripted demo asserts the post-load title (the AX
truth), not the constructor option. Side effects tested in-session (§11 ruling):
source-test that nothing reads `app.getPath('userData')` (whose default derives from
the app name), and the demo confirms the single-instance lock still holds across
the rename.

## 5. D5 — Readiness signal

One stable stdout line, `[main] renderer ready`, emitted by a **latch (PT-1)**: main
records (a) the window's first `ready-to-show` and (b) the first `CH_RENDERER_READY`
per document load (`main.ts:391-393` — the F2 attach signal, which fires after
mount+subscribe), and logs when BOTH have fired. Rev 1 claimed rendererReady is
strictly later than ready-to-show; the two are independently wired events with no
ordering contract (`main.ts:224` vs `:391`) — the latch removes the assumption
instead of encoding it. The prefix is the contract; anything after it is
informational and may change.

The latch also does NOT imply the primary session exists — `host.createSession` is
fire-and-forget async (`main.ts:664-675`). Consumers that need session state wait on
an **export predicate**, not the log line and not file existence: when D3 is
enabled, the first export write fires with the latch, and the demo/agents poll until
the export parses AND shows the expected row (e.g. a `ready` session whose cwd is
the initial cwd). The log line answers "is the app up"; the export answers "is the
state there".

---

## 6. Constraint compliance (proposal §4 — how each is held)

| Constraint | How held |
|---|---|
| HC1/T8: renderer never authors a path | Bypass dir chosen by main-read env; token pipeline + `validateCwd` unchanged; `CreateSessionInput` still path-free; D2's hint is an HC2-validated id that selects among main-known cwds, degrades to main-derived fallback; renderer surface still cannot express a path |
| Dev-only double-gated; packaged = no reachable path | All flags require `!app.isPackaged` AND env, frozen at startup; D3's channel: sender compiled OUT of the packaged preload bundle + handler not registered outside the gate (two independent kills); D1 modifies an existing production channel (interpretation ruled acceptable, §11); hardening smoke (which forces `isPackaged=true`, `hardening-smoke.ts:21-24`) keeps its exact packaged-bridge-key assertion passing unchanged AND gains a no-export-file assertion |
| Preload default-deny; fixed channel; pinned in tests | One new fixed-name one-way sender through `sendGuard`, dev bundle only; `preloadSource.test.ts` pins extended (counts + constant + `pickDirectory` hint arg + no-new-invoke); NEW bundle-level test: built `preload.cjs` contains no `catcode:debug:` string, `preload.dev.cjs` does |
| No new engine-socket frames | Nothing touches `app/shared/protocol.ts`, sidecar, or supervisor |
| Registry not weakened | Reads only (listSessions + a read-only row accessor); zero new write points |

## 7. Verification plan (headless — §6 of the proposal, refined)

1. **Unit** (`devHarness.test.ts`, new pure module): allowlist parse/validate
   (invalid entry → `broken` state: null picks, loud log, NO dialog reachable),
   cyclic cursor, vanished-dir pick → null, frozen-config immutability, packaged ⇒
   disabled; export merge + `writtenAt`/`rendererStateAt` stamping; readiness-latch
   ordering (both orders of ready-to-show/rendererReady fire exactly one line);
   `parseDebugSnapshot` strictness (version/bounds/enums/unknown-key rejection);
   defaultPath resolution (valid hint → that session's cwd; invalid/unknown hint →
   recency fallback → undefined).
2. **Unit** (`debugStateReport.test.ts`): renderer snapshot is a pure function of
   `ShellState` + permission state, agrees with the UI selectors on the same fixture
   (same tone/label/order), and carries the same visible strings the components
   render (tab title, sidebar subtitle, suggestion labels).
3. **Boundary**: preload pins extended (above); the preload-bundle strip test (§6
   table); a `mainSource.test.ts`-style static test asserting the debug registration
   sits inside the double gate; file mode asserted 0600 in the writer test.
4. **Hardening smoke re-run** (mandatory — preload touched): exact packaged
   bridge-key assertion must pass UNCHANGED (proves no debug key in packaged
   bundles), plus a new assertion that no export file appears.
5. **Scripted demo** (`app/scripts/harness-demo.ts`): launches the **dev renderer**
   (Vite, the `scripts/dev.ts` pattern — PT-7: the hardening runner builds the
   production renderer, where `import.meta.env.DEV` is false and the push is
   eliminated; the demo must run the stack the harness actually uses) with all three
   flags against a temp dir. Waits for `[main] renderer ready`, then polls the
   export until it shows the initial-cwd session `ready` (the D5 predicate, 0600
   asserted); asserts the post-load window title is `Cat Code Dev`; then drives the
   REAL full path via `webContents.executeJavaScript` calling
   `window.catcode.pickDirectory()` → `createSession(token)` from the page — proving
   renderer bridge → guard → IPC → bypass → token → `validateCwd` → spawn
   end-to-end, headlessly; asserts the export now shows two same-cwd sessions with
   two distinct pids.
6. Both tsc configs; `bun test app/` green.

## 8. File plan

| File | Change |
|---|---|
| `app/main/devHarness.ts` | NEW, Electron-free pure logic: config resolve/freeze, allowlist cursor + broken-state, readiness latch, `parseDebugSnapshot`, export merge/serialize, debounce |
| `app/main/main.ts` | wire: bypass branch + hint-resolved defaultPath in `CH_HOST_PICK_DIR`; initial-cwd in `ensureHost`; setName + `page-title-updated` guard; latch log; conditional debug registration + atomic writer |
| `app/shared/debugState.ts` | NEW: versioned snapshot types incl. visible-text fields (crosses preload) |
| `app/preload/preload.ts` | +1 fixed sender `reportDebugShellState` behind the `__CATCODE_DEV_HARNESS__` define; `pickDirectory` gains the optional id-hint arg |
| `app/scripts/build-electron.ts` | emits `preload.cjs` (define false, sender stripped) + `preload.dev.cjs` (define true); main selects by `IS_DEV` |
| `app/renderer/src/debugStateReport.ts` + `App.tsx` | NEW selector + DEV-gated debounced push effect; App passes `activeSessionId` to `pickDirectory` |
| `app/host/registry.ts` | read-only row accessor (advisory fields for the export) |
| tests + `app/scripts/harness-demo.ts` | per §7 |

## 9. Docs deliverables (same session, docs-only edits)

- NEW `docs/migration/process/GUI-VERIFICATION.md`: launch recipe (flags, readiness
  latch line + export predicate, export path/schema incl. `rendererStateAt`
  freshness rule), the four §5 honesty rules verbatim —
  (1) export LOCATES/CROSS-CHECKS, never substitutes: every 🖐 claim still cites an
  AX-observed label; (2) P3-8 must exercise ≥1 REAL picker interaction; (3) new
  surfaces carry aria-labels with session identity + state; (4) `registry.json`
  maps appSessionId ↔ enginePid/cwd/socketPath for kill-the-right-sidecar forensics.
- PATCH `docs/migration/backlog/phase3.md`: P3-8 gains the real-picker rider
  (beside the settings-race rider); P3-6/P3-7 prompts gain the aria-label
  convention line + a pointer to GUI-VERIFICATION.md.
- STATUS row for this session (headless-verifiable, no 🖐).

## 10. Non-goals (proposal §3 + design-added)

Improving NSOpenPanel AX; `/tmp` export; transcript search in the export; full
permission INPUT objects in the export (visible suggestion labels are in, the input
object is out — §11); replacing GUI verification; retrofitting aria-labels onto
P3-5a/5b (they AX-verified fine — the convention binds NEW surfaces); a `--test-cwd`
argv variant (env is one mechanism, argv is a second parsing surface for zero gain);
a renderer-visible "debug mode" indicator (nothing new flows renderer-ward).

## 11. Pressure-test rulings (2026-07-05 — rev 1's open questions, all closed)

1. **Cyclic allowlist wrap** — ACCEPTED as designed.
2. **D1 inside the existing picker channel** — ACCEPTED, conditional on the packaged
   config making the branch unreachable (it does: frozen `disabled` config).
3. **Debug sender in packaged preload** — REJECTED; rev 2 strips it from the
   packaged bundle at build time (§3), keeping the hardening smoke's exact
   bridge-key assertion intact as the enforcement.
4. **Permission input in the export** — keep the full input OUT, but include the
   VISIBLE suggestion labels + prompt title + display name (rev 1's
   `suggestionCount` alone couldn't cross-check what the UI paints) — §3 shape.
5. **Invalid `CATCODE_INITIAL_CWD` → empty shell** — ACCEPTED (fail-loud-empty).
6. **defaultPath** — renderer `activeSessionId` HINT (HC2-validated id, not a path),
   with recency fallback — §2.
7. **`app.setName`** — ACCEPTED with side-effect tests: userData independence
   (source test), title survival past document-title overwrite
   (`page-title-updated` guard + demo assertion), single-instance lock unaffected.

Additional findings applied: readiness latch replaces the wrong ordering claim
(PT-1, §5); invalid allowlist fails CLOSED with no dialog fallback (PT-6, §1);
main-side strict snapshot validation before any disk write (PT-4, §3); the demo
runs the dev renderer, not the hardening runner's production build (PT-7, §7).

## 12. Suggested session parameters (unchanged from proposal §6)

Model: ANY · Difficulty: 4/10 · headless (no 🖐). Done-when = §7 all green +
§9 docs landed + STATUS row flipped.
