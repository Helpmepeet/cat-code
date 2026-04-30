import type { Command } from '../../commands.js'

const agent = {
  type: 'local-jsx',
  name: 'agent',
  description: 'Start a fresh Agent mode session',
  load: () => import('./agent.js'),
} satisfies Command

export default agent
