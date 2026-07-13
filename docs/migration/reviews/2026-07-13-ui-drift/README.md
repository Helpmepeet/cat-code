# Whole-UI drift review — index (2026-07-13)

Code-vs-code fidelity review of the **entire** Cat Code desktop renderer against the prototype
source (`~/catcode_prototype/cat-app/*.jsx`), run as 16 parallel per-area reviewers. Each reviewer
diffed values from the JSX/TSX (not screenshots), verified Tailwind token→hex against
`app/renderer/src/theme.css`, and split every gap into **DRIFT** (fix) vs **DEFERRED** (ledger-tracked,
has an owner) vs **INTENTIONAL** (deliberate cat-code adaptation). Per-area detail is in the sibling
files; the shared rules are in `_REVIEW-SPEC.md`. The **composer** was reviewed separately in
`../2026-07-13-composer-drift-review.md` and is excluded here.

## Scoreboard

| Area | Report | High | Med | Low |
|---|---|---:|---:|---:|
| Transcript / messages | [transcript-messages.md](transcript-messages.md) | 1 | 6 | 6 |
| Accounts | [accounts.md](accounts.md) | 0 | 5 | 4 |
| Sessions page | [sessions.md](sessions.md) | 0 | 4 | 4 |
| Settings | [settings.md](settings.md) | 0 | 4 | 4 |
| Chrome & overlays | [chrome-overlays.md](chrome-overlays.md) | 1 | 3 | 6 |
| Sidebar | [sidebar.md](sidebar.md) | 1 | 3 | 4 |
| Welcome / startup | [welcome-startup.md](welcome-startup.md) | 0 | 3 | 6 |
| Remote settings / metadata | [remote-metadata.md](remote-metadata.md) | 2 | 3 | 4 |
| Tab bar | [tabbar.md](tabbar.md) | 0 | 2 | 6 |
| Palette & pickers | [pickers-palette.md](pickers-palette.md) | 0 | 2 | 5 |
| Agents page | [agents.md](agents.md) | 0 | 2 | 1 |
| Plan panel / tasks | [plan-tasks.md](plan-tasks.md) | 0 | 2 | 2 |
| Orchestrator | [orchestrator.md](orchestrator.md) | 0 | 1 | 5 |
| Shell & layout | [shell-layout.md](shell-layout.md) | 0 | 1 | 4 |
| Permissions | [permissions.md](permissions.md) | 1 | 1 | 1 |
| Memory & goals | [memory-goals.md](memory-goals.md) | 0 | 1 | 0 |
| **Total** | | **6** | **43** | **62** |

**111 drift findings** across the UI (deferred/intentional items excluded — those are logged per file).
But the count is misleading: a large share collapses into a handful of **systemic root causes** (§A).
Fix those first and dozens of individual findings disappear at once.

---

## §A — Systemic root causes (highest leverage; fix these first)

These are single points that produce drift across many surfaces. Grounded in source, not inference.

### A1. `tone-info` is aliased to pink — "blue renders pink" UI-wide
`theme.css:28` sets `--tone-info: var(--accent)` (pink `#f472b6`). The justifying comment
(`theme.css:22-23`) — "the prototype has no distinct info hue" — is **factually wrong**, and the
**same wrong claim is duplicated** in `tone.ts:15-16`. The prototype's info tone is blue `#60a5fa`
(`Surfaces.jsx:791,854`), and that exact hex **already exists** as `--color-source-project:#60a5fa`
(`theme.css:67`).
- **Surfaces hit:** Banner/Toast `tone="info"` (chrome-overlays, **High-visibility**), Settings plugin "Update staged" pill, Sessions all-workspaces/cross-project chrome, Welcome Sign-in pill + Codex avatar, Plan tone repaint.
- **Fix (one token + two comments):** add a blue info token (reuse `#60a5fa`), point `--tone-info` at it, and correct the false comment in both `theme.css` and `tone.ts`. Verify no surface actually *wanted* pink-info (none found).

