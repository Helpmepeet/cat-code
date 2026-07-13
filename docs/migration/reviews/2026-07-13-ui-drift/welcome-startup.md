# Welcome / startup / workspace-trust drift — prototype vs impl (2026-07-13)

**Our:** `app/renderer/src/WelcomeScreen.tsx`, `app/renderer/src/StartupSurfaces.tsx`, `app/renderer/src/WorkspaceTrustSection.tsx`
**Prototype:** `~/catcode_prototype/cat-app/Welcome.jsx`, `Startup.jsx`, `ResumeStates.jsx` (+ `Pages.jsx:789` `WorkspaceTrustSection`, the real analog of our `WorkspaceTrustSection.tsx`)
**Built status:** built. WelcomeScreen = P4-17 (`STATUS.md:280`, merged `3d937b6`, extended 2026-07-13 with CodexRow reskin/branch/orchestrator-toggle commits); StartupSurfaces (trust gate + first-run OAuth) = P4-15 (`PARITY-LEDGER.md:1830` build manifest); WorkspaceTrustSection = P4-14 (`STATUS.md:277`). All three ⬜ awaiting final operator GUI sign-off but code-complete and headless-green.

## Scoreboard — H:0 M:3 L:6

## Findings (High → Low)

[Med] "Sign in" pill + Codex-icon avatar wrong color family (pink instead of blue): prototype paints both with a distinct blue `#60a5fa` (`Startup.jsx:102-104` Pill, `Startup.jsx:115` icon avatar: `background rgba(96,165,250,.1)`, `border rgba(96,165,250,.22)`, `color #60a5fa`) — we render both with `tone="info"` / `text-tone-info` (`StartupSurfaces.tsx:221` Pill, `StartupSurfaces.tsx:232-234` icon avatar), and `--tone-info: var(--accent)` (`theme.css:28,60`) resolves to the pink accent `#f472b6`, not blue. The codebase already has the exact hex as a token (`--color-source-project: #60a5fa`, `theme.css:67`). Fix: give `--tone-info` its own blue value (e.g. `#60a5fa`) instead of aliasing `--accent`, or point this one screen's Pill/icon at `text-[#60a5fa]`/`border-[#60a5fa]` literals matching the prototype.

[Med] Popover/button borders under-emphasized: prototype specifies `rgba(255,255,255,0.1)` for the ProjectPicker dropdown panel border (`Welcome.jsx:236`) and the Startup `SecondaryButton` border (`Startup.jsx:281`) — we use `border-shell-seam` in both places (`WelcomeScreen.tsx:235`, `StartupSurfaces.tsx:92`), and `--color-shell-seam: rgba(255,255,255,0.06)` (`theme.css:38`) is 40% less opaque. Fix: use a literal `border-white/10` (or a new token) for these two elements instead of the seam token, which is meant for internal dividers, not raised-surface/button borders.

[Med] ProjectPicker dropdown reads as flat-black, not a raised popover: prototype's dropdown panel background is `#141416` (`Welcome.jsx:236`), a lighter surface than the page. Ours uses `bg-shell-chrome` (`WelcomeScreen.tsx:235`), which is `#070709` (`theme.css:37`) — the app's darkest chrome/rail color, nearly indistinguishable from `app-bg` (`#09090b`). The codebase already has a token built for exactly this ("a toast/popover sits one step ABOVE the app body", `theme.css:41-45`): `--color-surface-raised: #111113`. Fix: swap `bg-shell-chrome` → `bg-surface-raised` on the dropdown panel.

[Low] First-run OAuth spinner loses its pink-tinted ring: prototype's ring is `border: 2px solid rgba(244,114,182,0.2)` with `borderTopColor: #f472b6` (`Startup.jsx:199-205`, a subtle all-pink glow ring with a brighter top segment) — ours is `border-shell-seam border-t-accent` (`StartupSurfaces.tsx:209`), i.e. a neutral gray ring with only the top segment pink. Fix: `border-accent/20 border-t-accent`.

[Low] Recurring gray-token rounding on several quiet micro-labels: prototype uses a dimmer `#52525b` for the ProjectPicker "Recent" section header (`Welcome.jsx:237`), the ⌘O hint (`Welcome.jsx:257`), the Radio off-state border (`Welcome.jsx:138`), the trust-gate "Workspace" label (`Startup.jsx:45`), and the "Additional trusted directories" description (`Pages.jsx:811`) — all five land on `text-text-subtle`/`border-text-subtle` in ours (`WelcomeScreen.tsx:239,273,533`, `StartupSurfaces.tsx:161`, `WorkspaceTrustSection.tsx:71`), and `--color-text-subtle: #71717a` (`theme.css:50`) is a full shade lighter than `#52525b`. There is no darker "faint" token in `theme.css` to reach for. Fix: only worth doing if this pattern recurs across other areas too (add a `--color-text-faint: #52525b` token); otherwise treat as accepted 3-gray-token granularity.

