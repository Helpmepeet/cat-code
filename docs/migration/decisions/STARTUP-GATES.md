# D4 — Are the startup GUI gates real requirements?

**Status: ARCHITECTURE RULED 2026-07-04 — PRODUCT CALL PENDING OPERATOR (two questions, §5).**
This rules the architecture half of INVENTORY's D4 — which of the prototype `Startup.jsx`
gates (`StartupFlow` trust→auth, `ReadOnlyModeGate`, `WorkspaceSwitchPrompt`, `ReauthGate`)
sit on real primitives vs. are prototype storytelling — and surfaces the two genuinely
product-shaped calls. The row stays open until the operator answers §5. All anchors verified
against the working tree 2026-07-04; where this doc and source disagree, source wins.

| # | Question | Verdict |
|---|---|---|
| **G1** | Trust gate — real? | **YES — real requirement, adapt.** Per-path persisted trust: `ProjectConfig.hasTrustDialogAccepted` (`src/utils/config.ts:111`), keyed in `GlobalConfig.projects[path]` (`:188`); `checkHasTrustDialogAccepted` latches false→true and walks parent dirs (`:735-780`); `isPathTrusted(dir)` checks arbitrary dirs (`:788`) — exactly what a desktop needs at session-create time. Consumed at startup (`src/main.tsx:382,1104`) and rendered by the real `TrustDialog` (`src/components/TrustDialog/TrustDialog.tsx`). |
| **G2** | First-run auth — real? | **YES — real machinery, adapt.** The `OAuthStatus` state machine is source-exact: `ready_to_start` / `waiting_for_login {url}` / `waiting_for_alias` (Codex alias step) / error-with-retry (`src/components/ConsoleOAuthFlow.tsx:35,38,48`). A GUI login surface re-skins this flow; nothing invented. |
| **G3** | Read-only startup — real? | **NO source backing as a mode.** In the real `TrustDialog` the choices are trust (`enable_all`) or **exit** (`TrustDialog.tsx:231-232`, `onCancel → "exit"` `:240`). There is no untrusted-but-open state anywhere: trust only transitions false→true (`config.ts:735-740`), and nothing maps "declined" to a restricted permission context. Read-only startup would be a **new product feature** on the permission plane — product question §5-Q1. |
| **G4** | Workspace-switch prompt — real *as a mid-session modal*? | **NO — and the desktop architecture dissolves it.** Sessions are one-cwd-per-engine-process (N-process; cwd fixed at spawn, HC1: renderer never authors paths). "Switching workspace" on the desktop = creating a session in another cwd, and G1's per-path check runs *there*. The mid-session re-prompt modal has no state to guard. **CUT as a distinct surface; its semantics fold into the session-create trust gate.** Ruled here — this half is architecture, not product. |
| **G5** | Forced-reauth gate — real? | **Real signal, invented gate.** The signal is source-real: refresh marked `reauth_required` (`src/services/api/codexTokenRefresh.ts:449`, identity-mismatch path `:574`, terminal skip `:879`), account flips `dead`/`auth_dead` (`src/services/api/codexAccountPool.ts:68,620,1128`). But upstream this is a `[dead]` line in `/accounts` and a request-time error — re-auth is user-initiated via `/login`; **no blocking gate exists**. The prototype marks the dialog GUI-ONLY itself (`Startup.jsx:370-388`). Whether token death should *block* is product question §5-Q2. |

---

## 1. What the desktop actually needs at startup (the adapt scope)

From G1+G2, the real, buildable startup surface is:

1. **Session-create trust gate:** when a session is created in a cwd (native picker or
   registry row, HC1), the host checks `isPathTrusted`-equivalent state for that path; if
   untrusted, show the trust dialog *for that session* before spawn. Trust persists per-path in
   the same config the engine reads — the desktop must not fork a second trust store.
   Multi-session nuance the TUI never had: two sessions in different cwds each carry their own
   trust state; the gate is per-session-create, not per-app-launch.
2. **First-run auth:** if no credentialed account exists, surface the OAuth flow (G2 states,
   including the Codex `waiting_for_alias` step). After first-run, auth lives in the Accounts
   domain (W4), not a startup gate.

