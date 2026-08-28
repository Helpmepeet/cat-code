# Portable renderer theme

This directory is the Phase 0 design-token handoff for the future desktop
renderer. P1-0 owns the final renderer location.

## P1-0 adoption

1. Copy or retain `theme.css` in the renderer's source tree.
2. In the renderer's global CSS, import Tailwind before this layer:

   ```css
   @import "tailwindcss";
   @import "<path-to>/theme.css";
   ```

3. Load DM Sans, DM Mono, and Press Start 2P in the renderer HTML. The smoke
   page uses the prototype's Google Fonts request for parity; packaging should
   decide whether to self-host those files for offline use.
4. Override `--accent` at a suitable ancestor to theme the accent. Do not
   replace Tailwind's `text-accent` utility with a hard-coded pink value.
5. Resolve the TODO tone colors from an approved source before using
   `tone-warn`, `tone-danger`, `tone-good`/`tone-success`, or `tone-info`.

`index.html`, `smoke.css`, `vite.config.ts`, and `package.json` are a throwaway
build harness, not the renderer scaffold. They prove Tailwind v4 can compile
the theme and a test element using the background, accent, DM Sans, and DM Mono.

Build the smoke page with:

```sh
cd renderer-theme
bun install
bun run build
```
