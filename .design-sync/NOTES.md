# design-sync notes — cat-code

## What is synced

Only `app/renderer/src/AgentChrome.tsx` (11 presentation-only exports) plus the theme tokens
and fonts. Operator-scoped on 2026-08-06. The other ~90 renderer `.tsx` files are stateful app
surfaces bound to `protocol.ts` types and reducers; they are not design-system parts and were
deliberately left out.

## Repo-specific gotchas

- **Not a design-system repo.** No Storybook, no `*.stories.*`, no library `exports` entry, no
  component `dist/`. `app/package.json` `main` is the Electron main process. The converter runs
  with `--entry` pointed straight at `AgentChrome.tsx` and `--node-modules
  /Users/pt/cat-code/app/node_modules`.
- **Component discovery finds nothing on its own.** It keys off `.d.ts` exports, and there is no
  built type tree, so the first build reported `[ZERO_MATCH]`. All 11 components are pinned
  explicitly in `cfg.componentSrcMap`. A new export in `AgentChrome.tsx` will NOT appear until it
  is added there.
- **Prop extraction yields nothing usable.** Without a built `.d.ts` tree every component came out
  as `[key: string]: unknown`. All 11 prop contracts are hand-written in `cfg.dtsPropsFor`,
  transcribed from the source signatures. **If a component's props change in
  `AgentChrome.tsx`, `dtsPropsFor` will not notice — it must be updated by hand.** This is the
  single most likely thing to silently rot.
- **Tailwind v4 emits only classes it can see.** Compiling the app alone produced a stylesheet
  limited to cat-code's existing vocabulary, so `gap-x-6` and similar did not exist and preview
  layout silently no-opped. `.design-sync/ds-styles.src.css` re-compiles the theme with `@source`
  over the renderer AND the preview dir, plus an `@source inline(...)` safelist. `cfg.buildCmd`
  regenerates it to `app/renderer/dist/ds-styles.css`. The class set is still finite — anything
  outside the safelist and outside app usage will not exist. Widen the safelist rather than
  hand-editing the CSS.
- **Fonts resolve relative to the compiled CSS.** `theme.css` declares `@font-face` with
  `./assets/fonts/*.woff2`, so `cfg.buildCmd` copies the woff2 files into
  `app/renderer/dist/assets/fonts/` before compiling. Skip that copy and the build drops all four
  font faces as dead.
- Do not point `cfg.cssEntry` back at `renderer/dist/assets/index-*.css`. That is Vite's hashed
  app bundle: the hash changes on every renderer build, and it carries only the narrow class set.

## Known render warns

- `AgentStateWord` `CollapsedToRunning` and `CollapsedToDone` render visually identical words
  within each cell. That is the component's whole point (several lifecycle states compress to one
  word) and is not a defect. Expect a `variants render identically` warn here.
- Every preview cell sits above a tall empty dark area in the review sheets. That is the card
  viewport, not a layout bug.

## Re-sync risks

- `cfg.dtsPropsFor` is a hand-maintained mirror of the real signatures. Diff it against
  `AgentChrome.tsx` on every re-sync. Nothing checks it automatically.
- `cfg.componentSrcMap` is an explicit allowlist. New `AgentChrome.tsx` exports are invisible
  until added.
- The safelist in `ds-styles.src.css` is a guess at what a designer reaches for. If designs come
  back with dead layout, a missing utility is the first thing to check.
- `.design-sync/conventions.md` enumerates class families and token names. Both were verified
  against the built CSS on 2026-08-06. Re-verify after any theme change: three tokens
  (`--color-text-muted`, `--color-tone-danger`, `--color-tone-good`) exist only as utility
  classes and NOT as raw custom properties, because Tailwind drops unreferenced theme vars.
- Playwright chromium was installed into `.ds-sync/node_modules` for the render check. A fresh
  clone needs it again.
- Nothing about the running-subagent redesign (the work this sync was created for) is captured
  here. See `docs/migration/STATUS.md` and the CC-30 scope if that lands.
