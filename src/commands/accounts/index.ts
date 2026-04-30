import type { Command } from '../../commands.js'

const accounts = {
  type: 'local',
  name: 'accounts',
  description: 'Show Codex account pool status',
  supportsNonInteractive: true,
  load: () => import('./accounts.js'),
} satisfies Command

export default accounts
