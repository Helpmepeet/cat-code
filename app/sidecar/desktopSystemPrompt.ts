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
 * `appendSystemPrompt` is the documented seam for this
 * (`docs/prompts/2026-04-30-prompt-surfaces.md`, §Prompt Flow); it survives
 * every prompt branch except an explicit `overrideSystemPrompt`
 * (`src/utils/systemPrompt.ts:63`). The text names the convention it
 * supersedes because the engine's conflicting line is already in the prompt by
 * the time this is appended.
 *
 * The markdown example below is a file:line citation by construction, so the
 * §7 sweep flags it. This string is never rendered: it is appended to the
 * model's system prompt, so the exemption is on the audience, not the words.
 */
export const DESKTOP_SYSTEM_PROMPT_ADDENDUM = `Write file references as markdown links, not as bare file_path:line_number, so the desktop app can open them: the href is the path relative to the working directory, with an optional :line suffix. Examples: [foo.ts](src/utils/foo.ts), [Bar.tsx:42](app/components/Bar.tsx:42).` // §7-ok
