import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import type { PluggableList } from 'unified'

// Shared transcript/preview syntax highlighting. `detect:false` colors only
// explicitly-languaged fences; `ignoreMissing:true` leaves unknown languages as
// plain text instead of throwing during renderer or SSR rendering.
export const REHYPE_PLUGINS: PluggableList = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
]

/**
 * Ordinary transcript messages add KaTeX after syntax highlighting. KaTeX
 * receives text parsed by `remark-math`, never raw HTML; `trust:false` keeps
 * commands that can author links or external resources disabled.
 */
export const TRANSCRIPT_REHYPE_PLUGINS: PluggableList = [
  ...REHYPE_PLUGINS,
  [
    rehypeKatex,
    {
      trust: false,
      strict: 'ignore',
      maxExpand: 1_000,
      maxSize: 50,
    },
  ],
]