Both are adapts of real machinery; Phase-4 rows can be generated for them regardless of §5.

## 2. Why read-only mode is not an adapt (G3 detail)

The prototype's `ReadOnlyModeGate` promises "chat but no tools/plugins/LSP" for untrusted
folders. Source has no such state: declining trust exits (`TrustDialog.tsx:231-240`), and the
trust check gates side-effectful startup work (`main.tsx:382-390`, assistant-mode gate
`:1104`). The engine *does* have permission modes, but none is wired to trust, and inventing
"untrusted ⇒ some restricted mode" is a security-semantics decision (what exactly is blocked?
is prompt-injection-adjacent content still read?) — a product feature with a threat-model
obligation, not a UI port. Until ruled otherwise, the desktop's untrusted answer is the TUI's:
trust it or don't open it.

## 3. Why the reauth gate ships as a banner, not a wall (G5 recommendation)

The desktop-shaped problem is real: in a GUI, a mid-session token death otherwise surfaces as
every turn failing quietly (the TUI at least prints the error inline). But the *blocking modal*
overshoots the source semantics: the pool may hold other healthy accounts (failover is the
pool's job — `codexAccountPool.ts` health states exist precisely so one dead account isn't
fatal), and blocking the whole window on one dead account would be wronger than the TUI.
Recommended v1: a non-blocking, persistent banner/badge driven by pool status (`auth_dead`
reason surfaced honestly) with a "re-authenticate" action that launches the G2 OAuth flow
scoped to that account. Blocking is reserved for the "no healthy account remains" case — and
whether even that blocks or just disables submit is §5-Q2.

## 4. Keep/cut summary

| Prototype surface | Verdict | Anchor / justification |
|---|---|---|
| `StartupFlow` trust step (`TrustGate`) | **adapt** (per-session-create, §1.1) | `config.ts:111,188,735-788`; `TrustDialog.tsx` |
| `StartupFlow` auth step (`AuthGate`) | **adapt** (first-run only) | `ConsoleOAuthFlow.tsx:35-55` |
| `ReadOnlyModeGate` + "Open read-only" buttons | **cut unless operator rules otherwise** (§5-Q1) | no source state; decline = exit (`TrustDialog.tsx:231-240`) |
| `WorkspaceSwitchPrompt` | **CUT — ruled** (G4) | one-cwd-per-session dissolves it; semantics live in §1.1 |
| `ReauthGate` (blocking modal) | **redesign to non-blocking banner + action** (recommended; §5-Q2) | signal real (`codexTokenRefresh.ts:449`, `codexAccountPool.ts:620,1128`), gate invented (`Startup.jsx:370-388` admits GUI-ONLY) |

## 5. Product questions for the operator (block closing this row)

> **Q1 — Untrusted folder:** TUI parity (trust it or don't open it — no read-only mode), or
> build read-only mode as a new feature (requires defining exactly what's blocked + a
> SECURITY-MINIMUM addendum before any UI)?
> Recommendation: **TUI parity for v1**; revisit if dogfooding surfaces a real browse-untrusted
> need.
>
> **Q2 — Account death:** non-blocking banner + re-auth action, blocking only when *no*
> healthy account remains (recommended) — or the prototype's hard modal on any active-account
> death?
> Recommendation: **banner + act-on-it**; the pool's multi-account health model exists so one
> dead account isn't a wall.

> **✅ OPERATOR RULING 2026-07-07.** Q1: **TUI parity** — no read-only mode; `ReadOnlyModeGate`
> + the "Open read-only" buttons are CUT (decline trust = exit). Q2: **non-blocking reauth banner
> + action** — banner driven by pool status, submit blocked only when *zero* healthy accounts
> remain; the prototype's blocking `ReauthGate` modal is CUT. With the G4 ruling
> (`WorkspaceSwitchPrompt` CUT), the D4 startup surface = per-session-create trust gate +
> first-run OAuth + reauth banner. This row is now CLOSED — generated as **P4-15** in
> `backlog/phase4.md`.

## 6. Pressure test

- **"Trust checked only at create-time misses cwd changes mid-session."** In the engine, cwd
  *can* move per-submit (`setCwd`, P0-4's forcing state). But the desktop pins spawn-cwd at
  the session level (HC1) and the engine's own trust check walks parents from its cwd on every
  call (`config.ts:742-780`, false is never cached) — an engine-side cwd change into untrusted
  territory hits the engine's own gate, same as the TUI. The desktop gate is additive, not the
  only line.
- **"Cutting `WorkspaceSwitchPrompt` loses a real TUI behavior."** No such TUI behavior
  exists — the TUI process is born in one cwd and trust re-prompts happen at *launch* in the
  new directory, which is exactly the desktop's session-create gate. The modal guarded a
  workspace-*switcher* the product doesn't have (one-process-one-cwd; the prototype's own
  `Welcome.jsx:108-110` admits this divergence).
- **"The reauth banner under-reacts; users will miss it and burn turns."** The failure mode is
  bounded: submit fails loudly with the pool's typed error (`No healthy Codex account…`,
  request-time fallthrough), and the banner persists until acted on. The modal's failure mode
  is worse: it blocks a window that may have four healthy accounts. If dogfooding shows the
  banner is missed, escalating it is a UI tweak, not an architecture change — the cheap
  direction to be wrong in.

