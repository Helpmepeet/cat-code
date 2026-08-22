# Plan — a headless visual-acceptance harness

**Date:** 2026-08-22 · **Status:** **Stage 1 SHIPPED** (`0648513d`); Stages 2-3 open · **Area:** `app/` (desktop) ·
**Size:** M, in three stages that each ship something usable.

## TL;DR

45 rows in `STATUS.md` say `operator GUI acceptance PENDING`. Two have ever been
verified. The last GUI verification of any kind was **2026-07-26**, four weeks ago.
The queue exists because agent-driven GUI checking was correctly banned after the
cursor-warp incident, and nothing replaced it.

**About 80% of the replacement is already built and unused.** `app/scripts/harness-demo.ts`
already boots the real Electron app against an isolated `CLAUDE_CONFIG_DIR`, injects a
driver into the main process, and drives the live renderer with
`webContents.executeJavaScript`. No cursor. No focus steal. It is not wired to any npm
script and nothing calls it.

Three things are missing: **it cannot take a picture**, **it cannot hover**, and **its
output is an exit code rather than something you look at**. Add those and the queue
becomes one contact sheet you scan in a minute.

## Why this and not one of the other candidates

Three harnesses were surveyed (Codex CLI, OpenClaw, Hermes Agent, plus Muse Code) and
they offer genuinely good ideas: shadow-git checkpoints with `/rollback`, worktree-as-a-
session-primitive with auto-prune, an intent-before-effect event log, session-to-session
messaging. Those are all real gaps.

None of them is this repo's **top measured pain**, and one survey conclusion is worth
stating plainly: *no harness surveyed solves two live sessions coordinating in one tree.*
They all avoid the problem with worktrees, which this repo already does.

The observation gap, by contrast, is measurable, is the largest single blocker in the
program, and has a known cause. It also has the right shape: the one intervention that
demonstrably removed friction here was `design-html`, which did not add information, it
replaced a round trip with a single look. This is that shape, applied to acceptance.

## What already exists (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Boot real Electron + Vite, isolated config dir + scratch cwd | `app/scripts/harness-demo.ts:36-40` | works, orphaned |
| Driver injected into the Electron **main** process | `app/scripts/harness-demo-driver.ts:10-14` | works |
| Drive the live renderer from main | `harness-demo-driver.ts` `webContents.executeJavaScript` | works |
| Readiness wait + child teardown | `app/scripts/devLauncher.ts` (`waitForRendererReady`, `terminateChild`) | works, reused by `dev.ts` |
| Verification-only env hook precedent in main | `app/main/main.ts:2679-2683` (`CATCODE_SMOKE_EXIT_MS`) | works |
| Headless Electron boot inside a test battery | `app/scripts/run-hardening-smoke.ts` (`test:hardening`, 19/19) | works |

## What is missing

**1. Pixels.** `rg capturePage app/` returns nothing. `webContents.capturePage()` returns
a `NativeImage`; `.toPNG()` writes it. This is the smallest of the three changes and the
one that converts a driver into an observer.

**2. Hover and keyboard, without a cursor.** `docs/migration/process/GUI-VERIFICATION.md:51-59`
bans agent-driven hover, and its stated reason is exact:

> `cua-driver` has no backgrounded "hover" … For any check that depends on hover/focus
> **with no backgrounded primitive**: STOP, hand the operator exact hover/click steps, and wait

That clause is an opening, not a wall. `webContents.sendInputEvent({type: 'mouseMove', …})`
delivers a real mouse move into the renderer's own input pipeline — real CSS `:hover`,
real focus rings — **without moving the OS cursor or raising the window**. It has zero
usage in this repo today and is available in the pinned Electron 33.4.11. Supplying the
missing primitive is what makes hover-dependent rows verifiable without breaking the rule
that produced them.

**3. Something to look at.** Today the harness's output is an exit code. The operator does
not read prose (`tldr` typed in 49 distinct sessions) and does not read `STATUS.md`
(80 rows, ~365,000 characters). Output must be a `docs/design-html`-style contact sheet:
reference beside current, one axis varied, captioned with the row it retires.

## Build, in three stages

Each stage is independently useful; stop after any one of them and something improved.

### Stage 1 — capture (S)

Promote the orphan to a maintained script. Keep its isolation exactly as-is. Add a
`capture(name)` step that writes `capturePage().toPNG()` into an output directory, and a
scenario file listing named states.

**The spike is done and this section is the corrected result. An earlier draft of this
plan prescribed `showInactive()` on an offscreen window and warned against `show: false`,
claiming a hidden window's input pipeline is unreliable. That was wrong.** Measured on
this machine, Electron 33.4.11:

