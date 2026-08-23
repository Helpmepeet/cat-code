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

   > **Clarification (2026-07-31 — operator ruling). §1.1 stands unchanged.** The UX gap audit
   > (finding 2) observed that on a genuine first launch there is no session, so the accounts
   > snapshot is session-keyed and null (`App.tsx:2396`, `accountsState.ts:106`) and
   > `shouldShowFirstRunOAuth` (`appModel.ts:14`) cannot fire — the user must guess the sequence
   > (pick a folder, session spawns, trust gate, *then* sign-in). The audit initially proposed
   > reading the global pool instead; that was withdrawn, because account **verbs** need an engine
   > process to carry them (`App.tsx:1178` answers with a real `ok:false` outcome when there is no
   > session), so exposing sign-in earlier would surface a control with nothing behind it.
   >
   > **Ruled: fix discoverability, not architecture.** The launcher tells the user what to do first
   > so the sequence is visible rather than guessed. Per-session-create trust is unchanged; account
   > writes stay session-scoped; no host-plane account-write path is authorized by this ruling.
   > Explicitly NOT ruled in: moving the `user` settings scope to a host-plane read. That is
   > architecturally clean (the user layer is session-invariant by design,
   > `settingsScope.ts:33`) and is untouched by this ruling, but it was not selected and needs its
   > own decision.
   >
   > **Amendment 2026-08-23 — destructive global deletion no longer borrows a
   > session.** The operator revisited the concrete Delete-account failure and
   > ruled the session dependency wrong. `account.delete` now runs in the
   > main-owned one-shot accounts worker documented in
   > `decisions/ACCOUNTS-OWNERSHIP.md`. Trust and the long-lived OAuth flow remain
   > session-scoped; this amendment does not authorize a generic host-plane
   > account-write channel.

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

