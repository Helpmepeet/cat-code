See `CLAUDE.md` for repository instructions.

On macOS, use Codex's built-in browser for ad hoc page inspection. Do not fall
back to spawning native Chrome from a sandboxed shell, Bun, or Playwright.
From sandboxed Codex, run renderer layout tests (also included in
`bun run --cwd app test` and `bun run --cwd app test:all`) only with one-time
outside-sandbox approval, or have the user run the command from Terminal.
Use a temporary browser profile for native Chrome.
