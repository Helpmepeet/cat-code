/**
 * The tool-card paint tables, shared by the transcript's cards and the docked
 * full-output panel so the two surfaces cannot drift apart on a family's mark,
 * word or hue, or on what an added or removed diff line looks like.
 *
 * A `.ts` module because a production `.tsx` may export components only (the
 * Fast Refresh boundary).
 */

import type { DiffLineKind } from './diffRowModel.js'
import type { ToolFamily } from './transcriptProjector.js'

/**
 * P4-18b tool-card FAMILY grammar (`Messages.jsx` FrameEShell). Each family's
 * identity is its glyph + uppercase word + accent, applied to the mark/word
 * ONLY (never rails or washes). These are STATIC class strings — Tailwind's
 * scanner never sees an interpolated `text-[${hex}]` (the dynamic-class trap),
 * so the family hues live as literal arbitrary-value classes in this map. The
 * hues match the prototype's family palette; tokenized ones (edit/agent pink,
 * `other` muted) reuse theme tokens.
 */
export const FAMILY_STYLE: Record<
  ToolFamily,
  { mark: string; word: string; color: string }
> = {
  bash: { mark: '$', word: 'Bash', color: 'text-[light-dark(#4d7c0f,#a3e635)]' },
  read: { mark: '≡', word: 'Read', color: 'text-[light-dark(#2563eb,#60a5fa)]' },
  write: { mark: '+', word: 'Write', color: 'text-[light-dark(#c2410c,#fb923c)]' },
  edit: { mark: '±', word: 'Edit', color: 'text-accent' },
  grep: { mark: '⌕', word: 'Search', color: 'text-[light-dark(#a35f00,#fbbf24)]' },
  web: { mark: '↗', word: 'Web', color: 'text-[light-dark(#0e7490,#22d3ee)]' },
  mcp: { mark: '⧉', word: 'MCP', color: 'text-[light-dark(#7c3aed,#c084fc)]' },
  notebook: { mark: '▣', word: 'Notebook', color: 'text-[light-dark(#c2410c,#f97316)]' },
  lsp: { mark: '◈', word: 'LSP', color: 'text-[light-dark(#dc2626,#f87171)]' },
  skill: { mark: '§', word: 'Skill', color: 'text-[light-dark(#0f766e,#5eead4)]' },
  agent: { mark: '◆', word: 'Agent', color: 'text-accent' },
  // Same WORD as the spawn family, hollow mark against its filled one: ◆ creates
  // an agent, ◇ acts on one that already exists. The hue is the prototype's own
  // agent-family violet (`Messages.jsx` FE_FAMC `agent:'#a78bfa'`), which this
  // app left unused by tokenizing its agent family to `text-accent` — an
  // existing palette hue, not a new one. Literal class string, never
  // interpolated (the dynamic-class trap this map's header documents).
  'agent-control': { mark: '◇', word: 'Agent', color: 'text-[light-dark(#6d28d9,#a78bfa)]' },
  imagegen: { mark: '◰', word: 'Image', color: 'text-[light-dark(#a21caf,#e879f9)]' },
  other: { mark: '•', word: 'Tool', color: 'text-text-muted' },
}

// Diff semantics live on the add/delete wash and glyph, while source text takes
// its base and token colors from the selected code theme.
export const DIFF_ROW_CLASS: Record<DiffLineKind, string> = {
  // Exact prototype row washes rgba(34,197,94,0.1) / rgba(239,68,68,0.1). NOT the
  // green-500/red-500 utilities — Tailwind v4's oklch palette drifted those to
  // #00c758 / #fb2c36, so a literal hex keeps the prototype value exact.
  add: 'bg-[#22c55e]/10',
  del: 'bg-[#ef4444]/10',
  ctx: '',
}

export const DIFF_SIGN_CLASS: Record<DiffLineKind, string> = {
  add: 'text-tone-success',
  del: 'text-tone-danger',
  ctx: 'text-text-ghost',
}

// Word-level intra-line highlight (prototype DiffView, Messages.jsx:160-168): a
// CHANGED word carries the exact rgba(248,113,113,0.28) / rgba(74,222,128,0.26)
// wash (= tone-danger/28, tone-success/26) with a 2px radius + 1px x-pad; an
// UNCHANGED word dims by opacity so syntax-token colors still lead.
export const WORD_EMPH_CLASS: Record<'del' | 'add', string> = {
  del: 'rounded-[2px] bg-tone-danger/28 px-px',
  add: 'rounded-[2px] bg-tone-success/26 px-px',
}
export const WORD_DIM_CLASS: Record<'del' | 'add', string> = {
  del: 'opacity-60',
  add: 'opacity-60',
}
