import type { Command } from '../../commands.js'

const continueAfterLimit = {
  type: 'local-jsx',
  name: 'continue-after-limit',
  description: 'Continue this Codex conversation after a confirmed usage reset',
  argumentHint: '[status|cancel|enable-background|disable-background]',
  immediate: true,
  disableModelInvocation: true,
  userInvocable: true,
  load: () => import('./continue-after-limit.js'),
} satisfies Command

export default continueAfterLimit
