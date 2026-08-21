/**
 * Surface-specific prompt addendum for desktop sessions.
 *
 * The engine's own tone section teaches the TERMINAL convention: a bare
 * `file_path:line_number`, which the TUI turns into an OSC 8 hyperlink
 * (`src/constants/prompts.ts:502`, and the same line in the GPT style at
 * `src/constants/promptStyles/gpt.ts:281`). A renderer has no OSC 8, so the
 * desktop transcript can only guess at bare prose, while a markdown link is
 * exact: `app/renderer/src/TranscriptView.tsx` routes a workspace-relative
 * href straight to the open-file control.
 *
 * Upstream solves this the same way — one engine instruction for the CLI, a
 * client-injected instruction for the GUI — and `appendSystemPrompt` is the
 * documented seam for it (`docs/prompts/2026-04-30-prompt-surfaces.md`,
 * §Prompt Flow). It survives every prompt branch except an explicit
 * `overrideSystemPrompt` (`src/utils/systemPrompt.ts:63`).
 *
 * The text names the convention it supersedes on purpose: the engine's
 * conflicting line is already in the prompt by the time this is appended.
 */
export const DESKTOP_SYSTEM_PROMPT_ADDENDUM = `# File references

This session renders in the Cat Code desktop app, which has no terminal hyperlinks. Write file references as markdown links so they resolve exactly: the href is the path relative to the working directory, with an optional :line suffix. Examples: [foo.ts](src/utils/foo.ts), [Bar.tsx:42](app/components/Bar.tsx:42).

This supersedes the bare file_path:line_number convention for this session. A bare path still renders, but the app has to guess where it starts and ends; a markdown link never guesses.`
