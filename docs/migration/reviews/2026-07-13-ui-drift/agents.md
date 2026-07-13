# Agents page + agent chrome/identity drift — prototype vs impl (2026-07-13)

**Our:** `app/renderer/src/AgentsPage.tsx`, `app/renderer/src/AgentChrome.tsx` (+ vocab substrate `app/renderer/src/agentIdentity.ts`)
**Prototype:** `~/catcode_prototype/cat-app/AgentsPage.jsx`, `~/catcode_prototype/cat-app/AgentIdentity.jsx`
**Built status:** built. `AgentsPage.tsx` is P4-7 (`STATUS.md:270`, ✅ 2026-07-07), read-only agent-definition snapshot, ledger section 19 (`PARITY-LEDGER.md:1341-1393`). `AgentChrome.tsx` is the P4-8a chip/pip primitive layer (`STATUS.md:271`), wired into `TranscriptView.tsx`, `WorkerFocusView.tsx`, `OrchestratorRoster.tsx`, `OrchestratorPage.tsx` — none of which are this area's scope, but the primitives themselves are.

## Scoreboard — H:0 M:2 L:1

## Findings (High → Low)

[SEVERITY Med] `AgentHandle` name color: prototype's real usage renders the mono `@handle`/name in lavender `#e9d5ff` (Tailwind `purple-200`) by default — `AgentIdentity.jsx:116-118` (`AgentHandle` default `color = '#e9d5ff'`), exercised with no override at every real call site (`Chat.jsx:1177`, `OrchestratorMode.jsx:767`, both `<window.AgentHandle name={...} size={13} />`). Our `AgentHandle` (`AgentChrome.tsx:106-112`) hardcodes `text-text-primary` (`--color-text-primary: #f4f4f5`, `theme.css:48`) and takes no color prop at all, and every call site (`WorkerFocusView.tsx:86`, `OrchestratorRoster.tsx:67,108`, `OrchestratorPage.tsx:181`) calls it with no override. Every agent/worker handle in the app renders near-white instead of the prototype's lavender tint. Fix: swap the hardcoded class for `text-purple-200` (Tailwind's exact `#e9d5ff`), or add an optional tone prop defaulting to it.

[SEVERITY Med] `AgentTypeChip` typography: prototype (`AgentIdentity.jsx:104-112`) renders the type/role chip `uppercase`, `fontWeight: 700`, `letterSpacing: '0.05em'`, DM Mono (`MONO_FF`), `fontSize: 9.5` (md). Our `AgentTypeChip` (`AgentChrome.tsx:92-103`) uses `text-[10px] font-semibold` only — no `uppercase`, no `tracking-*`, no `font-mono`, and `font-semibold` (600) not bold (700). Real consumers exercise the default/md size with no size override (`WorkerFocusView.tsx:87`, `OrchestratorPage.tsx:182`, matching the prototype's own unsized calls at `Chat.jsx:1178`/`OrchestratorMode.jsx:768`), so this is live, visible drift, not a deferred/unbuilt component (ledger row `PARITY-LEDGER.md:1462` calling `AgentTypeChip` "deferred → P4-8b" is stale — see Doc-drift notes). Fix: `uppercase font-bold font-mono tracking-[0.05em] text-[9.5px]`.

[SEVERITY Low] Cyan hex mismatch in two static maps: prototype's `AG_COLORS.cyan` / `AG_SOURCES.plugin.color` are the literal `#22d3ee` (`AgentsPage.jsx:16,25`) — Tailwind's `cyan-400`. Our `AGENT_DOT_CLASS.cyan` (`AgentsPage.tsx:66`, `'bg-cyan-300'`) and `SOURCE_META.plugin.className` (`AgentsPage.tsx:29`, `'text-cyan-300 bg-cyan-300/10 border-cyan-300/25'`) both resolve to Tailwind `cyan-300` = `#67e8f9`, a visibly lighter/washed-out cyan than the prototype's. Same family, wrong shade — token→hex check (rule 3) fails for this one color. Fix: `bg-cyan-400` and `text-cyan-400 bg-cyan-400/10 border-cyan-400/25`.

## Deferred / intentional (not drift)

- "New agent" button + create action — **DEFERRED**: `PARITY-LEDGER.md:1392`, cut, `STATUS.md:223` §0 flag, no owner session. Header "Read-only snapshot" badge (`AgentsPage.tsx:99`) is the flagged real-added replacement (`PARITY-LEDGER.md:1388`).
- Drawer "Edit definition" / "Duplicate" buttons + edit/duplicate actions — **DEFERRED**: `PARITY-LEDGER.md:1393` and the Duplicate row directly below it (same file, cut), `STATUS.md:223`.
- Toast host + "(demo)" action toasts — **DEFERRED/INTENTIONAL**: `PARITY-LEDGER.md` (toast row directly under the Duplicate row), cut — no write actions exist to signal.
- System-prompt body withheld, replaced by a notice — **INTENTIONAL**: secret-boundary (`agentConfigDomain.ts:92`), `PARITY-LEDGER.md:1385`, `STATUS.md:223`.
- Row dimming keyed on `available` (derived `active && mcp-ok`) instead of the prototype's `overridden || mcpMissing` — **INTENTIONAL/equivalent**: verified via `agentConfigDomain.ts:85-89` — an overridden def's `active` is `false`, so `available` is already `false` for both the overridden and mcp-missing cases; same visual result via a real derived field. Tracked as adapted at `PARITY-LEDGER.md:1362` (row above the color-dot row).
- Summary cards (Active/Unavailable/Overridden), "Scope flags" info box, failedFiles banner, extended drawer config rows, "active"/"inactive" pill — all **INTENTIONAL real-added** (`PARITY-LEDGER.md`, several `➕ real-added` rows in the section-19 table), not prototype elements, not drift.
- `AGENT_DOT_CLASS` / `AGENT_STATE_TONE_CLASS` / `AGENT_TYPE_TONE_CLASS` are all static literal hex→class maps with a colocated test (`AgentChrome.test.ts`) asserting no interpolated/arbitrary classes — the Tailwind v4 dynamic-class trap (P4-9 colourless-badge bug, `STATUS.md:272`) does **not** recur here.
- `Baton`/`LifeDot` in `AgentChrome.tsx` are ported from `OrchestratorMode.jsx`, not `AgentIdentity.jsx` — out of this area's assigned prototype-file pair; spot-checked anyway (`OrchestratorMode.jsx:187-208`) and colors/shape line up with `AgentChrome.tsx`'s `AgentPip`/`Baton`. Full fidelity is the Orchestrator area's call.

## Doc-drift notes

- `PARITY-LEDGER.md:1364` claims the agent color dot's "8-color palette preserved" — true for 7/8, false for cyan (see Med/Low findings above); the ledger row should eventually note the cyan mismatch, but per the review's read-only-on-docs rule this is flagged here, not edited.
- `PARITY-LEDGER.md:1462` (section 20) states `AgentTypeChip` is "deferred → P4-8b (its only consumer is the worker-detail drilldown; not built now to avoid dead code)". Current source contradicts this: `AgentChrome.tsx:92-103` implements it and it is actively consumed by `WorkerFocusView.tsx:87` and `OrchestratorPage.tsx:182`. Rows `PARITY-LEDGER.md:963` (same claim, section-20 preamble) are equally stale. Source wins per review rule 5 — treated as built for this review, and its typography drift is reported as a real Med finding above, not filed as deferred.