> **Revision (P4-24, 2026-07-12 — operator-driven).** The "persists until acted on / no
> Dismiss" rule is relaxed for the NON-blocking case. A dead account *among healthy ones*
> now carries a × that dismisses it for good (persisted "never show again"), because the
> pool fails over and nagging is the wrong behavior; the banner also FLOATS as a top
> overlay (`top-10`, below the TabBar) rather than reflowing the panels. The BLOCKING
> banner (every account dead → `selectAuthSubmitBlocked`) stays non-dismissable and
> resurfaces even for a previously-dismissed account, so the loud-failure guarantee above
> is intact. Mechanism: `selectVisibleReauthBanners` + persisted ids (`reauthBannerState.ts`
> / `App.tsx`, `localStorage['catcode:dismissedReauth']`). This is the "UI tweak, not
> architecture change" the bullet above anticipated.

> **Revision (2026-07-19 — operator GUI-acceptance, merge `54d5e45`).** Supersedes the
> BLOCKING-case behavior above. The all-dead wall no longer renders N per-account banners
> (each repeating the pool sentence) and no longer re-nags on every session switch. It is now
> ONE merged wall (`selectReauthWall` / `ReauthWall.tsx`): the pool-level "no healthy account /
> turns blocked" reason stated ONCE, with one row per dead account keeping its own real reason
> (e.g. `refresh_token_invalidated` vs "token expired"). The wall is **acknowledge→collapse**,
> never hide: acknowledging minimizes it to a persistent chip (still says blocked, "Show
> details" re-expands), and the acknowledge is keyed to the *sorted dead-account set*
> (`localStorage['catcode:acknowledgedReauthWall']`) — session-free, so it persists across
> session switches (the pool is global) but a genuinely new dead-set re-surfaces. The
> loud-failure guarantee is intact: `selectAuthSubmitBlocked` is unchanged and the block reason
> stays on screen (collapsed, not hidden). Still a UI change, not architecture.
- **"Read-only mode is obviously useful; why not just build it?"** Because "read-only" is a
  security claim, and no one has defined it against the threat model (does the engine still
  read CLAUDE.md? run MCP servers? LSP?). Shipping the *label* without the defined semantics
  is exactly the "prototype inventions leak into production" risk (PROGRAM-PLAN §7). The cost
  of asking first is one operator answer.

## 7. Carry-forwards

- If §5-Q1 lands on read-only mode: SECURITY-MINIMUM addendum first (define the blocked set),
  then a decision doc, then UI.
- The G5 banner needs pool status at the seam — Accounts-domain plumbing (W4/S8), flag the
  read path there (C3-precedent snapshot vs. existing frames), not a startup concern.
- First-run auth (G2) writes credentials from a GUI context — the flow must keep the secret
  owner engine-side (SECURITY-MINIMUM): the renderer drives navigation, never touches tokens.
