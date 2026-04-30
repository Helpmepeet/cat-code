import type { Command } from '../../commands.js'

const cacheStats = {
  type: 'local',
  name: 'cache-stats',
  description: 'Show Codex prompt cache hit rate for the last 20 requests',
  supportsNonInteractive: true,
  load: () => import('./cache-stats.js'),
} satisfies Command

export default cacheStats
