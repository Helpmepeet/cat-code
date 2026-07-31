# Prototype coverage of the UX gap audit

**Date:** 2026-07-31
**Revision:** rev 3 (this document)
**Companion to:** `2026-07-31-app-ux-gap-audit.md`, currently at its rev 5
**Question answered:** for each audit finding, does the prototype already solve it, and if so how?

## Why this exists

The audit says what is missing. It does not say whether a design already exists for it. That
distinction decides the work: porting a prototype design is cheap and low-risk, whereas inventing one
needs a design decision and, on this program, often an operator ruling. This document classifies all
27 audit findings plus the two operator questions.

Sources: `~/catcode_prototype/cat-app/` (read-only UX spec, 30 surfaces), indexed through
`docs/migration/PARITY-LEDGER.md` Part A, with every claim confirmed against prototype source.
Where the ledger and the source disagree, source wins and the drift is recorded in
[Ledger drift](#ledger-drift-found).

## Buckets

- **A — design exists, we deferred or missed it.** Port target, startable now.
- **A-blocked — design exists, but a missing wire seam or unassigned owner prevents starting.**
  Needs a seam/boundary owner before renderer work.
- **B-ratified — design existed; a recorded operator decision removed it.** Acting on it reopens
  that decision. **Not a backlog item without an operator ruling.**
- **B-undocumented — design existed; we adapted away with no decision doc behind it.** Reversible by
  the owning session; **no operator ruling required.**
- **B-rejected — design exists but is incompatible with the real contract.** Do not port.
- **C — prototype does not cover it.** Genuine design work.
- **D — structurally not applicable** to a browser SPA. Reserved for things a browser page *cannot*
  have (an Electron window minimum), **not** for things it merely lacks. Accessibility and light
  theme are things the prototype could have had and did not, so they are C.

> **Rev 2: classification is atomic.** Rev 1 gave one bucket per audit finding, which was not
> reproducible: several findings are composites whose halves land in different buckets (file
> completion vs attachments; the connection guard vs the tone grammar; the blocking reauth modal vs
> a non-blocking quota surface). Composites are split into lettered sub-items and totals computed
> over those.
>
> **Rev 3: the bucket taxonomy now encodes disposition, not just provenance.** Rev 2's single **B**
> conflated "an operator ruled this out" with "a session adapted this away without a decision doc",
> which are opposite instructions to a backlog author. It also filed two seam-blocked items as
> startable. Splitting **B** three ways and moving 9 and 10a to **A-blocked** fixes both.

**Split over 38 atomic items**

| Bucket | Count | Items |
|---|--:|---|
| **A** — port now | 5 | 6, 7, 15, 19, 20 |
| **A-blocked** — needs a seam/boundary owner | 3 | 9, 10a, 16a |
| ~~**B-ratified**~~ — **all resolved 2026-07-31** | 0 | (was 2a, 24b, 26d, O1, O2a — see Operator rulings) |
| **B-undocumented** — reversible, no ruling needed | 2 | 3, 12 |
| **B-rejected** — do not port | 1 | 5a |
| **C** — fresh design | 21 | 1, 2b, 4, 5, 8, 10b, 11, 13, 14, 16b, 16c, 17, 18, 21, 22, 23, 24a, 25, 26b, 26c, O2b |
| **D** — structurally N/A | 1 | 26a |

Two headline numbers: **21 of 38 need fresh design** (rev 1 said 12 of 27, flattered by letting a
composite's stronger half set the whole finding's bucket), and **as of the 2026-07-31 operator
rulings, 15 are startable** — bucket A (6, 7, 15, 19, 20), plus 24a, 3, 12, 26a, 26c, 26d, and the
four just ruled (2a, 24b, O1, O2a). Nothing is left awaiting a ruling.

Readiness within those 15: **9 need no further input** (24a, 6, 12, 19, 24b, 26a, 26c, 26d, O1),
**4 are real implementation work** (7, 20, O2a, 2a), **1 is gated on a contract decision** (15, the
sidecar key-clear path), and **1 is large but unblocked** (3).

---

## Summary table

| # | Finding | Bucket | Prototype source | Ledger disposition |
|---|---|---|---|---|
| 1 | Mid-turn typing swallowed, no queue | **C** | `Chat.jsx:632,1413` (no queue; composer stays editable) | §06 ➕ real-added (gating is app-only) |
| 2a | Account/trust gate without a session | **RULED** → copy only | `Startup.jsx:461-489`, `AppV2.jsx:45-48` | §27 🔁 adapted (STARTUP-GATES §1.1) |
| 2b | Session-free **user-settings read** | **C** | prototype has no session concept, so it cannot inform | §11 — user layer is session-invariant |
| 3 | Permission card shows raw JSON | **B-undocumented** | `Permissions.jsx:61-75,544-556` | §07 🔁 adapted, **no decision doc** |
| 4 | Tab bar shows no working session | **C** | `TabBar.jsx` (title + close only) | §03 44 rows, 0 ⬜/0 ❓ |
| 5 | Failed turn drops its error text | **C** | `Messages.jsx:1694-1710` | §05 ResultRow ✅ built |
| 5a | Retention `0` destroys history silently | **B-rejected** | `Settings.jsx:257-261` (30/60/90/Forever select) | §11 🔁 adapted → `IntField` |
| 6 | Read/Write truncation; inspector uncopyable | **A** | `Messages.jsx:255-352,438-457` | §05 🔁 adapted — **contradicted by source** |
| 7 | Cannot copy an assistant message | **A** | `Messages.jsx:2064-2091` | §05 ⬜ deferred |
| 8 | Shell failures in an undismissable bar | **C** | `AppV2.jsx:206-215` (grammar only) | §12 BannerStack ✅ built, zero importers |
| 9 | Interrupt renders as a fake user message | **A-blocked** | `Messages.jsx:1181-1193` | §05 ⬜ deferred — **blocker stale** |
| 10a | No **file completion** in mentions | **A-blocked** | `Surfaces.jsx:1031-1085` | §12 tabs 🔁, `MENTION_ITEMS` ✂️ cut |
| 10b | No **attachment payload** | **C** | `Chat.jsx:1435` is itself a stub toast | §06 attach stub 🔁 (faithful parity) |
| 11 | Drafts/history lost on restart | **C** | `Chat.jsx:387` (in-memory) | §06 ✅ built (in-run only) |
| 12 | Permission shortcuts dead when advertised | **B-undocumented** | `Permissions.jsx:363,437` | §07 🔁 adapted |
| 13 | Palette lands on wrong settings pane | **C** | `CommandPalette.jsx:126-138` | §09 no scope/category row |
| 14 | `⌘O` unbound; palette has no affordance | **C** | `Welcome.jsx:257` + `AppV2.jsx:114-116` | §29 ✅; chord set has no `o` |
| 15 | No reset-to-default for engine settings | **A** | `Settings.jsx:98-122` (engine-settings fields) | §11 ✅ — **primitive only** |
| 16a | **Goals** writer controls | **A-blocked** | `GoalsPage.jsx:63,110-115,226-260` | §22 25 rows ❓ **UNASSIGNED** |
| 16b | **Memory** auto-memory toggle | **C** | no prototype toggle | §23 ➕ real-added line |
| 16c | **Agents** path affordance | **C** | see F4 note — prototype action is a stub | §19 100% |
| 17 | Sessions-page state resets on open | **C** | `SessionsPage.jsx:118,253` (same defect) | §16 no persistence row |
| 18 | Cold launch flashes empty; failed read forever | **C** | `ResumeStates.jsx:26-56` (nearest analogue) | §28 ✂️ cut whole (P4-22) |
| 19 | Actions menu runs off the bottom | **A** | `SessionActions.jsx:112-113` | §17 🔁 — **admits absence** |
| 20 | Welcome says terminal projects can't open | **A** | `Welcome.jsx:216,238-260` | §29 ✅ (disabled state un-ledgered) |
| 21 | Same-workspace sessions indistinguishable | **C** | mock sessions all have distinct titles | §03/§16 no collision row |
| 22 | Settings search misses long lists | **C** | `Settings.jsx:695-699` (nav labels only) | §11 ✅ — app is ahead |
| 23 | Model picker drops descriptions | **C** | `Settings.jsx:217-220` (bare select) | §11 ✅ built 2026-07-30 |
| 24a | Benign `starting` renders as red failure | **C** | **no `starting` state in `CONN_STATES`** | — |
| 24b | No connection **tone grammar** at all | **RULED** → two-tone | `Surfaces.jsx:1150-1160` (4 states) | §12 ✂️ cut (CC-5 #6) |
| 25 | Accessibility gaps | **C** | prototype has none either: 0 `aria-live`, and only a handful of static `role=` attributes | — |
| 26a | No minimum window size | **D** | a browser page has none | — |
| 26b | Dark-only, no light theme | **C** | prototype is hardcoded dark; could have had one | — |
| 26c | Rendered engineering notes | **C** | prototype renders none; all three are app-authored | — |
| 26d | Remote rail advertises cut SSH mode | **actionable** (copy) | `RemoteSettings.jsx:184` | §26 ✂️ cut (PAIRED-DEVICES) |
| O1 | Sidebar session state | **RULED** → live dot | `Sidebar.jsx` row = title only | §02 ✂️ cut (operator 2026-07-20) |
| O2a | Blocking reauth gate | **RULED** → pinned banner | `Startup.jsx:389-458` (`ReauthGate`) | §27 ✂️ cut (STARTUP-GATES #12) |
| O2b | **Non-blocking** quota surface | **C** | no prototype design exists | — |

---

## Bucket A — port these

### 7. Assistant copy chip — the cheapest win

`cat-app/Messages.jsx:2064-2091`. The prototype answers exactly the question audit rev 3 said needed
designing. The assistant body is already a positioned container: outer flex row, then an inner
`position:relative` bubble (`padding:11px 15px`, `borderRadius:'4px 16px 16px 16px'`,
`background:rgba(255,255,255,0.04)`). The chip is `position:absolute; bottom:6; right:8`, a 13×13
clipboard SVG swapping to a tick, revealed by `opacity: (hover || copied) ? 1 : 0` driven by
`onMouseEnter`/`onMouseLeave` on the bubble. Colors: idle `#71717a`, hover `#d4d4d8`, copied
`#86efac`, reverting after 1300ms.

Two gates worth copying verbatim:

- `showCopy = !msg.streaming && (msg.content || '').trim().length > 0` — no chip while streaming or
  on an empty turn.
- The copied payload is `msg.content`, the **raw markdown source**, not rendered DOM.

Toast copy: `Copied response` (the user-bubble twin says `Copied message`).

The app already shipped the twin (`BubbleCopyChip`, defined at `TranscriptView.tsx:1329`, mounted in
`UserBubble` at `:1406`) and improved it with `group-focus-within` for keyboard reach. Work is giving
`AssistantProse` the same `relative group` wrapper with corner padding. No mock-data dependency.

### 19. Menu bottom-flip — two lines

`cat-app/SessionActions.jsx:112-113`, verified verbatim:

```js
const placeAbove = anchor.top > window.innerHeight - 320;
const pos = placeAbove ? { bottom: window.innerHeight - anchor.top + 4 } : { top: anchor.top + 4 };
```

The threshold is a **constant 320, not a measurement**. Placement lives inside the menu component,
and the flip anchors to `bottom` so the menu grows upward with the same 4px offset either way. The
app's own `placeTagPopover` (`sessionsPageState.ts:237`) is a tested implementation of the same idea
and is compatible.

**Rev 2 correction — the audit's UNVERIFIED caveat stands.** Rev 1 of this document claimed the
prototype constant retires it. It does not: the constant establishes that *inferring* the height is
the intended design, not that 320 is the right number for the app's menu, whose row set, fonts, zoom
and viewport all differ. Two separate things remain unverified — whether the app's menu clips today,
and what threshold it needs. Unit-test the placement helper and confirm clipping in the live app.

### 6. Output inspector — copy, search, wrap, and progressive reveal

The `OutputInspector` drawer (`cat-app/Messages.jsx:255-352`) carries four things the app lacks:

- **Copy** button writing the active stream's text, toast `Copied output` (`:337-340`).
- **Search** field computing matching line numbers, showing `k/N`, with `‹ ›` steppers that wrap
  around and scroll the active line to vertical center with a highlight (`:271-284,325-335`).
- **Wrap** toggle.
- Stdout/stderr **tab pills** with per-stream line counts, when both exist.

The reveal band (`:438-457`) is the other half: a strip reading `{N} lines hidden`, then **Show
{min(100, remaining)} more** and **Open full output ↗**. The window is head+tail (`HEAD0 = 30`,
`TAIL = 6`), so the last 6 lines always stay visible. The app's `ToolOverflowNote` collapses this to
one sentence with no progressive reveal and no tail.

**Where a port stalls:** the `capped at {bytes}` suffix needs byte metadata the projector does not
carry, and the stream tabs need a stdout/stderr split the fold does not preserve. Copy, search,
match-stepping, wrap, and head+tail windowing need none of that.

### 9. Interrupted seam

`cat-app/Messages.jsx:1181-1193`. A centered rule-flanked seam matching the existing `ResultRow`
skeleton: `flex`, `gap:12`, a `flex:1` 1px rule of `rgba(248,113,113,.2)` each side, and a nowrap
11.5px center group of three spans — `Interrupted` in `#f87171` weight 600, a `·` in `#3f3f46`, and
`What should Claude do instead?` in `#71717a`. No props, no variants: the prototype's own comment
records that the engine's copy is identical for tool and non-tool aborts, so the distinction stays
out of the visual.

**The ledger's blocker for this row is stale.** §05 claims the carrier is "suppressed at the
projector" via `isSynthetic`. Verified false: `createUserInterruptionMessage`
(`src/utils/messages.ts:557-572`) calls plain `createUserMessage` and sets no synthetic or meta flag.
The audit's own analysis is correct — it lands as an ordinary `UserBubble`. The provenance
prerequisite still stands (do not string-match the literal in the renderer), but the ledger's
"nothing reaches the renderer" premise must not be used to size the work.

### 15. Reset-to-default on every field

`cat-app/Settings.jsx:98-122`. The prototype's `Field` primitive takes `modified` and `onReset` and
renders a borderless 11px `#71717a` button reading exactly **"Reset to default"**, right-aligned
under the control, shown only when `modified`. **Every *engine-settings* field passes both** — the
uniform idiom is `modified={g.key !== DEF.key} onReset={() => reset('key')}`. (Rev 2 correction: rev 1
said "every field", which is false — the IDE pane's fields at `Settings.jsx:510` pass neither, since
they are local connection toggles rather than settings-file keys.) One deliberate exception (`:181`): a
`flag`-sourced field passes `modified` unconditionally with an `onReset` that raises the warn toast
"Flag overrides cannot be reset from settings".

**The app's ✅ is on the primitive, not the wiring.** `SettingsField.tsx:184-192` renders the button
correctly. `SettingsEditors.tsx:189-196` passes `desc`/`editable`/`label`/`managed`/`origin`/`source`
and never `modified` or `onReset` — verified: zero matches for either prop in that file. The only two
call sites in the shell are app-local prefs (`SettingsShell.tsx:788,864`). So all 14 registry keys
ship without the control.

The port is not literally two props, because semantics differ: the prototype's reset **writes the
default value back**, while the app must **remove the key**, which today only `dynamic-enum` produces
via `SETTINGS_ENGINE_DEFAULT`.

### 20. Recents are always openable

`cat-app/Welcome.jsx:216,238-260`. Every recent row is a live button. `choose(path)` has exactly one
branch: untrusted routes to the trust prompt, otherwise commit and open. There is **no disabled
state** and no "cannot be restored" copy anywhere.

> **Rev 2 correction — do not implement this as a deletion.** Rev 1 said to "delete the invented
> disabled recent row" and listed it under *port now*. Following that literally ships a **clickable
> no-op**: a history-only workspace is deliberately given `appSessionId: null`
> (`sessionsCatalogState.ts:587-595`), and **both** the picker handler (`WelcomeScreen.tsx:246`) and
> the App callback (`App.tsx:2891`) early-return on that value. Removing the disabled rendering alone
> makes the row look live while every click is silently discarded.
>
> The disabled state is also not "app-invented" in the way rev 1 implied. It is the documented
> consequence of the launcher opening by app id, and the owning doc comment already names the fix:
> "the sidebar/Sessions page now open a history row by its ENGINE id via `openHistorySession`
> (SESSIONS-UNIFICATION 2026-07-20) — the launcher could adopt that same path, a follow-on not wired
> here." What the prototype contributes is the *target state* (no inert rows), not the mechanism.

**Correct shape**, which is what the companion audit's finding 20 already said: carry a
representative history `engineSessionId` on `RecentWorkspace`, and route null-app-id recents through
the existing `openHistorySession` path (`App.tsx:1709-1757`) that `openCatalogRow` already uses for
history rows. That path is HC1-safe because main resolves the workspace from the engine-written
baseline rather than from a renderer-supplied string — do **not** introduce a path-authored IPC.
Needs a selector test and a wiring test. Keep the disabled state only for the genuinely unresolvable
case (`cwd === ''`).

Port the **openability**, not the modal: the prototype's in-picker trust modal is ledgered adapted
(the real gate fires post-spawn), and its `Open read-only` action is a recorded cut.

### 16 (Goals half only). Goal writer controls

`cat-app/GoalsPage.jsx`. The roster is not read-only: per row, a contextual strip renders **Resume**
when paused, **Pause** when active, and **Replace** plus a danger **Clear** for any non-terminal
goal. The header carries a primary `+ Create goal`. `CreateGoalDialog` (`:226-260`) is a modal with
an Objective textarea, a Token budget number input defaulting to `500000`, `⌘↵` submit and `Esc`
cancel, and a Create button disabled while the objective is empty.

**This is the port that cannot start.** All 25 rows are Part C ❓ with owner **UNASSIGNED**: the
desktop protocol carries no inbound goal-mutation verb, and P4-10 is spent. It is the single largest
un-owned cluster in the ledger and needs a goal-writer-boundary owner first.

---

## Bucket B — design existed, we moved away from it

**Read the sub-tag, not the letter.** `B-ratified` needs an operator ruling before it becomes a
backlog item; `B-undocumented` is reversible by the owning session with no ruling required;
`B-rejected` must not be ported at all.

| # | What the prototype had | What we did, and under what authority |
|---|---|---|
| 2a | App-level trust → OAuth gate before any session exists (`Startup.jsx:461-489`) | `STARTUP-GATES.md` §1.1 made trust **per-session-create**. This half asks to reopen that. Its own analysis (a sign-in surface with no process to carry the verb) is *why* the ruling exists. **Scope note:** the ruling governs trust and account writes only. It does **not** cover finding 2's settings half — see 2b below. Rev 1 of this document put all of finding 2 behind the ruling, which would have parked valid work. |
| 3 | 15-entry variant table: per-family accent, icon, kicker, `previewLabel`, `verb`, `showDiff` flag; inline command titles; `PQDiff` hunks for edits | Collapsed to one `JSON.stringify`. **This is an adaptation with no decision doc** — the S2 cuts cover lane colors and rule synthesis, not preview shape. Reversible without an operator ruling. |
| 5a | Retention is a four-option select: 30 / 60 / 90 / **Forever**. `0` is not in the domain | **B-rejected — do not port.** The prototype's enum is mock state, not the contract. The engine accepts any nonnegative integer and the desktop registry declares `{ kind: 'int', min: 0, max: 3650, default: 30 }` (`app/shared/settingsEditable.ts:240`), so an enum would delete every legitimate value the domain allows (7, 45, 365) and **`Forever` has no wire representation at all**. Keep the numeric field; treat `0` as an explicit destructive mode with confirmation, per the audit's finding 5a. Rev 1 of this document recommended the enum; that recommendation is withdrawn. |
| 10 | Mention picker with three source tabs, substring filter, mono rows, "No matches" empty state | Shipped as a source-agnostic primitive; `MENTION_ITEMS` cut as mock, IDE tab blocked on seam. Matches the audit's read-seam reclassification. **Attachment has no prototype design at all** — `Chat.jsx:1435` is itself a stub toast, so the app's stub is faithful parity. |
| 12 | On mount: blur the active element, focus a `tabIndex={-1}` card (`:363`, `:437`), bind keys on a window listener | Adapted to "window keydown ignores INPUT/TEXTAREA targets" — **the exact mechanism that kills the advertised keys**. The prototype is the fix; porting it reverts an adaptation. |
| 24 | Four-state connection grammar: `connected` green solid, `reconnecting` amber **pulse**, `disconnected` red ring, `reconnect_failed` red ring | CC-5 ruling #6 deleted `ConnectionChip.tsx`; the grammar died with the file and the replacement prints the raw status string. The one-line guard fix is right but leaves no tone grammar for the next transient. |
| 26 (SSH) | A real SSH connect mode with Host + Identity file fields inside a Direct/SSH/Proxy wizard | Cut per `PAIRED-DEVICES.md` §1-§3. The rail description advertises a consciously cut element; the audit's one-line copy fix is correct and the wire gap is not the reason. |
| O1 | Sidebar row is title only; no dot, no chip | Backs the operator's 2026-07-20 bare-row ruling. The closed-session hole is real but the prototype never anticipated it (it has no session-close lifecycle). |
| O2 | A **blocking** `ReauthGate` modal with dead-account panel and reason map | Cut under STARTUP-GATES #12. **There is no prototype design for a non-blocking, non-scrolling quota surface** — the operator's choice is between the request-time path and something net-new. |

---

## Bucket C — genuine design work, with the actual question

**All 21 C items appear below, in 20 rows** (16b and 16c share one row, since the same open-verb
question governs both). Rev 2 of this document listed only 15 and still claimed completeness.

| # | Design question |
|---|---|
| 1 | Does mid-turn text queue and drain, or just stay editable-but-unsendable as the prototype has it? The prototype never disables its composer and swaps send→Stop in place, which solves the *legibility* half for free. Sidecar acceptance of a queued submit decides the rest. |
| 2b | **Not blocked by STARTUP-GATES.** The user settings layer is session-invariant by design (`settingsScope.ts:33`: "the **user layer is session-invariant**, so My defaults reads correctly from whichever session supplied the snapshot"), so a session-free read of the user scope is architecturally clean and independent of the trust ruling. The prototype cannot inform this at all, having no session concept. Question: does the user scope move to a host-plane read on the CC-20 pattern, and what does the Settings page show for project scope while no session is attached? |
| 4 | What does "working" look like on a tab in a design language whose tabs are deliberately bare (44 rows, zero status elements)? Adjacent to the bare-row ruling — ask whether its reasoning extends from sidebar rows to tabs before building. |
| 5 | Where does multi-line failure text live relative to a one-line rule: inline, a new row kind beside `ApiErrorRow`, or a disclosure? Adopt the prototype's `RESULT_LABEL` map regardless — it maps the four error subtypes to sentences, where the app prints the bare word "Errored". |
| 8 | Which of the seven lifecycle failures are banners vs toasts, what is each titled, what does retry mean per verb? The banner *grammar* is already built and unimported; the missing artifact is not a component. Must state the account-health vs shell-lifecycle split up front or it reads as reopening STARTUP-GATES #12. |
| 11 | Should unsent drafts survive a quit; is `↑` history per-session or global; what does a restored session's history contain? The prototype's only `localStorage` uses are the startup gate and code theme, neither a precedent for prompt content. |
| 13 | Route-controlled `{page, scope, category}`. The prototype does have partial deep-linking, but via a **remount key** (`AppV2.jsx:576`) — the mechanism the audit already rejected as inferior. The scope axis has no prototype precedent at all. |
| 14 | The prototype has the **same dead `⌘O` hint** and the same absent palette affordance, so this is inherited, not introduced. Question: is `⌘O` worth binding when the palette already exposes the capability, and where does a `⌘K` affordance live? |
| 17 | Is triage state app-level or persisted, and should opening a session leave the page at all? The prototype unmounts and loses everything exactly as the app does. |
| 18 | What is a launcher skeleton, and does a failed roster read get a retry surface? Note the nearest analogue (`HydrationOverlay`, with loading and failed states) was **cut whole** by P4-22 as friction — reusing its copy without acknowledging that ruling would be a silent reversal. |
| 21 | What is the disambiguator (time / ordinal / prompt excerpt), and does it render in all four surfaces? The prototype's real answer is that every session has a distinct title, which points at title generation as the alternative fix. |
| 22 | One cross-panel search box or per-panel filters? **The app is already ahead of the prototype here** — the prototype searches nav labels only. The user expectation is real but the prototype set it up and never met it. |
| 23 | Popover-with-descriptions or helper text under a native select? The design exists on a *different* surface: the composer's `RunChip` popover renders title + description + tag chip per model. The app has already ported that as `ModelChip`. |
| 16b/16c (Memory, Agents) | An `autoMemoryEnabled` toggle and copy-path affordances are app-only asks. The prototype's analogue is **open the file** (`MemOpenBtn`, "Edit definition"), but both prototype actions are stubs and real file-opening is a privileged seam behind HC1 — see the gaps section. Question: does Memory get a real toggle, and do these pages get an open verb or only a copyable path? |
| 10b | Attachments have no design *and* no wire payload; `Chat.jsx:1435` is itself a stub toast, so the app's stub is faithful parity. Question: what is an attachment on this protocol — an inlined payload, a host-resolved handle, or (smallest) a path string inserted into the prompt, which is a different and much narrower feature that should not be sold as "attachments"? |
| 24a | The prototype has **no `starting` state** in `CONN_STATES`, so the guard fix is unbacked by design. Question: none for the one-line guard, which is unambiguous. The design question belongs to 24b: what replaces the cut four-state tone grammar for the *next* transient? |
| 25 | The prototype has no accessibility work to port (0 `aria-live`, no reduced-motion, no focus restore), so every sub-item is net-new. Questions: what does a turn-boundary announcement say; does reduced-motion follow the OS only or also the engine's `prefersReducedMotion` key; and is there a shared overlay-focus primitive or per-overlay handling? |
| 26b | The prototype is hardcoded dark and its code-theme picker deliberately never touches app chrome. Questions: does light mode follow the OS, the engine `theme` key, or an app-local pref; and do the tone tokens get re-derived for a light background, where several would fail contrast? |
| 26c | The prototype renders no engineering notes at all, so there is nothing to port. Question: for each of the three, what replaces it — a user action, a real state, or nothing? (`DeferredNote` and the image-tile note are roadmap prose; the raw notice discriminant is a debug tag.) |
| O2b | No prototype design exists for a non-blocking quota surface; the prototype's answer was the blocking `ReauthGate` that STARTUP-GATES #12 removed. Question: does quota state get a persistent non-scrolling surface at all, and if so how does it differ from the wall the operator rejected? |

---

## Ledger drift found

Four items where the ledger overstates what shipped. All verified against source.

1. **§05 `OutputInspector`** tagged "🔁 adapted (Esc, search+match-step, wrap, copy, capped footer)".
   `ToolInspector.tsx` is 137 lines with **zero** copy, search, or wrap; the only matches for those
   words are `whitespace-pre-wrap` CSS classes.
2. **§17 menu placement** tagged 🔁 adapted while its own evidence text says "No `placeAbove` /
   bottom-flip exists anywhere".
3. **§05 interrupt row** says the carrier is "suppressed at the projector" via `isSynthetic`.
   `createUserInterruptionMessage` sets no such flag.
4. **§11 per-field rows** are ✅/🔁 while **no** editable-settings field passes `modified`/`onReset`.
   The ledger tracks the primitive, not the wiring, so audit finding 15 was invisible to it by
   construction. **That granularity gap probably hides other wiring-level misses** and is the most
   consequential of the four.

---

## Five gaps the prototype covers that the audit never raised

1. **Open-the-file buttons — visual design only; the privileged seam does not exist.** Every
   CLAUDE.md row, the MEMORY.md index row, and every topic memory carries an open button
   (`MemoryPage.jsx:161,180`); `AgentsPage.jsx:306` has "Edit definition". The app has none, so three
   pages list files the user cannot reach.

   **Rev 2 correction — this is not a portable behavior.** Both prototype actions are stubs:
   `memOpen` is `window.toast('Opening {path} in your editor')` under the comment "open-to-edit is
   visual-only in the prototype" (`MemoryPage.jsx:31`), and the Agents edit action is
   `setToast('Edit … (demo)')` (`AgentsPage.jsx:86`). Opening a file for real is a **privileged
   main-process capability that the preload does not expose**, and `SECURITY-MINIMUM.md` HC1 states
   that the renderer never authors a filesystem path. So this needs a boundary owner and a host-API
   verb that takes a registry-resolved identifier rather than a path string. Building it from the
   prototype alone produces either another dead button or an unsafe arbitrary-path IPC.
2. **MEMORY.md oversize advisory** (`MemoryPage.jsx:163-171`): an amber callout reading "MEMORY.md is
   large — over 200 lines / 25 KB, so only part of it is loaded into context. Trim it or split
   memories into separate files."

   **Rev 3 correction — the condition is not silent, and the signal is not absent.** Rev 1 claimed
   both, on the strength of `rg 'oversize|MEMORY.md is large'` finding nothing in `app/` — which
   searched for the prototype's *copy* rather than the app's *mechanism*. The engine marks entries
   whose loaded content differs after the real 200-line / 25 KB truncation
   (`src/utils/claudemd.ts:389-404`, caps at `src/memdir/memdir.ts:34-38`), the sidecar preserves the
   bit (`app/sidecar/memoryDomain.ts:199`), and the page renders a `truncated` pill
   (`app/renderer/src/MemoryPage.tsx:178`). The ledger already classes the prototype banner as
   adapted for exactly this reason (`PARITY-LEDGER.md:1664`).

   **The real gap is narrower: the pill states a fact and not its consequence.** "truncated" does not
   say that part of the file is not reaching the model, nor what to do about it. Fix by adding
   consequence-and-action copy driven by the existing `contentDiffersFromDisk` bit. **Do not add a
   second, mock-threshold detector** — that would duplicate engine machinery (§8 rule 10) and put two
   disagreeing truncation states on one page.
3. **Tiny-output bash cards** (`Messages.jsx:406-425`): a successful command with ≤4 lines of stdout
   and no stderr renders inline with **no expand/collapse chrome**, on the rationale that "collapsing
   a 2-line result just repeats it under a footer". The app puts every bash card through the
   collapsible shell. On a transcript of short commands this is the difference between a readable log
   and a wall of chevrons.
4. **Inspector search and match-stepping** — see bucket A finding 6. The audit asked only for copy; a
   900-line output needs the search more.
5. **Blur commits the rename.** The prototype's inline rename commits on blur; the app's
   `SessionRenamePopover` **cancels** on outside click. Typing a new title and clicking away silently
   discards it. A small data-loss shape neither the audit nor three review rounds caught.

---

## Operator rulings — 2026-07-31

All four open operator questions were answered on 2026-07-31. Two are recorded in their owning
decision doc; two have no decision doc and are recorded here as the canonical source until one exists.

| Item | Ruling | Recorded in |
|---|---|---|
| **2a** first-run sign-in | **Fix discoverability only.** §1.1 stands: trust stays per-session-create, account writes stay session-scoped. The launcher must make the sequence visible rather than leave it to be guessed. Host-plane account writes are **not** authorized. Moving the `user` settings scope to a host-plane read is explicitly *not* ruled in and needs its own decision. | `decisions/STARTUP-GATES.md` §1.2 clarification |
| **O2a** quota surfacing | **Pinned, dismissable, non-blocking.** Mount the existing `BannerStack` above the transcript for **account health only**. #12 is unchanged: never blocks submit, always dismissable, no re-auth wall semantics, does not resurrect `ReauthWall.tsx` / `reauthBannerState.ts`. Shell lifecycle errors (finding 8) stay a separate surface. | `decisions/STARTUP-GATES.md` #12 revision |
| **O1** sidebar session state | **Live-only dot, no text.** A single small unlabeled dot on live rows, absent otherwise. The minimum exception to the 2026-07-20 bare-row ruling, matching the standing operator target of live-vs-not-live with no text. No chip, no status word, no per-state colour vocabulary. The data already exists at `Sidebar.tsx:839`. | **here** (no decision doc; ruling context is `Sidebar.tsx:26-29` §0 and ledger §02) |
| **24b** connection tone | **Minimal two-tone, no chip.** Transient states read neutral or warn; terminal states read danger. No dot, no chip, no restored `ConnectionChip.tsx`. Enough grammar that the next transient cannot present as a failure, and no more. | **here** (no decision doc; CC-5 #6 is recorded in `STATUS.md` §I.5) |

**Effect on the disposition table above:** 2a, 24b, O1 and O2a move out of `B-ratified` and become
actionable. `26d` was mis-filed as `B-ratified` and is also actionable — aligning the Remote rail's
copy with a cut feature does not reopen the cut. **Zero items now await an operator ruling.**

## Recommended sequencing

**Port now, no decision needed:** 7 (copy chip), 6-inspector-half (copy + search + wrap),
12 (revert the focus adaptation, `B-undocumented`).

**Port, but verify first:** 19 (menu flip) — port the mechanism, keep the audit's UNVERIFIED tag,
unit-test the helper and confirm clipping live before closing the finding.

**Port, but NOT as a deletion:** 20 — must carry a history `engineSessionId` and route through the
existing `openHistorySession` path, or the row becomes a clickable no-op. See its section above.

**Port after one small decision:** 15 (needs the sidecar key-clear path beyond `dynamic-enum`),
3 (`B-undocumented` — reverses an adaptation with no decision doc, so no operator ruling needed).

**A-blocked — needs a seam/boundary owner before renderer work:** 9 (frame provenance for the
interrupt carrier), 10a (file-list read seam), 16a Goals (no inbound goal verb, cluster unassigned).
The open-the-file capability belongs here too (privileged verb + HC1).

**Ruled 2026-07-31, now actionable:** 2a (launcher copy only), O2a (pinned dismissable BannerStack,
account health only), O1 (live-only dot, no text), 24b (two-tone, no chip), 26d (rail copy).
See the Operator rulings section for the exact bounds each carries.

**Explicitly do not port:** 5a — the prototype's retention enum is incompatible with the real
numeric contract.

**Design first:** the 21 bucket-C items, each with its question stated above.

## Verification boundary

Source-only. No GUI was launched and no app was run. Prototype claims are read from
`~/catcode_prototype/cat-app/` (never edited); app claims are read from source. Rendered behavior,
focus timing, and geometry are unverified.
