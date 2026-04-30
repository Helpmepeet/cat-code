import type { Command } from '../../commands.js'

const installAgents = {
  type: 'local',
  name: 'install-agents',
  description: 'Install/uninstall macOS LaunchAgents for Codex token refresh',
  supportsNonInteractive: true,
  load: () => import('./install-agents.js'),
} satisfies Command

export default installAgents
