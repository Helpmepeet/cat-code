import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set or view the goal for a long-running task',
  argumentHint:
    '[pause|resume|clear|replace <objective>|replace --budget N <objective>|--budget N <objective>|<objective>]',
  immediate: true,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
