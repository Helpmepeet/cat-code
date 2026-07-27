import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  immediate: true,
  description: 'Show Anthropic and Codex usage limits',
  availability: ['claude-ai', 'openai'],
  load: () => import('./usage.js'),
} satisfies Command
