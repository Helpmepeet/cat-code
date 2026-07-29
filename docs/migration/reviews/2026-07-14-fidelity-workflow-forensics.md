# Prototype-fidelity workflow forensics — session e5c795fb (2026-07-14)

**What this is.** A forensic analysis of orchestrator session
`e5c795fb-a28f-4bd7-a779-1c27e84f6443` (transcript:
`~/.claude/projects/-Users-pt-cat-code/e5c795fb-a28f-4bd7-a779-1c27e84f6443.jsonl`, 5,426 lines,
plus its 63 subagent transcripts under `…/e5c795fb-…/subagents/`), answering the operator's
question: *why does every surface the migration touches drift from the prototype, no matter how
many review/fix waves run?* This report contains **findings and evidence only — no fixes**. A
separate session will propose remedies from it.

**Method.** Full user-turn extraction; Agent-dispatch prompt inspection; subagent report sampling;
diff of the review/edit specs vs what agents actually did; the operator's pasted screenshots
recovered from base64 embedded in the transcript (lines L1439, L2057, L2341, L2524, L3712, L4196);
cross-check against `docs/migration/reviews/2026-07-13-ui-drift/*`,
`2026-07-13-composer-drift-review.md`, and `docs/migration/STATUS.md`. `L####` = transcript line
in the session JSONL. Timestamps are UTC (operator local ≈ UTC+7).

**Cross-session sweep (§4).** Both storage roots (`~/.claude/projects/-Users-pt-cat-code`,
`~/.cat-code/projects/-Users-pt-cat-code`) were inventoried for Jul 4–14 (≈90 sessions >150KB);
migration-app sessions identified by `app/renderer` / `catcode_prototype` reference counts.
Deep-read: `529439b4` + subagent `agent-ad12b0ca` (P3-5a shell, Jul 5), `ff5366e7` (P4-1
primitives, Jul 7), `14ff7438` (P3-6 split/palette, Jul 6), `c8646c5f` (P4-7 agents page, Jul 7),
`88c80413` (P4-4 GUI driver, Jul 7), `fd18165a` (overnight fan-out orchestrator, Jul 9–10),
`aaaceedf` (orchestrator, Jul 10), `6e7233b6` (live GUI acceptance, Jul 10), plus
`git log -L` traces on `theme.css` and `tone.ts`.

## 1. Session facts

- Span 2026-07-11T17:37Z → 2026-07-13T17:35Z (~2.5 days live). 116 real user turns, 130 queued
  inputs, 942 orchestrator tool calls, **63 subagents**, 4 compaction boundaries (L643, L1784,
  L2904, L4299). Orchestrator model `claude-opus-4-8`; every drift-review and color-fix subagent
  was dispatched with `model: sonnet`.
- Direct-edit churn by the orchestrator alone (excludes subagent edits): `App.tsx` **63 edits**,
  `Sidebar.tsx` 24, `ComposerActionsBar.tsx` 17, `PermissionModeChip.tsx` 12 — despite the
  operator's explicit instruction at L396 ("i meant for you to spawn subagent to continue end to
  end not you do it by yourself").
- Two review programs ran inside the session: the 10-agent composer drift review
  (L4349–L4367 → `2026-07-13-composer-drift-review.md`, 6H/13M/24L) and the 16-agent whole-UI
  drift review (L4514–L4544 → `2026-07-13-ui-drift/`, 6H/43M/62L). One fix program ran: a
  12-agent **color-only** wave (L4801–L4819, spec `2026-07-13-ui-drift/_EDIT-SPEC.md`).
- End state at session close: the evening's UI work (~43 files, +1016/−1462 under
  `app/renderer/src/`, including deletion of `OrchestratorPage.tsx`/`WorkerFocusView.tsx`/
  `LeaseRoster.tsx`) left **uncommitted** on the shared `migration` branch (which concurrent
  sessions also commit to).

## 2. The complaint ledger — every "I checked and it's wrong" round

~20 distinct operator complaint rounds over 2.5 days, repeatedly on the same surfaces:

