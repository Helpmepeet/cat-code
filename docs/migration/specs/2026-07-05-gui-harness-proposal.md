# GUI-verification harness — requirements handoff (2026-07-05)

**Audience:** the session that will DESIGN and build the dev/test harness for agent-driven
GUI verification of the desktop app. This doc is the input: pain evidence, the agreed
recommendation list, security constraints, and explicit non-goals. The design itself is
yours — but the constraints in §4 are not negotiable (they are the migration security
baseline, not preferences).

**Sources:** synthesized from (a) the P3-5b fix worker's post-mortem of the 2026-07-05
GUI runs, and (b) direct feedback from the cua-driver verifier session that drove the app.
The two lists were produced independently and converged on the same top item.

---

## 1. Why this exists — the pain evidence

Every GUI-session failure so far happened at the boundary between the app and the OS
(native dialogs, process discovery) — never in the app's own UI, which is well-drivable
via AX.

- **The native folder picker (NSOpenPanel) is THE blocker.** It destroyed one full agent
  dispatch on 2026-07-05: the P3-5a re-verify could not create a second same-cwd session
  because the picker kept opening a stale external `app` folder and exposed almost no AX
  tree (agent fell back to brittle screenshot/pixel driving, then gave up per protocol).
  A human had to finish the run by hand.
- **GUI rows re-run.** P3-5a has burned 3 runs (acceptance, blocked agent re-verify,
  human-driven); P3-5b took 2; P2-4's first run partially FALSE-FAILED on observability
  (512-msg renderer retention scrolled evidence out of view), not on real defects.
  Historical multiplier ≈ 1.5–2 runs per 🖐 row.
- **Remaining GUI volume justifies the spend:** Phase 3 still has P3-5a re-run (after the
  engine settings-race fix), P3-6, P3-7, P3-8 (all 🖐). Phase 4 fans out 8+ domain
  surfaces (Accounts/Codex pool, Sessions page, Agents config, Orchestrator, Tasks,
  Settings sub-panes, Goal, Startup/trust), each ending in a P2-4-style live GUI
  verification. Phase 5 adds a11y + full-suite passes. Order of magnitude: **15–20 GUI
  runs ahead** vs a ~1-day harness.
- **Session↔pid correlation is manual.** Verifier had to constrain tests to ONE live
  session so `pgrep -f 'app/sidecar/index.ts'` was unambiguous, and inferred state from
  `registry.json` + AX text.

## 2. What to build (ranked; #1 is the payload, the rest ride along)

1. **Dev-only trusted-cwd session creation (the picker bypass).**
   The acceptance criteria of GUI rows are things like "two host-owned sessions with the
   same canonical cwd" — picker automation was never the thing under test. Provide a
   flag-gated path to create a session with a main-supplied cwd, skipping NSOpenPanel.
   Suggested shape (design freely within §4): `CATCODE_TEST_CWD_ALLOWLIST=/dir1:/dir2`
   read by MAIN; when set (and `!app.isPackaged`), `pickDirectory()` resolves to the next
   allowlisted dir (or a `--test-cwd` launch arg / hidden debug command does the same).
   Optional sugar once this exists: `CATCODE_INITIAL_CWD` to auto-create one session at
   launch (subsumes the verifier's separate ask; don't build it independently).

2. **Picker `defaultPath` = active session's cwd (PERMANENT product fix, not scaffolding).**
   One-liner on `dialog.showOpenDialog`. The stale-directory default is what blocked the
   agent run; a human user benefits identically. Ship this unconditionally (no dev flag).

3. **Debug-state export (dev-only).**
   A machine-readable JSON snapshot of what the UI is rendering, refreshed on shell-state
   change (or on demand), so agents verify exact labels/ids with `jq` and use cua-driver
   only to confirm the visible UI exists and actions land. Contents:
   - `sessions`: appSessionId, engineSessionId, cwd, status, restorable (+ registry
     shutdown/enginePid/socketPath if cheaply available from main)
   - tab model: active tab id, tab order, chip labels, restartable flags
   - sidebar model: row order, chip labels, restore-action availability
   - permission state per session: pending request id, tool, suggestions, mode
   - NOT transcript search — engine transcripts are already on disk and were successfully
     used by the verifier; keep scope to shell + permission projections.
   **Location: NOT `/tmp`** (contains cwds, session ids, socket paths, permission state —
   no world-readable shared dir). Put it under the app's userData dir or
   `~/.cat-code/desktop/debug/`, mode 0600, written only when the dev flag is set.
   Implementation note: tab/sidebar/permission models live in the RENDERER, so this needs
   a dev-only bridge channel (renderer → main file write). See §4 for the bridge rules.

