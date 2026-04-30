import type { Command } from '../../commands.js'

const switchAccount = {
  type: 'local',
  name: 'switch-account',
  description: 'Switch to the next Codex account (or specify an account ID prefix)',
  aliases: ['sa'],
  supportsNonInteractive: true,
  load: () => import('./switch-account.js'),
} satisfies Command

export default switchAccount
