# GUI acceptance checklist — pending surfaces (snapshot 2026-07-19)

Everything below is **built + headless-GREEN + merged to `migration`** but **not yet
accepted by you at the live GUI**. This is a point-in-time snapshot — re-derive from
`docs/migration/STATUS.md` if it drifts. Companion process doc:
`docs/migration/process/GUI-VERIFICATION.md`.

**You drive this — I don't.** Every item is something for you to click/look at and
mark. When something doesn't match the prototype, note it and tell me; I'll flag it as
a §0 deviation and fix.

## Launch (once)

```bash
# Luna before turn one so no dev-loop turn burns frontier quota (GUI-VERIFICATION §Model)
ANTHROPIC_MODEL=gpt-5.6-luna bun run --cwd app dev
```

Window/AX title = **Cat Code Dev**. Confirm the model with `/model` after the first
session opens. Prototype reference to eyeball against: `~/catcode_prototype/cat-app/*.jsx`.

Legend: `[ ]` = check this · `✅ already accepted` = skip (verified in a prior run) ·
🆕 = never GUI-verified, landed this session.

---

## 1. P4-6b — Sessions ⋯ actions menu 🆕 (highest priority — just changed)

The tab `⋯` overflow. Two bugs were fixed today (`459cce7`); rename/export/branch were
**previously enabled but did nothing**, so this whole menu needs a fresh look.

Open the `⋯` button on the **active tab's** title (top bar).

- [ ] 🆕 Menu opens anchored to the `⋯`; sections (primary / history / transfer) and
      dividers match `SessionActions.jsx`.
- [ ] 🆕 **Rename** → opens the inline rename input (prefilled with the current title);
      **Enter** commits, the tab/sidebar label updates live, a toast appears; **Esc** or
      click-away cancels with no change.
- [ ] 🆕 **Export…** → a success toast appears and the transcript text lands on the
      clipboard (paste somewhere to confirm). *(Text-only by design; no md/json.)*
- [ ] 🆕 **Branch from HEAD…** → success toast naming the new fork. *(The fork is written
      to disk but does NOT auto-open a tab — deferred by design; confirm it does not error.)*
- [ ] 🆕 **Rewind…** shows as disabled with a "soon" reason on hover *(no engine verb — correct)*.
- [ ] **Inspect metadata…** opens the MetadataInspector drawer for the active session.
- [ ] **Copy transcript for LLM** / **Open** act on the session the menu was opened for.
- [ ] 🆕 **Rename popover is a new visual surface** — judge it against the prototype's
      rename affordance; tell me if the pattern/styling should differ.

## 2. P4-26 — Sessions nav + P4-6a Sessions page (re-acceptance)

The Sessions nav was silently inert before `P4-26`; this re-validates the whole page.

- [ ] Clicking **Sessions** in the left rail actually navigates (was a no-op before).
- [ ] Page lists real sessions with counts (`N sessions · M workspaces`), real titles.
- [ ] Search / sort (Recent activity) / workspace filter / empty-state all behave.
- [ ] Opening a live row focuses its tab; opening a restorable row restores it.

## 3. P4-4 — Shell fidelity (Sidebar / TabBar / shell / WorkspaceLayout)

Marked ✅ headless but never operator-accepted. Eyeball chrome against the prototype.

- [ ] Sidebar rail, seams, tone chips, tab chrome, split/panel layout match `Sidebar.jsx` /
      shell surfaces — spacing, dividers, tokens, active/hover states.

## 4. P4-15 — Startup: trust gate + first-run OAuth + reauth banner

OAuth **live transitions + paste-code** landed today (`8500f39`) — never GUI-checked.

- [ ] **Trust gate** appears on a new session at an untrusted cwd; accepting proceeds,
      and an untrusted cwd cannot run a turn.
- [ ] 🆕 **First-run OAuth** live transitions: `waiting_for_login → waiting_for_alias →
      success/error` render as real steps (not a static screen); **paste-code** URL path works.
- [ ] **Reauth banner** (non-blocking) floats below the TabBar, has a `×` close, supports
      "never show again"; the all-dead wall re-surfaces and blocks submit at zero-healthy.

## 5. P4-18 — Transcript rendering

Partly accepted already. Focus on the unverified + newly-landed items.

- ✅ already accepted: FileRead, FileWrite, Bash tool-cards; permission prompt render/approve;
  `↓ Latest` re-pin (2026-07-11 run).
- [ ] **Edit / dual-gutter DiffView** (the load-bearing one) — needs a turn that edits a file.
- [ ] **Grep** tool-card.
- [ ] **Stop → app.abort** button mid-turn, and **Esc** keybinding cancel.
- [ ] 🆕 **GFM tables**, **fenced-code syntax highlighting**, **word-level diff** (`0b1b144`,
      landed today under dep approval) — ask the model to emit a markdown table + a diff.
- [ ] Scroll: stick-to-bottom during a live turn; human-trackpad scroll moves the transcript
      (the layout root-cause fix — confirm with a real wheel/trackpad, not just AX).

> These need typing into the composer, so **Cat Code Dev must be the key window** — do not
> steal focus if you're mid-task in another app; run this pass when Cat Code is frontmost.

## 6. P4-19 — Settings core value-editors

- ✅ already accepted: General/Model/Privacy/Theme write round-trip + source badges +
  persistence (2026-07-11 run).
- [ ] 🆕 **Remaining editors** (`82dbb0b`): Keybindings, IDE/LSP, default-model &
      output-style selects, accent swatch, code theme/font, share-data / crash-reporting
      toggles — render + write where they have a real key. *(Confirm exact coverage against
      the P4-19 report — I merged it but didn't audit each editor.)*
- [ ] A managed/policy-sourced field renders **disabled/inert** (unverified — needs a
      managed setting configured).

## 7. P4-24 — ChatView fidelity (composer + chrome)

- [ ] Full `Chat.jsx` composer, scaffold chrome dropped, raw-events debug panel gated.
- [ ] Layout: reflow, **740px centering**, and the **context gauge** match the prototype.

## 8. P4-20 — AskUserQuestion interactive answer flow

- [ ] When the model calls AskUserQuestion, options render as a real interactive picker
      (not raw JSON); selecting an answer resumes the turn correctly. *(Trigger by asking the
      model a question that makes it use AskUserQuestion.)*

## 9. P4-8b — Orchestrator worker detail / focus / control

- ✅ already accepted: 8a roster + 8c inline Agent/DelegateGroup cards (2026-07-11 run).
- [ ] **WorkerDetail** drilldown + **WorkerFocusView** (main-column swap; Esc returns to roster).
- [ ] **TasksButton** opens the existing Tasks dialog; **Leases** tab shows the real pool.
- [ ] 🆕 **Stop / kill worker** (`dc0766b`, landed today) actually stops the worker and the
      row reflects stopped.
- [ ] Blocked-worker copy reads correctly for the user-owned desktop case ("it's on you to
      resolve", not the orchestrator-resolves framing).

## 10. P4-17 — Welcome / launcher

- [ ] Empty-state (no active session) Welcome renders derived recents (distinct workspaces),
      trust flags, and the account table; launching from a recent works.

## 11. P4-5 — Accounts + Codex pool / lease + AccountLifecycle

- [ ] Accounts page renders the real pool/lease state; account lifecycle actions
      (login/switch) behave; no raw credentials ever shown.

---

### If something's wrong
Jot the surface + what mismatched (or screenshot). I'll classify it: a real defect I fix,
or a §0 parity deviation to flag/adapt/defer. Don't try to fix it in the GUI — just record it.