### A2. No token for the two darkest grays — resting/dim text is too bright everywhere
The text ramp stops at `--color-text-subtle:#71717a` (`theme.css:50`). The prototype's quiet UI leans
on two **darker** greys — `#52525b` (t4) and `#3f3f46` (t5) — that have **no token at all**, so every
"quiet"/"ghost"/"disabled" label falls back to `#71717a` and reads a full shade brighter.
- **Surfaces hit:** Tab bar (new-tab +, inactive tabs, Split/Unsplit), Pickers (GroupHeader, kbd, match-count), Welcome (quiet labels), Plan (mono titles), Transcript (ToolCard/Thinking/SystemNotice/Seam sub-labels) — reviewer-confirmed as a *systemic* gap.
- **Fix:** add `--color-text-faint:#52525b` and `--color-text-ghost:#3f3f46` (names to taste); adopt them where surfaces currently use `text-text-subtle` for a *resting/ghost* role. Keep the static-class discipline (no interpolation).

### A3. `--color-accent-soft` (#f9a8d4) exists but is under-used for lighter-pink active states
`--accent-soft:#f9a8d4` (`theme.css:13`, `--color-accent-soft` `:52`) is the prototype's lighter active
pink, but several surfaces use full-strength `text-accent`/`#f472b6` instead.
- **Surfaces hit:** Settings nav + Plugins active tab (accent vs accent-soft), `Chip` `tone="accent"` (SessionsPage "orchestrating" chip), Sidebar active session title (wrong pink shade). *(Note: sidebar also cited `#fce7f3` as the target for one element — check per-element which pink the prototype uses.)*
- **Fix:** route active/lighter-pink states through `accent-soft`; audit each pink call site against the prototype's specific shade.

### A4. Tailwind named-shade approximations instead of the prototype's exact hex
Recurring: a Tailwind default shade one step off the prototype's literal.
- cyan-300 `#67e8f9` vs proto cyan-400 `#22d3ee` (agents `AGENT_DOT_CLASS.cyan`, plugin source-meta);
  sky-400 `#38bdf8` vs blue-400 `#60a5fa` and emerald-400 vs green-400 `#4ade80` (composer mode chip);
  violet/purple-300 vs -400 (orchestrator worker chips/labels); red `#f87171` vs `#ef4444` (accounts `DangerBtn`).
- **Fix:** replace each with the exact hex or the correct shade number. Cheap, mechanical, per-site.

### A5. Tone-colored pills/badges flattened to bare text (no bg/border)
The prototype's small status/type badges are **filled** pills; ours often render as bare tone-colored
text. The app already has a `Chip` primitive to reuse.
- **Surfaces hit:** Memory type chip (rendered via neutral `Pill` — all types identical), Permissions allow/deny/ask behavior pills, Remote MetadataInspector MIPill (Goal Status/Tag/Kind), DiagnosticsSection "No issues found" positive pill.
- **Fix:** restore the filled-badge grammar via the shared primitive; tokens for the tones already exist.

### A6. Popover surface token misuse — `shell-chrome` where `surface-raised` is meant
theme.css designates `surface-raised` (`#111113`) for popovers, and `MentionPicker` uses it correctly,
but several floating menus use the darker rail-chrome token (`shell-chrome`/`shell-seam`), reading
flat-black instead of raised.
- **Surfaces hit:** CommandPalette, SlashCommandPicker, Sessions sort/actions popovers, Welcome ProjectPicker dropdown. (Also relates to the composer popover dims/shadow finding.)
- **Fix:** swap the offending popovers to `surface-raised` + the popover border/shadow grammar.

### A7. The Tailwind v4 dynamic-class trap is actually shipping
`Sidebar.tsx:543` builds `` `${toneTextClass(tone)}/75` `` — an interpolated arbitrary class that
**never emits CSS** (confirmed absent from the built bundle), so busy/warn/dead status chips render
with **no tone color at all** (a real High). This is the exact failure mode the repo guards against.
- **Fix:** static class map for the `/75` variants. **Process gap:** nothing caught this — worth a lint/grep guard for `` `${…}` `` inside `className` arbitrary values across `app/renderer`.

---

## §B — The 6 High findings

