# Light glass was opaque, so nothing behind the window could reach the page

**Date:** 2026-08-28 · **Area:** `app/renderer` (desktop) · **Branch:** `migration`

## What the operator saw

Dark glass showed the blurred desktop through the window. Light glass looked identical
over a black background and over anything else, which is the exact signature of a page
that is not compositing its backdrop at all.

## Root cause, in one line

`app/renderer/src/theme.css` painted the light half of the glass coat as
`light-dark(var(--app-bg), rgba(9, 9, 11, 0.2))`. `var(--app-bg)` is `#fcfcfd`, alpha 1.
At alpha 1 nothing behind the window can reach the page, whatever the material behind it
is doing. The frame rule underneath repeated the same opaque token
(`light-dark(var(--app-bg), transparent)`), so even a translucent coat would have been
covered by the app frame.

This was not a defect of ignorance: `6a90d30f` deliberately ruled light glass inert, on the
finding that macOS's light `under-window` material is far more transparent than its dark
twin and drags a light page toward mid-grey over a dark desktop. The operator has now
reversed that ruling. The trade it was avoiding is real and is stated below rather than
designed away.

## The fix

| Rule | Before | After |
|---|---|---|
| `html[data-glass='on'] body::before` | `light-dark(var(--app-bg), rgba(9, 9, 11, 0.2))` | `light-dark(rgba(252, 252, 253, 0.2), rgba(9, 9, 11, 0.2))` |
| `html[data-glass='on'] [data-window-ground]` | `light-dark(var(--app-bg), transparent)` | `transparent` |
| `html[data-glass='on'] [data-window-chrome]` | `light-dark(rgba(232, 232, 238, 0.16), rgba(7, 7, 9, 0.12))` | `light-dark(rgba(9, 9, 11, 0.045), rgba(7, 7, 9, 0.12))` |
| `html[data-glass='on'] [data-window-overlay]` | same as chrome | same as chrome |

One coat, both appearances, at the same 0.2; only its colour flips. The frame clears
unconditionally now, because a frame that repeats the ground over a coat is a second coat.

The chrome/overlay light half became a black WASH rather than a fixed light tone. Chrome
sits below the body in this shell in both appearances (`#f1f1f4` under `#fcfcfd`,
`#070709` under `#09090b`). The old `rgba(232, 232, 238, 0.16)` sat under the opaque
`#fcfcfd` it was written against and sits OVER the translucent one, so the rail would have
floated on top of the page it frames. `0.045` of `#09090b` over `#fcfcfd` composites to
`#f1f1f2`, i.e. `--shell-chrome` itself, so the step survives wherever the wallpaper drags
the ground.

## Measurements

