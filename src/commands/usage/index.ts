import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  immediate: true,
  description: 'Show Codex usage limits',
  availability: ['openai'],
  load: () => import('./usage.js'),
} satisfies Command