> **Revision (2026-07-20 — operator GUI-acceptance, #12).** REMOVES the reauth alert surface
> entirely, superseding the merged-wall revision above. There is no longer a wall, a per-account
> reauth banner, or a collapsed chip, and zero-healthy no longer blocks submit — the composer
> send is never disabled by account health. A send attempt at zero-healthy simply proceeds and
> fails naturally at request time, where the engine surfaces its own typed pool error (`No healthy
> Codex account…`, the request-time fallthrough this section already relies on). Deleted:
> `ReauthWall.tsx`, `reauthBannerState.ts` (`selectReauthWall` / `selectVisibleReauthBanners` /
> `selectAuthSubmitBlocked` and the banner/wall state), their `App.tsx` render + derivation +
> submit-gate sites, and the `localStorage['catcode:dismissedReauth']` /
> `['catcode:acknowledgedReauthWall']` keys. The reauth OAuth-progress card (`ReauthOAuthProgress`,
> the in-flight re-link surface) was kept at the time as a different thing.
>
> **P4-34 follow-up (2026-07-30).** That card is now deleted too. It was gated on
> `oauthContext === 'reauth'`, and after #12 removed the banner the only remaining caller of
> `beginOAuth('reauth')` was the card's own Retry button — so nothing could open it. Giving it a
> launcher would have reversed #12, which is not a drive-by decision, so the orphan went instead:
> the `'reauth'` context is gone from `OAuthContext` (`app/renderer/src/appModel.ts`), and
> re-linking an account runs through the same `StartupOAuth` / add-account surfaces as any other
> sign-in. Pinned by `app/renderer/src/StartupSurfaces.test.tsx`. A nicer proactive treatment is
> still deferred (out of scope). Operator GUI eyeball owed at the all-accounts-dead stage: confirm
> nothing renders and a send proceeds to the request-time pool error.
>
> **Revision (2026-07-31 — operator ruling). #12 stands; the "nicer proactive treatment" deferred
> above is now RULED IN, bounded.** Prompted by the UX gap audit
> (`docs/migration/reviews/2026-07-31-app-ux-gap-audit.md`, finding 9 / operator question O2):
> quota exhaustion currently surfaces only as a `cat_code_account_diagnostic` notice **inside the
> scrolling transcript** (`TranscriptView.tsx:1763`), so it scrolls out of view while subsequent
> turns keep failing at request time. #12's reasoning — no wall, no submit block, failure surfaces
> naturally — is unchanged and remains binding.
>
> **Ruled:** account/quota diagnostics get a **pinned, dismissable, non-blocking** surface above the
> transcript, mounting the already-built `BannerStack` (`app/renderer/src/BannerStack.tsx`, currently
> zero production importers). Constraints that make this compatible with #12 rather than a reversal
> of it: it never blocks submit, it is always dismissable, it carries no re-auth wall semantics, and
> it does not reintroduce `ReauthWall.tsx` or `reauthBannerState.ts`. Scope is **account health
> only** — shell lifecycle errors are a separate surface and a separate finding (audit finding 8);
> do not merge the two error classes into one banner plane.
>
> **Revision (2026-08-22 — operator ruling, in-session). #12 stands. A dead account among healthy
> ones gets a PASSIVE MARK on the Accounts destination, and still no transcript-plane surface.**
> Prompted by CC-74: the sign-in, re-link, and delete verbs were all real, but one dead account in a
> healthy pool was discoverable only by opening the Accounts page, because the health bar fires only
> when EVERY account is blocked (`accountHealthBanner.ts`) and that all-blocked trigger is #12/P4-24
> working as ruled. The operator was offered a banner extension and DECLINED it, choosing the passive
> treatment instead.
>
> **Ruled:** a count of accounts needing sign-in may be marked on the Accounts nav destination, in
> both the collapsed rail and the expanded list, plus the destinations toggle while that list is
> folded shut (the fold is `inert` and `opacity-0`, so a mark inside it is unreadable in the sidebar's
> default state). Bounds that keep this compatible with #12 rather than a reversal of it: it is
> passive (no pulse, no dismissal state, no action of its own, `aria-hidden` visuals with the count in
> the button's own label), it never blocks submit, it carries no re-auth wall semantics, it does not
> reintroduce `ReauthWall.tsx` / `reauthBannerState.ts` / the `'reauth'` `OAuthContext` (P4-34), and
> it does NOT change `selectAccountHealthBanner`'s all-blocked trigger. Scope is the Codex pool only;
> the Anthropic pool has no repair affordance yet, so it is deliberately uncounted.
> Implemented in `1f1c0fa3` (count on the rail and in the expanded list) and `09d8cd9e` (the mark on
> the destinations toggle, which the bound above requires: the expanded list is folded shut by
> default and `inert` while folded, so a mark only inside it is unreadable in that state). The repair
> action itself is the `dead`-only "Sign in again" row item, which reuses `account.login` and adds no
> vocabulary. The `app/main` wiring that drives the count's refresh is not yet committed; see the
> CC-74 row in STATUS.md.
>
> **Revision (2026-08-22 — recon, no code change). The Anthropic pool stays uncounted, and the
> reason is now stronger than "no repair affordance yet": a dead Anthropic row is not reachable on
> this surface at all.** The revision above deferred the Anthropic half on the assumption that it
> merely lacked a repair control. It was investigated to decide whether to give it the Codex
> treatment; the answer is that the affordance would key off a state the page's feed cannot produce.
>
> **Established:** the Accounts page and the sidebar mark both read `selectGlobalAccountsSnapshot`
> (`app/renderer/src/accountsState.ts:258`), which PREFERS the polled global snapshot from the
> disposable accounts worker over any session's own. That worker
> (`app/sidecar/accountsPoolWorker.ts:115`) is a fresh process per run and populates the Anthropic
> pool with `loadClaudePoolForObservation()` (`src/services/api/claudeAccountPool.ts:101`), whose two
> account sources can never yield `dead`: `loadVaultAccounts()` hardcodes `status: 'healthy'`
> (`claudeAccountPool.ts:761`), and `loadConfigAccount()`'s `'dead'` ternary
> (`claudeAccountPool.ts:815`) is unreachable, because the function already returned null on a
> missing refresh token twelve lines earlier (`claudeAccountPool.ts:798`). The only live producer of
> a dead Anthropic account is `failoverClaudeAccount` (`claudeAccountPool.ts:375`), reached from one
> call site inside request retry (`src/services/api/withRetry.ts:565`); it mutates in-memory pool
> state in whichever SESSION process made the failing request, and deliberately does not persist
> (`claudeAccountPool.ts:360-364`). So the dead verdict lives in a different process from the one
> that feeds the page, and every worker run re-derives that same account as healthy.
>
> This is the asymmetry with Codex, and it is why the sibling feature works: a dead Codex account is
> derived from `refresh.state === 'reauth_required'` (`codexAccountPool.ts:1197`, verdict at
> `:1221`), which is PERSISTED in the vault file, so a fresh worker load reproduces it — and clearing
> it on a new token is what makes "Sign in again" visibly repair the row.
>
> **Not a blocker, for the record:** the Anthropic heal path itself is real and would have worked.
> The sidecar runner's `persist()` (`app/sidecar/accountsDomain.ts:351`) calls `installOAuthTokens`
> (`src/cli/handlers/auth.ts:113`), which for a claude.ai login calls `appendClaudeAccount`
> (`auth.ts:156`); that upserts on `accountUuid` and explicitly resets `acct.status = 'healthy'`
> (`claudeAccountPool.ts:429`), keeping the alias and creating no duplicate row. The mechanism is
> sound; there is simply no dead row on this surface for it to heal.
>
> **Ruled:** no "Sign in again" control on Anthropic rows, and `selectAccountsNeedingSignIn` stays
> Codex-scoped with its label unchanged. A control gated on `status === 'dead'` would be unreachable
> in the preferred feed, and in the one narrow window where a session's own snapshot still fills the
> page (the launch gap before main's first worker run, `accountsState.ts:257`) its effect would be
> indistinguishable from the next worker run healing the row anyway. Reopen this ONLY if the
> Anthropic dead verdict becomes persistent the way the Codex one is — that is an engine-side change
> to `claudeAccountPool.ts`, not a renderer one, and it is the actual prerequisite.
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
