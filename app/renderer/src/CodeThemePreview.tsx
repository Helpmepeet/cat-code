/**
 * The live code canvas that heads Settings ▸ This app ▸ Appearance (the
 * prototype's `OutputPreview`, `Settings.jsx:282-304`, placed as a hero above
 * the controls at `Settings.jsx:328`).
 *
 * IT MUST BE THE TRANSCRIPT'S OWN CODE BLOCK, NOT A LOOKALIKE. A preview that
 * renders its own panel would drift from what a fenced block actually looks
 * like the moment either side is touched, and the picker it sits above would
 * then be advertising the wrong thing. So the sample goes through the exported
 * `CodeBlock` (`TranscriptView.tsx`), which brings the real frame and copy
 * control with it. The copy control is not in the prototype's preview; it is
 * here because it is part of the block being previewed, and stripping it would
 * be the lookalike this component exists to avoid.
 *
 * `CodeBlock` does not tokenize: its `highlighted` prop is the already-colored
 * span tree, which in the transcript comes from `rehype-highlight` running
 * inside react-markdown. Rather than reach for a second tokenizer, this renders
 * the sample as a one-fence markdown document through the transcript's plugin
 * config and hands the resulting tree straight to `CodeBlock`.
 *
 * The theme is applied by neither: `CodeThemeProvider` puts `data-code-theme` on
 * a wrapper above the whole app (`main.tsx`) and `theme.css` selects palettes off
 * it, so this component re-colors on a picker change with no prop, no reload, and
 * no re-tokenizing. That is also why it takes no `theme` argument.
 *
 * ADAPTED (§0) — the prototype also drives its preview from the syntax-highlighting
 * toggle and the code-font select. Neither is honored here, deliberately: the
 * preview must show what the transcript shows, and the transcript honors neither.
 * `syntaxHighlightingDisabled` is an ENGINE key with no renderer consumer (it
 * governs the terminal), and the code font is an unbuilt ledger row. Dimming the
 * sample on a toggle the transcript ignores would make the preview lie.
 */

import Markdown from 'react-markdown'
import type { ComponentPropsWithoutRef } from 'react'
import { CodeBlock } from './TranscriptView.js'
import { PREVIEW_CODE, PREVIEW_CODE_LANG } from './codeTheme.js'
import { REHYPE_PLUGINS } from './markdownPlugins.js'

/** The sample as a one-fence markdown document, so the fence carries the
 * language and `rehype-highlight` tokenizes for that language exactly as it does
 * for a model-authored block. */
const PREVIEW_MARKDOWN = ['```' + PREVIEW_CODE_LANG, PREVIEW_CODE, '```'].join(
  '\n',
)

/**
 * The two-component bridge from react-markdown's `<pre><code>` to `CodeBlock`,
 * mirroring the transcript's own `pre`/`code` renderers: unwrap the `<pre>` so
 * the framed block owns the only one, and hand the `<code>` children over as the
 * colored tree. `code` is the constant rather than a re-flatten of the tree,
 * because here the raw source is already in hand.
 */
const PREVIEW_COMPONENTS = {
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => <>{children}</>,
  code: ({ children }: ComponentPropsWithoutRef<'code'>) => (
    <CodeBlock
      code={PREVIEW_CODE}
      highlighted={children}
    />
  ),
}

export function CodeThemePreview() {
  return (
    <Markdown
      components={PREVIEW_COMPONENTS}
      rehypePlugins={REHYPE_PLUGINS}
    >
      {PREVIEW_MARKDOWN}
    </Markdown>
  )
}