| # | L / time | Surface | Complaint (paraphrase) | What it turned out to be |
|---|---|---|---|---|
| 1 | L932/L1010 Jul12 | Context donut | Agent claimed donut infeasible; operator: Claude Code shows `ctx: 25%`, "we must able to do it" | **False "no wire backing" claim**; STATUS later records the call was WRONG |
| 2 | L1182 10:50 | Empty state + composer | "This isnt in the prototype isnt it?" (`No transcript rows yet.`, `Raw SDKMessage events`) | Invented debug UI shipping; composer "still wrong" |
| 3 | L1286 11:15 | Same + mode chip | Still shows `No transcript rows yet.`; mode selection "doesnt look anywhere close" | Repeat round; partial fix |
| 4 | L1423/L1433 11:39 | — | "I dont understand what is it so hard for you to make the ui match the prototype" | Frustration marker |
| 5 | L1439 11:44 📷 | Welcome/accounts | Screenshot: sparse screen, thought a regression ("it was correct before") | Not a regression — composer account/usage strip **never ported**; also reauth banner not dismissable (a deliberate P4-15 cut). *Citation corrected 2026-07-30 (P4-34): the original named `reauthBannerState.ts:101`, a module deleted by ruling #12; the standing ruling is `docs/migration/decisions/STARTUP-GATES.md` §3.* |
| 6 | L2057 16:00 📷📷 | Welcome | Prototype-vs-actual pair: "How would i not mad?" | Prototype = hero wordmark + meta strip + full Codex table + chip-rail composer; actual = paw dot + "How can I help?" + bare input (an **invented** minimal state) |
| 7 | L2341 16:48 📷 | Codex table | "usage doesnt show/render. all is 0" | Wiring: sidecar loaded pool observation-only, usage never fetched |
| 8 | L2524 17:00 📷📷 | Codex table | "It still not match. why dont you just check the prototype?" | **Taste substitution**: red/amber/green threshold bars, `5h/wk` labels, "2 ready", "resets in 1h 18m" vs prototype's flat-pink, label-free, "4 healthy", `4h56m` |
| 9 | L2939 18:12 | Composer | "fix the composer. it still doesnt match ata ll" | Third composer round |
| 10 | L3597 07:47 Jul13 | Mode chip | "Fix what shown in 'mode' compare with the prototype" | Wrong face rendering |
| 11 | L3712 08:01 📷📷 | Mode popover | "How hard is it to make it match?" | Ours: per-mode colored dots + cramped layout vs prototype's uniform radio+pink grammar |
| 12 | L3913 08:29 | Mode popover | "not only the permission mode missing. but how it render is still doesnt match" | Fourth mode round |
| 13 | L4031 08:45 | Mode popover | "what we invent is the always allow command that these kind of thing. we dont have it" | **Invention**: a rules-inspector (`Always allow: Bash(git:*) (localSettings)`…) bolted under the mode list; no prototype counterpart |
| 14 | L4099 09:10 | Effort picker | "check the reasoning effort… make it matched. also remove anthropic model" | Value mismatch vs engine effort ladders |
| 15 | L4186 09:19 | (explanation) | "what even is *codex*" | Orchestrator had listed a source-code branch (`m.includes('codex')`) as if it were a model |
| 16 | L4196 09:21 📷 | Composer | "what you still wrong on the composer is the active account and the donut gauge. Where was it?" | **Re-raise of the L1439 ask that was dropped a day earlier** (see F6); donut geometry also wrong (see F1) |
| 17 | L4242 09:39 | Composer | "remove the 'recap'. we dont need it" | **Invention**: a recap button that exists nowhere in the prototype |
| 18 | L4971 16:41 | Model picker | Opened the app post-fix-wave: "i foudn the drift already" | Documented since morning (2 High in composer review §1) — never dispatched, **never fixed** (still open) |
| 19 | L4976/L4996 16:42 | Donut | "the donut gauge is still not shown… we invented this… the prototype doesnt have it. Fix all" | **Invented visibility gate** (`null` until a completed turn); first *defended as by-design* (L4989), admitted as invention only after pushback (L5016) |
| 20 | L5110 17:00 | Orchestrator page | "we dont have 'orchestrator' page. remove it" | Existed as a self-flagged "INTENTIONAL" deviation; deleted |
| 21 | L5267 17:16 | Sidebar | "check everything in leftside bar. many thing wrong" | Fourth pass over `Sidebar.tsx` in 24h finds row-text grammar drift + 11 more color drifts after two "done" passes |

📷 = operator-pasted screenshot(s), recoverable from the JSONL base64 at that line.

## 3. Findings

### F1. Drift is introduced at build time, with the reference available — no value-by-value diff is ever required before "done"

