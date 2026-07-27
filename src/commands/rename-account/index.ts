import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'rename-account',
  description: 'Set a name for a saved account: /rename-account <id-prefix|current-alias> <new-alias>',
  supportsNonInteractive: true,
  load: () => import('./rename-account.js'),
} satisfies Command
