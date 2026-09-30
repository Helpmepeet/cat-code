import type { SubmitPrompt } from './protocol.js'
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
export type ProjectRouteWorkerRequest = {
  type: 'project-route'
  version: 1
  text: string
  previousUserMessages: string[]
  knownProjectRoots: string[]
  suppressedRoots: string[]
  model: string | null
}
export type ProjectRouteWorkerResult = {
  type: 'project-route-result'
  version: 1
  decision: ProjectRouteDecision
}
export const MAX_PROJECT_ROUTE_RECORD_BYTES = 64 * 1024
export const MAX_PROJECT_ROUTE_TEXT_CHARS = 12_000
export const MAX_PROJECT_ROUTE_ROOTS = 128
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const path = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0')
const roots = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_PROJECT_ROUTE_ROOTS && value.every(path)

export function projectRouteText(prompt: SubmitPrompt): string {
  return typeof prompt === 'string' ? prompt : prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

export function parseProjectRouteCommand(value: unknown): ProjectRouteCommand | null {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'appSessionId,choice,submitId' ||
      typeof value.appSessionId !== 'string' || !uuid.test(value.appSessionId) ||
      typeof value.submitId !== 'string' || !uuid.test(value.submitId) ||
      !['move', 'stay', 'cancel', 'resend'].includes(String(value.choice))) return null
  return value as ProjectRouteCommand
}

export function parseProjectRouteWorkerRequest(value: unknown): ProjectRouteWorkerRequest | null {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'knownProjectRoots,model,previousUserMessages,suppressedRoots,text,type,version' ||
      value.type !== 'project-route' || value.version !== 1 ||
      typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_PROJECT_ROUTE_TEXT_CHARS ||
      !Array.isArray(value.previousUserMessages) || value.previousUserMessages.length > 3 ||
      !value.previousUserMessages.every(text => typeof text === 'string' && text.length <= 2000) ||
      !roots(value.knownProjectRoots) || !roots(value.suppressedRoots) ||
      (value.model !== null && (typeof value.model !== 'string' || value.model.length > 200))) return null
  return value as ProjectRouteWorkerRequest
}

export function parseProjectRouteWorkerResult(value: unknown): ProjectRouteWorkerResult | null {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'decision,type,version' ||
      value.type !== 'project-route-result' || value.version !== 1 || !isRecord(value.decision)) return null
  const decision = value.decision
  if (decision.kind === 'stay') return Object.keys(decision).length === 1 ? value as ProjectRouteWorkerResult : null
  if ((decision.kind !== 'auto' && decision.kind !== 'ask') ||
      Object.keys(decision).sort().join(',') !== 'cwd,explicit,kind,name' || !path(decision.cwd) ||
      typeof decision.name !== 'string' || decision.name.length === 0 || decision.name.length > 200 ||
      typeof decision.explicit !== 'boolean') return null
  return value as ProjectRouteWorkerResult
}