[Low] "Welcome back" greeting is a touch smaller than the prototype: prototype `fontSize: 28` (`Welcome.jsx:470`) vs ours `text-[26px]` (`WelcomeScreen.tsx:100`). Minor, but distinct from the already-tracked H1-wordmark resize (see Deferred). Fix: `text-[28px]` if exactness is wanted.

[Low] Codex-table healthy-status dot missing its glow: prototype's green dot carries `boxShadow: '0 0 8px rgba(74,222,128,0.6)'` (`Welcome.jsx:510`) — ours is a flat dot, no shadow (`WelcomeScreen.tsx:432-437`). Fix: add a small drop-shadow utility, e.g. `shadow-[0_0_8px_rgba(74,222,128,0.6)]` when healthy.

[Low] Trust-state badge changed from a readable sans-serif pill to a tiny mono/uppercase micro-chip: `Pages.jsx:797` renders "Trusted"/"Untrusted" at `fontSize:11, fontWeight:600`, plain case, no letter-spacing; ours renders it `font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em]` (`WorkspaceTrustSection.tsx:38-46`) — matching this app's other status-chip idiom (e.g. the "capped"/"untrusted" badges elsewhere in `WelcomeScreen.tsx`) rather than the prototype's plainer Settings-row badge. Colors/alphas match exactly; only the type treatment differs. Likely a deliberate app-wide chip convention rather than an oversight — flagged for awareness, not necessarily a fix.

[Low] "Additional trusted directories" path text is brighter than the prototype (opposite direction from the gap above): `Pages.jsx:817` uses `color:'#71717a'` for each directory's mono path; ours uses `text-text-muted` (`WorkspaceTrustSection.tsx:84`), i.e. `#a1a1aa` (`theme.css:49`) — one shade brighter. Fix: `text-text-subtle` to match exactly.

## Deferred / intentional (not drift)

- Branch chooser + "New worktree" start-in option cut from the launcher — DEFERRED/INTENTIONAL: D5 ruling, `decisions/WELCOME-LAUNCHER.md` Q2; `WelcomeScreen.tsx:29`. (Branch is now shown read-only in the session variant per the 2026-07-13 STATUS entry, `STATUS.md:280`.)
- Greeting username ("Welcome back, pim" → "Welcome back") — DEFERRED: no engine-user seam yet, `PARITY-LEDGER.md:1948`.
- Hero wordmark sized smaller than the prototype (`clamp(56px,10vw,120px)` vs `clamp(72px,11vw,140px)`) — INTENTIONAL, already logged as a "tighter shell" adaptation, `PARITY-LEDGER.md:1947`. (The separate, unlisted "Welcome back" 26px-vs-28px delta above is new and not covered by that line.)
- `ReadOnlyModeGate` / `WorkspaceSwitchPrompt` / blocking `ReauthGate` — INTENTIONAL cuts, D4 ruling, `decisions/STARTUP-GATES.md`; reflected in `StartupSurfaces.tsx:7-13`. Reauth is a non-blocking banner (`reauthBannerState.ts`) instead.
- OAuth `waiting_for_alias` step, `error` state, paste-code fallback URL, and reauth `waiting/success` sub-states — DEFERRED: `PARITY-LEDGER.md:1830` (P4-15 §0), needs an engine-side live-progress back-channel; our `StartupOAuthPhase` is intentionally only `'ready' | 'waiting'`.
- `ResumeStates.jsx` in its entirety (HydrationOverlay loading/failed + CrossProjectResumeDialog) — INTENTIONAL ✂️ CUT: operator ruling 2026-07-09, `STATUS.md:284` (P4-22), `PARITY-LEDGER.md:1891-2213`. Restore is now frictionless/instant (matches Claude/ChatGPT); do not re-implement.
- "Additional trusted directories" +Add / × remove mutate controls — DEFERRED (read-only view only): `PARITY-LEDGER.md:1056`, "no owner session yet" — honestly tracked, not silently dropped.
- Trust "Untrust/Trust" button rendered disabled — INTENTIONAL: mutate action lives in P4-15's session-create gate, not this Settings view; `PARITY-LEDGER.md:1053`.
- Orchestrator toggle read-only in the launcher variant, interactive in the session variant — INTENTIONAL: no session exists yet in the launcher to toggle; `WelcomeScreen.tsx:331-339`, `decisions/AGENT-MODE-TOGGLE.md`.

## Doc-drift notes

- `PARITY-LEDGER.md:1984` describes the Codex-table header stat as "N accounts · M **ready**" (a stricter healthy-and-not-capped `readyCount`). Current source computes and renders `healthyCount`/"healthy" (`WelcomeScreen.tsx:406-410,429-431`), which actually matches the prototype's own `healthy` semantics (`Welcome.jsx:434`) more faithfully than the ledger describes — the ledger line is stale, not the source.