Instrument: a throwaway Electron 33.4.11 instance (its own `userData`, `app.dock.hide()`,
`showInactive()`, never the operator's app), windows carrying this repo's own
`BrowserWindow` options, captured per-window through the cua-driver daemon and averaged
over the central region. Probe kit: `/private/tmp/cat-code-light-frost/`.

**End-to-end, against the REAL built stylesheet** (`app/renderer/dist/assets/*.css`), page
stamped `data-appearance` / `data-glass` the way the renderer stamps them:

| cell | light appearance | dark appearance |
|---|---|---|
| glass OFF | `#FCFBFD` | `#0C0C0D` |
| glass ON, pre-fix rules replayed | `#FCFBFD` — identical to OFF, the bug | (not meaningful; the replay forces the light shape) |
| **glass ON, shipped fix** | **`#E5E5E5`** | **`#393938`** |
| glass ON + the app's full-area frame | `#E7E6E6` | `#3B3A39` |
| chrome strip, glass ON | `#DCDCDC` under a `#E5E5E5` page | — |

The dark column is the number this feature has always been scored healthy at, and it is
unchanged: the dark half of every rule is byte-identical to what shipped.

**Material survey**, twelve vibrancy materials in light appearance, page ground
transparent: `content` and `sheet` `#FFFFFF`; `header` `#F2F2F2`; `window` `#F1EFEE`;
`titlebar` `#E7E7E7`; `under-page` `#E3E3E2`; `under-window` `#E0E0DF`; `menu` `#DCDEDD`;
`sidebar` `#DCDCDD`; `popover` `#D8D9D9`; `fullscreen-ui` `#CFCFD0`; `selection` `#C5C5C5`.
`under-window` is kept: it is what dark uses, and swapping the material per appearance
would need `setVibrancy` after creation plus a `nativeTheme` listener that
`appearanceChannel.test.ts` deliberately forbids. If light ever needs to stay lighter over
a dark desktop, `sheet`, `header` and `window` are the lighter candidates and that is the
thread to pull.

**Coat ladder**, light, measured against the real material: 0.15 → `#E4E4E4`, 0.20 →
`#E5E5E5`, 0.25 → `#E7E7E6`, 0.30 → `#E8E8E8`. Four levels across the whole usable range,
which is why the alpha is not the legibility lever (below).

## What light glass costs, stated rather than hidden

macOS's light `under-window` material tracks its backdrop instead of clamping. The page
ground lands near `#E6E6E5` over a pale desktop and around `#BDBDBD` over a black one. The
light ink ramp is tuned for `#fcfcfd`, so at the dark end `--text-faint` falls to about
2.9:1 and `--text-subtle` to 3.8:1, under the app's own bar.

**The alpha cannot fix that.** Across 0.15 to 0.30 the ground moves four levels and
`--text-faint` moves 0.16, because the material dominates the mix at every value in that
range; anchoring the light ground would take a coat near 0.6, which leaves no material to
see. A compensating ink ramp under `[data-glass='on'][data-appearance='light']` was
computed (each tier about twelve levels darker, ramp order preserved) and NOT shipped: it
recovers the solid-app ratios only at the pale end, still leaves `--text-faint` at 3.6:1
over a black desktop, and it would move `--text-*` tokens that also serve as toggle knobs,
tone dots and borders. Left as the first thing to try if the operator finds light glass
hard to read.

## Refuted: toning the material with `backdrop-filter`

The previous note blamed `html` for the filter doing nothing and pointed at "a full-area
child element carrying the filter" as the thread. That is now dead. Measured with the
filter on `body::before` — which IS a full-area child of `body` — `brightness(0.3)` moved
not one level on any of the twelve materials above. The web layer's backdrop is transparent
black, and a filter over transparent black stays transparent, whichever element carries it.
The sidebar overlay is not a counter-example: it samples the page behind it, never the
native material.

## Instrument limit, recorded honestly

A per-window capture is BLIND to the vibrancy backdrop. Verified three ways here: a solid
black, white and saturated red window placed directly behind the probes changed the reading
by zero levels, and a capture of the backdrop window itself showed pure red where a probe
was covering it. So every number above is the material composited over the capture's own
white flatten, i.e. the pale-desktop end of the range. The dark-desktop end is modelled,
not measured. A full-display composite is not reachable from here: `screencapture` has no
Screen Recording grant in this shell, and `systemPreferences.getMediaAccessStatus('screen')`
reports `denied` for both the vanilla Electron binary and the dev app bundle. What IS
measured, and is the whole defect, is that the light ground stopped being a constant and
became a function of the material.

## Verification

- `bun test app/` → 4168 pass / 0 fail (266 files)
- `bun run --cwd app typecheck` → pass
- `bun run --cwd app typecheck:sidecar` → pass, 5571 upstream diagnostics ignored
- `bun run --cwd app renderer:build` → pass
- `bun run --cwd app test:hardening` → 19/19 pass
- `bun run maps:lint`, `git diff --check` → see the session report

One transient app-typecheck failure in `renderer/src/transcriptProjector.ts` was another
session's in-flight edit (file dirty, not touched here); it was green on the next run.

## Still needs the operator's eyes

Whether light glass looks right over their actual wallpaper, and whether the sidebar's
`blur(22px)` occludes well enough light-on-light. Neither is reachable by any instrument in
this repo.
