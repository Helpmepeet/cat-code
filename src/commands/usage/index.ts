import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show Codex usage limits',
  availability: ['openai'],
  load: () => import('./usage.js'),
} satisfies Command
