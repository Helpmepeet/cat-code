import { isAbsolute } from 'node:path'
import type { ProjectMetadata } from './projectMetadata.js'
export const MAX_WORKSPACE_LISTING_BYTES = 1024 * 1024
export type WorkspaceMetadata = ProjectMetadata & { path: string }
export type WorkspaceListingRequest = { type: 'workspace-list'; version: 1; roots: string[]; metadataOffset?: number }
export type WorkspaceListingResult = { type: 'workspace-list-result'; version: 1; trustedRoots: string[]; metadata?: WorkspaceMetadata[] }
function roots(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && new Set(value).size === value.length && value.every(path => typeof path === 'string' && path.length > 0 && path.length <= 4096 && isAbsolute(path))
}
function record(value: unknown, type: string, field: string, optional: string): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(key => ['type', 'version', field, optional].includes(key)) && v.type === type && v.version === 1 && roots(v[field])
}
function text(value: unknown, max: number, nonempty = false): value is string {
  return typeof value === 'string' && (!nonempty || value.length > 0) && Array.from(value).length <= max && value === value.normalize('NFC').trim().replace(/\s+/gu, ' ') && !/[\p{Cc}\uD800-\uDFFF]/u.test(value)
}
function metadata(value: unknown, trusted: string[]): value is WorkspaceMetadata[] {
  if (!Array.isArray(value) || value.length > 8) return false
  const seen = new Set<string>()
  return value.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['path', 'aliases', 'description', 'metadataWarning'].includes(key))) return false
    if (!trusted.includes(row.path) || seen.has(row.path)) return false
    seen.add(row.path)
    if (!Array.isArray(row.aliases) || row.aliases.length > 12 || !row.aliases.every((alias: unknown) => text(alias, 80, true))) return false
    const keys = row.aliases.map((alias: string) => alias.toLowerCase().normalize('NFC'))
    return new Set(keys).size === keys.length && text(row.description, 320) && (!Object.hasOwn(row, 'metadataWarning') || text(row.metadataWarning, 320, true))
  })
}
export function parseWorkspaceListingRequest(value: unknown): WorkspaceListingRequest | null {
  if (!record(value, 'workspace-list', 'roots', 'metadataOffset')) return null
  if (Object.hasOwn(value, 'metadataOffset') && (!Number.isSafeInteger(value.metadataOffset) || (value.metadataOffset as number) < 0 || (value.metadataOffset as number) > 127)) return null
  return value as WorkspaceListingRequest
}
export function parseWorkspaceListingResult(value: unknown): WorkspaceListingResult | null {
  if (!record(value, 'workspace-list-result', 'trustedRoots', 'metadata')) return null
  if (Object.hasOwn(value, 'metadata') && !metadata(value.metadata, value.trustedRoots as string[])) return null
  return value as WorkspaceListingResult
}
