# The frosted window went grey: a canvas-opacity latch on vibrant Electron windows

2026-08-28. Desktop app (`app/`), macOS, Electron 33.4.11.

Reported as "Dark appearance + Frosted window on renders washed out." Took five
attempts across three models to land, and four of the first answers were wrong. This
records the mechanism, the fix, and — because they cost more than the bug did — the
three instruments that lied along the way.

## Symptom

With appearance Dark and **Frosted window** ON, the window's translucent areas rendered
a flat washed-out grey (`#D3D3D3`) instead of a dark frosted blur. The app's own opaque
surfaces — settings rail, headers, tool cards — rendered correctly, which is what made it
look like a vibrancy failure. It survived relaunch.

## Root cause

On a vibrant Electron window, **a document whose first composited frame carries an opaque
CSS canvas keeps an opaque render surface for that document's entire life.** Later canvas
transparency composites over a stuck copy of that first ground. Only a cross-document
navigation resets it.

The app armed that latch every launch:

- `html` (and, by CSS canvas propagation, `body`) painted `--app-bg`.
- Since `6a90d30f`, glass in light is deliberately inert and paints the **opaque** page
  ground; only dark carries the 20% translucent coat.
- So any launch whose first frame was opaque — light-with-glass, or the far more common
  glass-OFF default — latched the surface opaque. Switching to dark glass afterwards
  painted the 20% coat onto the stuck opaque base instead of onto the material.

`0.8 × 255 + 0.2 × 9 ≈ 206` against the `#D3D3D3` measured, over a base of `#FCFCFE`,
which is `--app-bg` in light (`#FCFCFD`) read live from the running app. The desktop was
never showing through. It was the app's own light ground, frozen at first paint.

### Consequence nobody had noticed

The ordinary path — launch with glass off, then toggle glass on in dark — was **also**
always broken. Its stuck base is dark (`#0C0C0E`), which reads as a plausible dark
window, so in-app dark frost had likely never actually shown material to anyone.

## What the failure was *not*

Four answers were wrong before this one, and each is worth keeping because each looked
convincing:

| Claim | Verdict |
|---|---|
| The `NSVisualEffectView` was dropped or stale | **False.** Read out of the live process: one view, material 21, state active, blendingMode behind-window, alpha 1, not hidden, frame an exact match for the window bounds. Perfect, while the window showed no material. |
| `setVibrancy` is asymmetric and cannot revive a window | **False.** It does create the view; the window measured against had an opaque backing covering the result. |
| Removing the `nativeTheme` `updated` re-mint fixes it | **No.** That listener was unnecessary — the appearance follows on its own — but it was cleanup, not a cure. |
| Moving the ground off `html` fixes it | **No.** `body`'s background **propagates to the canvas** when `html`'s is transparent, so the canvas stayed opaque and the trap re-armed. |

Also ruled out by direct experiment, each with the material surviving: repeated
`setVibrancy` re-mints (12× and 20×), re-mints while hidden, maximize, fullscreen
enter/exit, hide/show, minimize/restore, a move across displays of differing backing
scale, docked DevTools, 100 reloads, 100 reloads crossed with real appearance
transitions, and killing the GPU helper process.

Both remaining native candidates are dead too: `NSWindow.opaque` is `false`, and the
complete view and layer tree (down to `CALayerHost`) is byte-identical between a stuck
window and a healthy one — the RWHV layer on the stuck window already carries the correct
new coat colour. The opacity lives inside the GPU process's remotely-hosted compositor
frames, invisible to any in-process read.

## The fix

`app/renderer/src/theme.css`. **The canvas is never painted at all.**

- `html` and `body` are `background: transparent` in every state.
- Every page ground moves to `body::before` — `position: fixed; inset: 0; z-index: -1;
  pointer-events: none` — which covers the window identically but cannot become the
  document canvas.
- Glass-on retargets only the pseudo-element:
  `light-dark(var(--app-bg), rgba(9, 9, 11, 0.2))`.

The `6a90d30f` ruling is preserved exactly: light glass still renders as the plain opaque
page. Only *how* that look is produced changed.

Guards in `app/renderer/src/glassMode.test.ts` moved to the new locations, plus a new
never-paint-the-canvas invariant. Mutation-tested two ways — restoring the ground onto
`html`, and deleting the pseudo-element — each fails it (12 pass / 1 fail against 13 / 0).

## Acceptance, measured

Second app instance on a scratch `--user-data-dir`, CDP-driven; the operator's live window
was never touched.

| Scenario | Ground | Verdict |
|---|---|---|
| Launch light + glass, switch to dark | `#393838` | real frost (was the `#CDCDCD` wash) |
| Quit, relaunch in dark + glass | `#393838` | survives relaunch |
| Glass off, dark (default user) | `#0E0D0F` | unchanged solid page |
| Live toggle glass on, in dark | `#0E0D0F` → `#393838` | frost now actually appears |
| Light + glass on | `#FBF9FC` | opaque, ruling intact |

`#393838` = `0.8 × material(#434343) + 0.2 × #09090B`.

Battery, re-run independently of the implementing session: `bun test app/` **4168 pass /
0 fail** (266 files) · app tsc clean · sidecar wrapper green (5,568 upstream ignored) ·
hardening **19/19** · `renderer:build` ✓ · `git diff --check` clean.

## Instrument traps — the actual cost

The bug took ~20 minutes to fix once seen. The hours went to three instruments that
returned confident, wrong answers.

1. **A window-only capture writes a PNG with no alpha, so transparent flattens to
   WHITE.** A window with dead compositing and a healthy one produce identical images.
   The operator's screenshot and the agent's agreed with each other and both meant
   nothing. *Fix:* control windows captured at the same moment on the same display and
   Space — vibrancy on `#424242`, vibrancy off `#232323` (macOS default dark window
   background), nothing drawn `#FFFFFF`. Dark `under-window` clamps near `#424242`
   regardless of what is behind it.
2. **Captures of an occluded window go stale and silently return the previous frame.**
   Four byte-identical PNGs with different mtimes were read as "no change." *Fix:* md5
   successive captures before believing any negative result.
3. **Pixels cannot answer whether a native view exists.** Only a native read can. That
   read is what finally cleared the material and redirected the whole investigation.

## Owed

- `app/main/main.ts:2332-2400` still says two native candidates remain and to read
  `NSWindow.opaque` next. Both are now answered. That file carries another session's
  uncommitted hunks, so the comment is left for whoever owns it to land.
- `docs/migration/STATUS.md` CC-76 still promises a light frosted blur and makes it a GUI
  acceptance step, which `6a90d30f` made false. Multi-writer file; owed at landing time.
- The packaged (non-Vite) build path was not measured. The mechanism is document-level
  CSS so nothing should differ.
- Light-material appearance was measured on one display only.

A minimal reproduction and all measurements are preserved at
`/private/tmp/cat-code-frost-latch/` (`probe.js` runB is the theme-free distillation) if
this is ever worth filing upstream.
