import type { Command } from '../../commands.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  immediate: true,
  description: 'Show help and available commands',
  load: () => import('./help.js'),
} satisfies Command

export default help