| Variant | capture | hover | focus stolen |
|---|---|---|---|
| `showInactive()`, offscreen at `-10000` | PASS | PASS | **YES** (`focused=true`) |
| `app.dock.hide()` + `showInactive()` | PASS | PASS | no |
| **`show: false`, never shown** | **PASS** | **PASS** | **no** (`visible=false`) |

So the correct configuration is the simplest one: **`show: false` and never call `show()`**,
with `backgroundThrottling: false`. A never-shown window still paints
(`paintWhenInitiallyHidden` defaults true), `capturePage()` returns real pixels from it,
and `sendInputEvent` still drives real CSS `:hover` in it — confirmed by both
`matches(':hover') === true` and the pixel actually changing colour. `showInactive()` is
the trap: it takes focus, which is the one thing this harness must never do.

Reproduction is `scratchpad/spike/main2.cjs` behind `SPIKE_MODE=hidden|dockhide`.

**The other spike result: colour is not exact.** Captured pixels came back `(0,0,245)`
where the CSS said `#0000ff`, and `(234,51,35)` where it said `#ff0000` — colour-profile
conversion in the capture path. This confirms byte equality is useless and settles
Stage 1's comparison design: a perceptual threshold, never `Buffer.equals`.

**Gate:** run it against two commits and diff the PNGs. If a known visual change does not
show up, the harness is lying and nothing built on it counts.

**Shipped in `0648513d`.** `bun run --cwd app visual:capture` boots the real app against a
throwaway config dir and writes `app/.visual-acceptance/shell-default.png`, a 2200x1384
frame of the actual shell. Nothing appears on screen; nothing takes focus. `main.ts` skips
only its `show()` under `CATCODE_HEADLESS_CAPTURE=1`; everything else in `ready-to-show`
still runs. Guard tests in `visualAcceptanceSource.test.ts` pin the non-interference
property, not the picture, and were mutation-checked by deleting the gate.

Still owed for Stage 1: the two-commit diff gate itself, and the perceptual comparison the
colour-profile finding requires. Today the harness captures; it does not yet compare.

### Stage 2 — interaction (M)

Add `hover(selector)`, `click(selector)`, `type(text)`, `key(name)` on top of
`sendInputEvent`, resolving a selector to coordinates via `executeJavaScript`
(`getBoundingClientRect`). Add `waitFor(selector | predicate)` with a timeout, because
every flake in a harness like this is a missing wait.

This is the stage that retires the hover/focus rows currently marked UNVERIFIED by rule.

### Stage 3 — the contact sheet (S/M)

Emit one self-contained HTML page: each scenario as reference-vs-current, the `STATUS.md`
row id it corresponds to, and a visible marker where a capture changed. Follow the
existing `docs/design-html/` conventions — the operator's own recorded rule is that these
pages are instruments, not documents, so no explanatory prose and no decoration that could
be mistaken for a claim.

Then run it once over the 45-row backlog and let the operator scan the result.

## What this explicitly does NOT do

Stating these so the proposal is not read as more than it is.

- **It does not judge taste.** It answers "does this render, did it change, does it match
  the reference". It cannot answer "does this look right", which stays the operator's call.
- **It does not touch the operator's live app.** It boots its own instance against its own
  config dir. Pointing it at real `~/.cat-code` data is a later, opt-in decision, and
  should default to a copy.
- **It does not replace the security or logic batteries.** It is an acceptance instrument,
  not a correctness one.
- **It is not a second queue.** If the output is a list of things for the operator to go
  and check, it has failed and should be deleted. The measure is items retired without
  operator attention.

## Risks and open questions

1. **The offscreen-input spike may fail.** Stage 1 is built to find that out cheaply.
   Everything after it is conditional.
2. **Screenshot flake.** Font loading, animation, and caret blink make naive PNG equality
   useless. Freeze animations via injected CSS and settle on a perceptual threshold rather
   than byte equality. Budget for this; it is the usual reason these harnesses get
   abandoned.
3. **The 45 rows may not all be owed.** Evidence is genuinely thin on whether the operator
   considers them real work or dead bookkeeping — the question *"What can we do in the
   current phase that isnt gui verification"* points at the latter. **Ask before running
   the backlog pass.** Building the harness does not depend on the answer; running it over
   45 rows does.
4. **This repo has a recorded pattern of instrumented mechanisms that are never read back**
   (the map-nudge experiment: 302 fires, kill criterion set, readout ~4 weeks overdue).
   A harness nobody looks at is worse than no harness. Stage 3 exists specifically so the
   output is the kind of thing this operator does read, and the honest kill criterion is:
   if the first backlog pass does not retire rows, stop.