4. **Dev app name.** Dev builds appear in AX/`list_apps` as generic "Electron";
   `app.setName('Cat Code Dev')` (or equivalent) makes discovery deterministic.

5. **Readiness signal.** One unambiguous main-process log line when the window is shown
   AND the bridge is ready (e.g. `[main] renderer ready`), so background launches get a
   wait-for condition instead of sleep-and-retry.

## 3. Explicit non-goals (things considered and rejected)

- **"Improve the picker's AX"** — not actionable; NSOpenPanel is Apple's. The answer to
  the picker is items 1+2, full stop.
- **`/tmp/catcode-debug-state.json`** — rejected location (info leak); see item 3.
- **Transcript search in the debug export** — overkill; on-disk engine transcripts cover it.
- **Making the harness replace GUI verification** — see §5.

## 4. Hard constraints (migration security baseline — do not relax)

- **HC1/T8 stand:** the renderer NEVER authors a filesystem path, in any mode. The
  bypass is resolved in MAIN from main-read env/argv; the existing token pipeline and
  `validateCwd` (realpath + isDirectory) still execute. The renderer surface is unchanged.
- **Everything dev-only is double-gated:** `!app.isPackaged` AND an explicit env flag.
  Packaged builds must contain no reachable code path (channel not registered, not merely
  refusing).
- **Preload stays default-deny:** any new debug channel is a FIXED named channel, added in
  the same style as the existing five senders; no generic invoke. Call it out in tests the
  way P3-3's HC3 tests pin the method list.
- **No new wire frames on the engine socket.** The harness is host/renderer plumbing; the
  socket vocabulary is untouched.
- **Do not weaken `registry.json` handling** — read it if useful for the export, never
  write outside the existing write points.

## 5. Verification-honesty rules (write these into the harness docs AND future backlog prompts)

1. **The debug export may LOCATE and CROSS-CHECK, never substitute.** Every 🖐 acceptance
   claim must still cite an AX-observed label from the live window. Otherwise GUI rows
   stop testing rendering (reverse-Potemkin).
2. **P3-8 (the gate) must include at least ONE real picker interaction** so the bypass
   never hides a regression in the production create path.
3. **Standing convention for new surfaces (P3-6/P3-7/Phase-4 prompts):** every
   status-bearing element carries an aria-label with session identity + state, e.g.
   `"session catcode-gui-scratch — crashed, restorable"`. New UI ships agent-verifiable by
   construction; no retrofits.
4. **Cheap doc fix, no code:** note in the GUI-test docs that `registry.json` already maps
   appSessionId ↔ enginePid/cwd/socketPath for kill-the-right-sidecar forensics.

## 6. Suggested session parameters

Model: ANY · Difficulty: 4/10 · headless-verifiable (NO 🖐 tag needed — the harness itself
is provable with unit tests + a scripted launch; its first real GUI consumer is P3-6).
Done-when: `bun test app/` green with new channel-pinning tests; renderer tsc clean;
sidecar tsc no new errors; hardening smoke green (MUST re-run — item 3 touches the
preload surface); grep-proof that packaged builds register no debug channel; a scripted
demo run showing create-via-allowlist + export file appearing with 0600 under the dev flag.

## 7. References

- STATUS.md rows P3-5a / P3-5b (2026-07-05 entries) — the blocked run and the fix context.
- `docs/migration/decisions/SECURITY-MINIMUM.md` — T-numbered baseline cited in §4.
- `app/host/host.ts` (HC1 validateCwd, token pipeline), `app/main/main.ts` (picker,
  preload wiring), `app/renderer/src/shellState.ts` / `sidebarState.ts` / `tabStatus.ts`
  (the projections the export must mirror).
- Verifier feedback (verbatim source of items 1/2/3/5): held by the operator; summarized
  faithfully above including its own honesty caveat ("reports the same state the UI is
  rendering… still keeping GUI verification honest").
