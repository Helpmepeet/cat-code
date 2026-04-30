import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'delete-account',
  description: 'Delete a saved account: /delete-account <id-prefix|alias>',
  supportsNonInteractive: true,
  load: () => import('./delete-account.js'),
} satisfies Command
