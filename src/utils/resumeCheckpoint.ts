import { createHash } from 'node:crypto'
import { isHandoffUuid } from '../../app/shared/workspaceHandoff.js'
import type { Message } from '../types/message.js'
import {
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from './messages.js'

// These fields describe storage topology and the writer's session envelope.
// Message provenance, restore flags, tool results and usage remain in the proof.
const STORAGE_ENVELOPE = new Set(['parentUuid', 'logicalParentUuid', 'isSidechain',
  'sessionBinding', 'teamName', 'agentName', 'promptId', 'agentId', 'userType',
  'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch', 'slug'])

export function canonicalResumeJson(value: unknown): string {
  const encode = (item: unknown, array = false): string | undefined => {
    if (item === undefined) {
      if (array) throw new Error('Resume projection contains undefined array content')
      return undefined
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) if (!Object.hasOwn(item, index)) throw new Error('Resume projection contains sparse array content')
      return `[${item.map(value => encode(value, true)).join(',')}]`
    }
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new Error('Resume projection contains a non-JSON value')
    }
    return `{${Object.keys(item as object).sort().flatMap(key => {
      const encoded = encode((item as Record<string, unknown>)[key])
      return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`]
    }).join(',')}}`
  }
  const encoded = encode(value)
  if (encoded === undefined) throw new Error('Resume projection has no JSON value')
  return encoded
}

export function resumeProjectionV1(messages: readonly unknown[]): unknown[] {
  return messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid resume message')
    return Object.fromEntries(Object.entries(message).filter(([key]) => !STORAGE_ENVELOPE.has(key)))
  })
}

export function resumeProjectionSha256(messages: readonly unknown[]): string {
  return createHash('sha256').update(canonicalResumeJson(resumeProjectionV1(messages))).digest('hex')
}

/**
 * Unlike API normalization, this projection never merges user identities or
 * invents rows. Work on independent JSON inputs so filters cannot mutate the
 * engine's retained evidence or the archived chain supplied by the caller.
 */
export function resumeProjectionV2(messages: readonly Message[]): unknown[] {
  const independent = JSON.parse(canonicalResumeJson(resumeProjectionV1(messages))) as Message[]
  return resumeProjectionV1(filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(filterUnresolvedToolUses(independent)),
    { preserveUserIdentities: true },
  ))
}

export function resumeProjectionV2Sha256(messages: readonly Message[]): string {
  return createHash('sha256').update(canonicalResumeJson(resumeProjectionV2(messages))).digest('hex')
}

/**
 * Sealing admission only, not a substitute for prefix/tip verification.
 * Both arguments must be independently obtained, ordered active chains after
 * logging transforms and final metadata persistence. The returned digest is
 * computed from intended engine state, never manufactured from the archive.
 */
export function verifyResumeProjectionV2(
  intended: readonly Message[],
  archived: readonly Message[],
): Pick<import('../../app/shared/workspaceHandoff.js').ResumeCheckpointV2, 'projectionSha256' | 'messageCount'> {
  const indexRows = (messages: readonly Message[]) => {
    const rows = new Map<string, { content: string; index: number }>()
    resumeProjectionV1(messages).forEach((row, index) => {
      const message = row as Record<string, unknown>
      if (!isHandoffUuid(message.uuid) || rows.has(message.uuid)) throw new Error('Invalid or duplicate resume message UUID')
      rows.set(message.uuid, { content: canonicalResumeJson(row), index })
    })
    return rows
  }
  const expectedRows = indexRows(intended)
  const archivedRows = indexRows(archived)
  let previousIndex = -1
  for (const [uuid, expected] of expectedRows) {
    const stored = archivedRows.get(uuid)
    if (!stored || stored.content !== expected.content) throw new Error('Retained resume message differs from archive')
    if (stored.index <= previousIndex) throw new Error('Retained resume message order differs from archive')
    previousIndex = stored.index
  }
  const expectedProjection = resumeProjectionV2(intended)
  if (canonicalResumeJson(expectedProjection) !== canonicalResumeJson(resumeProjectionV2(archived))) {
    throw new Error('Transcript resume projection V2 differs')
  }
  return {
    projectionSha256: createHash('sha256').update(canonicalResumeJson(expectedProjection)).digest('hex'),
    messageCount: expectedProjection.length,
  }
}

export type { ResumeCheckpointV1, ResumeCheckpointV2, ResumeCheckpoint } from '../../app/shared/workspaceHandoff.js'
