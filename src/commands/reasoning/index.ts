import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'reasoning',
  description:
    'Set reasoning display mode for Codex/GPT models (off, summary, raw)',
  argumentHint: '[off|summary|raw]',
  load: () => import('./reasoning.js'),
} satisfies Command
