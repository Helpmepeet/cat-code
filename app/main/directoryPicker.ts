import type { SessionDescriptor } from '../shared/hostApi.js'
import { resolvePickerDefaultPath } from './devHarness.js'

export function createDirectoryPickerHandlers<Event>(dependencies: {
  isAuthorized: (event: Event) => boolean
  sessions: () => readonly SessionDescriptor[]
  pick: (defaultPath?: string) => Promise<string | null>
}) {
  return {
    legacy(event: Event, activeSessionId?: unknown): Promise<string | null> {
      if (!dependencies.isAuthorized(event) || activeSessionId !== undefined && activeSessionId !== null && typeof activeSessionId !== 'string') return Promise.resolve(null)
      return dependencies.pick(resolvePickerDefaultPath(dependencies.sessions(), activeSessionId))
    },
    scheduled(event: Event, payload?: unknown): Promise<string | null> {
      if (!dependencies.isAuthorized(event) || payload !== undefined) return Promise.resolve(null)
      return dependencies.pick()
    },
  }
}