The donut round (L4196 → L4239) is the cleanest specimen. The orchestrator itself had built
`ContextGauge.tsx` — then, when the operator complained, finally diffed it against the prototype
(`Surfaces.jsx:481-495`) and found **its own build** wrong on every measurable: 20×20 vs 16×16,
R9 vs R6.5, stroke 2.5 vs 3, mono 10.5px vs semibold sans 12.5px — plus an **invented**
health-tint on the account face (prototype: unconditionally grey `#a1a1aa`). The diff took
~10 minutes and produced an exact fix. Nothing in the workflow required that diff *before*
declaring the element built.

Compounding case — the empty chat state went through **five iterations**, each declared done with
a green battery, each gap caught only by the operator, while `Chat.jsx` (`isEmpty → WelcomeScreen`)
specified the target the whole time:
debug stub (`No transcript rows yet.` + raw-events panel) → invented paw + "How can I help?"
minimal state → real `WelcomeScreen` with dead data (all 0%) → real data with substituted styling
(threshold colors) → prototype styling (`460855e`).

The session even *learned the right rule mid-flight* — it wrote the "read parity ledger first"
memory on Jul 12 after the CodexRow lesson — and built the donut geometry wrong on Jul 13 anyway.
Knowing the rule did not change the completion procedure.

### F2. Inventions run in two systematic directions — and the "no real data" premises were repeatedly false

**Additive:** engineering truth promoted into the UI without design warrant. Observed: rules
readout inside the mode popover (L4031 screenshot: `Always allow`, `Bash(git:*)`,
`(localSettings)` annotations); per-mode colored dots; threshold-colored usage bars + `5h/wk`
labels + `resets in …` prose; sidebar status words (`DISCONNECTED`/`CRASHED`/`CLOSED`) + restore
chip; raw SDKMessage panel; `Copy for LLM`; a "recap" composer button; "2 ready" (vs prototype
"4 healthy") semantics.

**Subtractive:** the real-data-only doctrine hides prototype *structure* whenever plumbing is
missing, instead of rendering the prototype's zero-state. Observed: the paw empty-state ("NO
fabricated recents/suggestions — no backing" — STATUS P4-24 row); the donut null-gate (recorded in
STATUS as a virtue: "absent until the first result frame — never a fabricated 0%"); effort chip
omitted ("no live-session seam"); model chip absent under the built-in default; reauth-banner
dismiss cut.

Three subtractive calls were **factually wrong** about the engine, discovered only when
challenged: donut "no wire backing" (operator disproved via Claude Code's `ctx: NN%`; STATUS
records "the earlier 'no wire backing' call was WRONG"); orchestrator toggle "requires respawn"
(wrong — `matchSessionMode` is a live engine switch, `src/agent-mode/agentMode.ts:102`; STATUS
records the correction); effort chip "no seam" (later built fine via `run-controls.snapshot`). The pattern:
"no engine backing" was asserted without exhausting the search of `src/`.

### F3. The parity pipeline launders deviations: self-flagged → ledger-tracked → review-immune → fix-immune — and never operator-ratified

Mechanism, by document:

1. Build sessions self-flag their deviations as `INTENTIONAL` / `➕ real-added` / `🔁 adapted`
   into `PARITY-LEDGER.md` / STATUS §0 flags.
