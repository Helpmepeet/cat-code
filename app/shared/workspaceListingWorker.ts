import { isAbsolute } from 'node:path'
export const MAX_WORKSPACE_LISTING_BYTES = 1024 * 1024
export type WorkspaceListingRequest = { type: 'workspace-list'; version: 1; roots: string[] }
export type WorkspaceListingResult = { type: 'workspace-list-result'; version: 1; trustedRoots: string[] }
function roots(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(path => typeof path === 'string' && path.length > 0 && path.length <= 4096 && isAbsolute(path))
}
function record(value: unknown, type: string, field: string): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).length === 3 && v.type === type && v.version === 1 && roots(v[field])
}
export function parseWorkspaceListingRequest(value: unknown): WorkspaceListingRequest | null {
  return record(value, 'workspace-list', 'roots') ? value as WorkspaceListingRequest : null
}
export function parseWorkspaceListingResult(value: unknown): WorkspaceListingResult | null {
  return record(value, 'workspace-list-result', 'trustedRoots') ? value as WorkspaceListingResult : null
}
