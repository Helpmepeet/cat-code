import { isRecord } from './narrow.js'

export type ProjectRouteChoice = 'move' | 'stay' | 'cancel' | 'resend'
export type ProjectRouteSnapshot = {
  appSessionId: string
  submitId: string
  phase: 'checking' | 'ask' | 'moving' | 'recovery' | 'uncertain' | 'failed' | 'unsent'
  text: string
  projectName: string | null
  message: string | null
}
export type ProjectRouteCommand = {
  appSessionId: string
  submitId: string
  choice: ProjectRouteChoice
}
export type ProjectRouteDecision =
  | { kind: 'stay' }
  | { kind: 'auto' | 'ask'; cwd: string; name: string; explicit: boolean }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function parseProjectRouteCommand(value: unknown): ProjectRouteCommand | null {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'appSessionId,choice,submitId' ||
      typeof value.appSessionId !== 'string' || !uuid.test(value.appSessionId) ||
      typeof value.submitId !== 'string' || !uuid.test(value.submitId) ||
      !['move', 'stay', 'cancel', 'resend'].includes(String(value.choice))) return null
  return value as ProjectRouteCommand
}