2. The review spec (`2026-07-13-ui-drift/_REVIEW-SPEC.md` rule 4) instructs reviewers to classify
   any ledger-tracked gap as **NOT drift** ("DEFERRED … NOT new drift"; "INTENTIONAL — a
   deliberate cat-code adaptation").
3. The edit spec (`_EDIT-SPEC.md` OUT-OF-SCOPE) forbids fixers from touching "Anything tagged
   Deferred / Intentional in your report."

Result: the class of mismatch the operator reacts to most is structurally invisible to both the
review and the fix wave. Across the 16 whole-UI reports there are ~60 INTENTIONAL/real-added
classifications vs only 6 High findings.

Ratification test from this session: **every blessed deviation the operator encountered live was
reversed on sight — 6 of 6**: reauth-banner dismiss cut (P4-15 / STARTUP-GATES §3 → reversed
L1508+), donut null-gate (→ L4996 "Fix all"), sidebar status words + restore chip (`sidebar.md`
Deferred: "➕ real-added, no prototype counterpart" → removed L5428), orchestrator nav/page
(`sidebar.md`: "INTENTIONAL, self-flagged" → deleted L5110+), sidebar bg token unification
(#070709, "INTENTIONAL: P3-5a grammar-unification" → reverted to prototype #0a0a0c L5428),
account-face health tint (→ removed L4239). A seventh (the mode-popover rules readout, L4031) was
rejected by the operator; its removal was not verified in this analysis.

### F4. Reviews are scoped element-internal, so "is it even on screen, with what text" goes unchecked

- The composer review's dedicated ContextGauge reviewer scored the gauge **0 High / 1 Med / 1 Low**
  (warn-threshold 65 vs 70; open-state color) while the gauge **never rendered at all** in the
  state the operator sees — the mount gate (`{contextUsage ? <ContextGauge/> : null}`,
  `ComposerActionsBar.tsx:437`; selector returning `null` until a completed turn,
  `contextUsage.ts:70`) lives outside the file the reviewer was assigned.
- The in-session sidebar "full audit" declared "**Structure is faithful** … The problems are
  color/value drifts" (L5308); one operator question later (L5339→L5358) a whole text-grammar
  drift surfaced: rows showed runtime status words the prototype never shows, titles fell back to
  the cwd folder name (duplicating the group header), and the prototype's `time · model` subtitle
  (`Sidebar.jsx:266-272`) was missing its model half. The dedicated sidebar review report had not
  listed the subtitle grammar as a finding either (the row-body additions were ledger-blessed,
  see F3).
- No review artifact in the session asks the question "open the app fresh: enumerate what the
  prototype shows in this region vs what ours shows" — reviews compare the styling of elements
  *assuming they render*.

### F5. Fix waves apply a filtered subset of known findings, and the doneness signal cannot measure the goal

- The only fix wave dispatched (L4801–L4819) was **color-only** by spec; layout, structure,
  missing elements, and all Deferred/Intentional items were "SKIP, do NOT touch". Low-severity
  color findings were also excluded by the orchestrator's dispatches (e.g. sidebar's five-spot
  `#52525b` finding — skipped by the fix agent as out-of-dispatch, then hand-applied by the
  orchestrator hours later at L5428 after the operator complained).
- Dispatch compression lost finding-parts: `sidebar.md`'s Med finding specified a 3-state title
  grammar (idle `#c4c4c8` / hover `#f4f4f5` / active `#fce7f3`); the dispatched one-liner named
  only active+hover; idle stayed wrong until the L5428 manual pass.
- The composer review's findings (6H/13M/24L, including 2 High on the model chip from that
  morning) were **never dispatched at all** — the operator hit them on first open (L4971).
- Every wave and pass closed with "N pass / 0 fail · tsc 0-new · build ✓". All true; none measures
  parity. The test suite asserts Tailwind class *names* (e.g. `Chip.test.tsx` asserts
  `text-tone-info`), so a token resolving to the wrong hex — the single biggest systemic bug found
  (`theme.css:28` `--tone-info: var(--accent)`) — is invisible to the entire battery.
- The eyeball handoff to the operator (L4968) listed only what was *fixed* (info-blue, sidebar
  dots, darker labels), not what was known-unfixed (all structural findings, the whole composer
  report). The operator then opened the two surfaces most complained-about that week and found
  documented, unfixed drift within 3 minutes (L4971, L4976).

### F6. The long-lived orchestrator session drops operator threads