1. **Permissions — `PermissionRulesEditor` is built but unmounted anywhere** (permissions): deleted from `App.tsx` in `f213c8c` (P4-24), never rewired into `PermissionModeChip` though `STATUS.md:286` claims it was; Settings "Permissions" still shows a "coming soon" stub. → §C.
2. **Remote — `MetadataInspector` is built but has zero render call sites** (remote-metadata): SessionsPage got imports only, no JSX/handler; "Inspect metadata…" opens nothing. → §C.
3. **Remote — RemoteSettings Connect button** is a solid `bg-accent` fill where the prototype (and this file's own Start-bridge button) use a ghost/tinted style.
4. **Transcript — `AssistantBubble` has zero card chrome** (transcript-messages): bare markdown div vs the prototype's mirrored bubble (bg/border/radius/padding/eyebrow); ledger:333 tags "adapted" with no owner.
5. **Sidebar — status-chip tone class never resolves** (sidebar): `` `${toneTextClass(tone)}/75` `` → busy/warn/dead chips render colorless. → §A7.
6. **Chrome — Banner/Toast `tone="info"` renders pink** (chrome-overlays): the highest-visibility instance of §A1.

---

## §C — Built-but-unwired cluster (integration gaps, not styling)

Three fully-built, tested components have **no call site**, and docs claim they're wired. Notably these
overlap the **new uncommitted files** from concurrent sessions — they were built but never mounted:

| Component | State | Doc claim (stale) |
|---|---|---|
| `SessionActionsMenu` + `sessionActions.ts` | built + tested, **0 call sites** in `SessionsPage.tsx`; dead imports | ledger says "unbuilt, no menu" (opposite) |
| `PermissionRulesEditor` | built; **deleted from `App.tsx`** (`f213c8c`), never rewired | `STATUS.md:286` says wired into `PermissionModeChip` |
| `MetadataInspector` | built; SessionsPage has **imports only**, no JSX/handler | — |
| `ToolInspector` | unwired, but **correctly** ledger-tracked (ledger:357) | (tracked — not a surprise) |

**Fix:** wire the three ⋯/inspect entry points (SessionsPage actions menu, Permissions rules panel,
metadata inspector trigger). These give the biggest visible-capability return per line and clear the
2 highest Highs. Confirm the security boundary for the rules panel (renderer never authors rules —
PERMISSION-BOUNDARY T6b) before mounting.

---

## §D — Stale docs sweep (source disagrees with STATUS / PARITY-LEDGER)

Multiple reviewers found dated docs over-claiming "built". Worth a ledger correction pass:

- **Accounts:** ledger 999/1013/1014 claim headroom **reset-time** built (it's absent); 1008 claims hero **glow** built (absent).
- **Agents:** ledger 1462 calls `AgentTypeChip` "deferred" (it's built + consumed).
- **Sessions:** ledger calls the actions menu "unbuilt, no menu found" (it's built, just unwired).
- **Memory:** ledger 1631 "✅ built" overstated.
- **Welcome:** ledger 1984 stale ("ready" vs source "healthy").
- **Permissions:** `STATUS.md:286` claims `PermissionRulesEditor` wired (it's unmounted).
- **Orchestrator:** STATUS shows P4-8b closed with 4 items still open; ledger Part-B rows 2161-2169 call built pieces "Not built."
- **Shell:** ledger Toast/Banners rows say "not mounted in App.tsx" (both `ToastHost` and `BannerStack` are live).

## §E — Suggested fix order

1. **§A1 + §A2 + §A3 (theme.css):** ~4 token/comment edits repaint info-blue, add the two dark greys, and route active-pink through `accent-soft` — the single highest-leverage change; clears a big fraction of the Med/Low across the whole table. Rebuild renderer + eyeball.
2. **§A7 sidebar colorless chips** (High) + add a `` `${…}` ``-in-className grep guard.
3. **§C wire the three built-but-unwired components** — clears Highs #1/#2 and restores whole actions.
4. **§A5 filled-badge grammar** + **§A6 popover token** — two more cross-surface passes.
5. **§A4 exact-hex sweep** — mechanical, per-site.
6. Per-area Med/Low mop-up from each file; **§B#3/#4** (Connect button, AssistantBubble chrome).
7. **§D ledger/STATUS correction** pass so program truth matches source.

All findings are read-only observations; no source was modified by this review. Detail + `file:line`
on both sides lives in each per-area report linked in the scoreboard.
