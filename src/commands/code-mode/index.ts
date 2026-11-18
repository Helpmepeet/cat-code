import { isReplModeEnabled } from '../../tools/REPLTool/constants.js'
import type { Command } from '../../types/command.js'

export default {
  type: 'local',
  name: 'code-mode',
  description: 'Use Script first for coding in this chat',
  argumentHint: '[on|off]',
  supportsNonInteractive: true,
  isEnabled: isReplModeEnabled,
  load: () => import('./code-mode.js'),
} satisfies Command
