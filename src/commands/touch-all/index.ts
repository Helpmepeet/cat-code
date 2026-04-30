import type { Command } from '../../commands.js'

const touchAll = {
  type: 'local',
  name: 'touch-all',
  description: 'Refresh OAuth tokens for all unlocked Codex vault accounts',
  supportsNonInteractive: true,
  load: () => import('./touch-all.js'),
} satisfies Command

export default touchAll
