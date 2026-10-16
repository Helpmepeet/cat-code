import type { WorkspaceObservation } from './protocol.js'
import { isAbsolute } from 'node:path'

export const MAX_WORKSPACE_OBSERVATION_BYTES = 16 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseWorkspaceObservationRequest(value: unknown): { engineSessionId: string } | null {
  if (!record(value) || Object.keys(value).some(key => key !== 'engineSessionId')) return null
  return typeof value.engineSessionId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.engineSessionId)
    ? { engineSessionId: value.engineSessionId } : null
}

export function parseWorkspaceObservation(value: unknown): WorkspaceObservation | null {
  if (!record(value) || Object.keys(value).some(key => key !== 'cwd' && key !== 'lastWorkingBranch')) return null
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || value.cwd.length > 4096 || value.cwd.includes('\0')) return null
  if (value.lastWorkingBranch !== undefined && value.lastWorkingBranch !== null &&
    (typeof value.lastWorkingBranch !== 'string' || value.lastWorkingBranch.length === 0 || value.lastWorkingBranch.length > 4096)) return null
  return { cwd: value.cwd, ...(value.lastWorkingBranch !== undefined ? { lastWorkingBranch: value.lastWorkingBranch as string | null } : {}) }
}
