import type { SessionDescriptor } from '../shared/hostApi.js'
import { resolveWorkspaceFile } from './openWorkspaceFile.js'

/** Fixed read-only host operation; no resolved path or file contents cross IPC. */
export async function workspaceFileAvailability(
  input: unknown,
  sessions: readonly SessionDescriptor[],
): Promise<boolean> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  if (Object.keys(input).some(key => key !== 'appSessionId' && key !== 'path')) return false
  return (await resolveWorkspaceFile(input, sessions)) !== null
}
