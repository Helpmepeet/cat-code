import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION =
  'Asks the user free-text or multiple-choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.'

/** Per-option ceiling for an HTML preview, enforced by `validateInput`. */
export const MAX_HTML_PREVIEW_CHARS = 20_000

export const PREVIEW_FEATURE_PROMPT = {
  markdown: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`,
  html: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- HTML mockups of UI layouts or components
- Formatted code snippets showing different implementations
- Diagrams (inline SVG) or visual comparisons

Do not use previews for simple preference questions where labels and descriptions suffice. Previews are only supported for single-select questions (not multiSelect).

How previews are shown: the preview of the option the user hovers or highlights renders in a static panel about 470px wide beside the option list (below it, up to about 560px wide, in narrow windows). Design for about 460px wide and keep layouts fluid. The panel is as tall as the tallest preview in the question, up to about 240px (less in short windows), and scrolls beyond that. Keep every preview under about 220px tall: a compact sketch of the idea, not a full-size page. Use tight spacing (padding around 8-12px, gaps around 4-8px), 12-14px text, and show only the parts that differ between options.

How to write a preview:
- A self-contained HTML fragment: no <html>, <body>, <head> or <!DOCTYPE>. Wrap plain text in an element such as <div> or <pre>.
- Style with inline style attributes only. <script> and <style> tags are rejected. Event handlers, class and id attributes (except SVG ids), links, iframes, external images, and url() references other than a local SVG #id are removed.
- Supported: text, list, table and layout elements (div, span, p, h1-h6, ul, ol, li, table, pre, code, blockquote, details, figure), form controls drawn as static mockups (button, input, select, textarea, progress), inline <svg> with shapes, paths, text, gradients and markers, and <img> with a data:image/ URI only.
- Nothing in the panel can be clicked, focused or typed into, so draw states such as hover, selected or error explicitly.
- Use flex or grid layouts with percentage or max-width sizing rather than fixed widths wider than the panel.
- Colors that follow the app's light and dark theme are available as CSS variables: var(--fg), var(--muted), var(--faint), var(--surface), var(--panel), var(--border), var(--accent), var(--good), var(--warn), var(--danger), var(--info). Prefer them to fixed colors so text stays readable in both themes.
- Each preview is at most ${MAX_HTML_PREVIEW_CHARS} characters.
`,
} as const

export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Use options: [] for a free-text question when predefined choices would constrain the answer. Otherwise provide 2-4 options, never exactly one.
- Users can select "Other" to provide custom text input on multiple-choice questions
- Treat answers as user instructions, not automatic permission to proceed. If the user asks you to wait or explain first, do that before taking action.
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ${EXIT_PLAN_MODE_TOOL_NAME}. If you need plan approval, use ${EXIT_PLAN_MODE_TOOL_NAME} instead.
`
