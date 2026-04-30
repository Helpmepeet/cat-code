import { getKairosActive } from '../bootstrap/state.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { setCliTeammateModeOverride } from '../utils/swarm/backends/teammateModeSnapshot.js'
import { computeInitialTeamContext } from '../utils/swarm/reconnection.js'

let assistantForced = false

export function markAssistantForced(): void {
  assistantForced = true
}

export function isAssistantForced(): boolean {
  return assistantForced
}

export function isAssistantMode(): boolean {
  return assistantForced || getKairosActive()
}

export async function initializeAssistantTeam() {
  setCliTeammateModeOverride('in-process')
  return computeInitialTeamContext()
}

export function getAssistantSystemPromptAddendum(): string {
  return [
    'You are operating in assistant mode.',
    'Keep responses concise and favor taking action over narrating work.',
  ].join(' ')
}

export function getAssistantActivationPath(): string {
  return assistantForced ? '--assistant' : getOriginalCwd()
}