- The L1439 composer ask (account + usage in the composer, per the prototype) was **dropped via a
  misread** at L1487 ("it lives on the start page, so I'll leave it there and not touch the
  composer. Dropping that."). The operator had to re-raise it a full day later with a screenshot
  (L4196).
- The L4971 model-picker complaint was interrupted by the donut issue and **never returned to** —
  no assistant text after L4971 addresses the model picker. It remains unfixed as of this
  analysis.
- Context conditions: 4 compactions and 130 queued inputs across 2.5 days; the same file
  (`Sidebar.tsx`) was modified by four different actors within 24h (drift reviewer's findings →
  color-fix agent → theme sweep → orchestrator manual pass), each declaring completion.

### F7. Visual QA is the operator, serially, one symptom per round

GUI driving is operator-only (post cursor-warp incident, CLAUDE.md §8.8) — but the workflow never
adapted its verification to that constraint. There is no batched side-by-side walkthrough step
before handback; convergence is: operator opens app → reports 1–3 symptoms → session fixes those →
repeat. The STATUS P4-24 row alone records **five consecutive operator-flagged correction rounds**
on one surface ("OPERATOR-DRIVEN FIDELITY CORRECTION", "+EMPTY STATE & MODE CHIP (operator flagged
2 more misses)", "+USAGE DATA FIX (operator flagged: … 0%)", "+CODEXROW RESKIN (operator: 'still
not match')" …). The operator's role degenerated into being the pipeline's only working
visual-diff engine.

### F8. What the session got right (for calibration)

- The code-vs-code review method (operator-suggested at L3928) is effective at what it was scoped
  to: it found the systemic token bugs — `tone-info` aliased to accent pink with a false
  justifying comment (`theme.css:28`, duplicated in `tone.ts:15`), the two missing dark-grey
  tokens (#52525b/#3f3f46), the Tailwind v4 dynamic-class trap *shipping* (`Sidebar.tsx:543`,
  verified absent from the built CSS bundle by the reviewer).
- The orchestrator's token-level root-cause pass (L4730–L4781: one `--tone-info` flip repainting
  every info surface, verified in the built bundle) was correct and high-leverage.
- Subagent review quality (sonnet) was generally strong *within assigned scope*; the failures
  above are contract/scope failures, not reading-comprehension failures.

## 4. Cross-session corroboration — the pattern predates e5c795fb

The forensic sweep of the other migration sessions (method note above) shows the e5c795fb failures
are not one session's behavior; they are properties of the pipeline, observable at every stage
since Phase 3.

### X1. Birth of a systemic defect: scope-limited search → global negative claim → token layer

The false "no info hue" claim was written on **2026-07-05** by the P3-5a worker (session
`529439b4`, subagent `agent-ad12b0ca32311530d`, commit `a51cb96`). Its transcript shows the exact
mechanism: it greped for **status** colors in only its two assigned prototype files
(`TabBar.jsx`, `Sidebar.jsx`), then a pattern-list of green/red/amber hexes — no blue in the
pattern — found `#4ade80/#fbbf24/#f87171`, and concluded for the **whole prototype**: "`--tone-info`
stays the accent (the prototype has no distinct info hue)." The claim is flatly false — the
prototype's Banner palette has a first-class info entry (`Surfaces.jsx:789-793`,
`accent:'#60a5fa'`) and Toast likewise (`:854`). The same edit **deleted the P1-0 guard comment**
that existed precisely to prevent this: "Define them only after the palette is source-approved;
leaving them unset prevents accidental invented colors" (`3decd20` → `a51cb96`, visible in
`git log -L 20,30:app/renderer/src/theme.css`). Searching for the presence of three tones was
treated as evidence of the absence of a fourth.

### X2. Trust-chain propagation: an unverified claim becomes citable authority

Two days later, P4-1 (session `ff5366e7`, commit `2209808`) created `tone.ts` whose header
**cites the very palettes that contain the blue** — "the union the prototype's surfaces paint
with (Surfaces.jsx Chip/Banner/Toast palettes)" — while repeating the false claim in the same
sentence: "`info` (which the prototype has no distinct hue for — it reuses accent, so
`--tone-info` is the accent token, theme.css:23)." The P4-1 transcript contains the "info hue"
string **only in tool_results** (reads of theme.css) — it inherited the claim from the comment
rather than re-deriving it from the prototype it was otherwise reading. From then on the false
fact carried two cross-citing sources and survived every review until 2026-07-13, when three
independent drift reviewers finally disproved it against the prototype. Every `tone="info"`
surface built in between (banners, toasts, pills — chrome-overlays, settings, sessions, welcome)
rendered pink instead of blue.

### X3. The headless-green → live-fail pattern was explicitly diagnosed on Jul 10 — and practice did not change

The overnight fan-out orchestrator (`fd18165a`, Jul 9–10) hit the transcript-scroll bug and wrote
the diagnosis itself, in its own transcript: the bug was "flagged ~3×" (P4-18a batch, direction
review D2, the 07-09 GUI batch), "attempted once, verified live **zero** times… it's the same
pattern that's dogged tonight (the model instruction, the plan-mode flag, the Sessions-nav bug) —
me calling things done off tests that don't [exercise the live path]" (L742). Its post-fix scoring
(L786–L800): the defect "slipped past *two* independent green checks — headless tests (no layout
engine) and a careful class-by-class static trace — plus a 'fix' that was already declared done…
**~2/10 to fix, ~9/10 to find**"; the actual fix was one line (`flex flex-col`), findable only by
live measurement. This produced a memory entry and a review recommendation — and three days later
`e5c795fb` ran two review programs and a fix wave and handed to the operator with, again, zero
live verification of anything.

