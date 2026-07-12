import type { Command } from '../../commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  immediate: true,
  description: 'Show your Cat Code usage statistics and activity',
  load: () => import('./stats.js'),
} satisfies Command

export default stats
