import { isEnvTruthy } from '../utils/envUtils.js'

export function isNewInstructionEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_NEW_INSTRUCTION)
}