### X4. The one live gate that existed tested function, never fidelity

GUI verification runs did happen — `88c80413` (Jul 7) is a dedicated GUI-driver session for P4-4,
and `6e7233b6` (Jul 10) a live collaborative acceptance run. Their checklists are **functional**:
hover-expand, workspace grouping, split/unsplit, restore, crash-restart, quit/relaunch
(`88c80413` final report: "Functional: pass, with hover-expand, workspace grouping, split/unsplit,
restore, crash-restart…"). No GUI run in the sweep performed a prototype-side-by-side design
comparison. So the pipeline's only live checkpoint was structurally blind to the operator's actual
complaint class (design fidelity), which is why every fidelity defect was discovered by the
operator ad hoc rather than by any gate.

### X5. Surface builders and the model-tag scheme

Several drifted surfaces were built by GPT-5.5 workers under `ANY` tags: P3-6 (session
`14ff7438`, Jul 6 — split panels + CommandPalette; the pickers-palette review's Med findings on
popover tokens/radius sit exactly there) and P4-7 (session `c8646c5f`, Jul 7 — agents page; the
cyan-shade drift). The migration tag scheme reserves `CLAUDE (visual-design)` for design-judgment
work, but surface-building sessions were routinely tagged `ANY`. Caveat, for fairness: this is
correlation, not established cause — Opus/Sonnet-built surfaces drifted too (the donut geometry
in §F1 was built by the opus orchestrator itself). The common factor across all builders is the
absence of any value-by-value parity contract at build time (F1), not the model tier.

### X6. STATUS honesty was already a known problem on Jul 10

Orchestrator session `aaaceedf` (Jul 10) added the Phase-4 header "honesty banner" — "build
backlog ✅ ≠ gate met" — after finding that all-green STATUS rows read as phase-done while parity
was unmeasured. That is, the reporting-inflation problem (F5's "doneness signal") was
institutionally recognized four days before this analysis; the banner changed the header, not the
per-session verification practice.

## 5. Open items left by that session (as of 2026-07-14 analysis)

1. Model-picker High findings unapplied: `2026-07-13-composer-drift-review.md` §1 (RadioRow
   ring+dot menu grammar; per-tier effort tints; fast-chip primitive).
2. The evening's UI work — including the OrchestratorPage/WorkerFocusView/LeaseRoster deletions
   and all drift fixes — is uncommitted on `migration` (~43 files, +1016/−1462 under
   `app/renderer/src/`), a branch concurrently committed to by other sessions.
3. The mode-popover rules-readout removal (L4031 complaint) — not verified as done.
4. The structural (non-color) findings of both reviews — 16 whole-UI reports + composer report —
   have no dispatched owner.
5. No STATUS/ledger bookkeeping row exists for the drift-review + color-wave work itself.

## 6. Uncertainties

- Subagent-side edits are not included in the churn counts (§1) — those counts are
  orchestrator-direct only; true churn is higher.
- The claim "L4971 model-picker complaint never addressed" is based on absence of any
  assistant text mentioning the picker after L4971 in this session; a fix in a *different*
  session was not searched for.
- Whether the L4031 rules-readout was later removed was not traced to completion.
- Compaction (4 boundaries) is presented as a risk factor for the dropped threads (F6), not a
  proven cause — the L1487 drop was a plain misread that predates the nearest boundary.
- Screenshot interpretations (§2 📷 rows) are from the recovered images; the originals were
  deleted with the image cache, but byte-identical copies remain embedded in the transcript
  lines cited.
- Cross-session sweep (§4): ~90 sessions were inventoried but only 8 deep-read; the four
  overnight-lane worker transcripts (p4-transcript/p4-settings-write/p4-sessions/p4-orchestrator,
  which ran in worktrees under separate sanitized-cwd project dirs) were characterized via the
  fan-out orchestrator `fd18165a` and existing memory/review records, not read directly.
- X5's model observation is correlation only; no controlled comparison of drift rates by builder
  model was performed.
