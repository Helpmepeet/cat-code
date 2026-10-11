import { createHash } from 'node:crypto'
import type { ResumeCheckpointV1 } from '../../app/shared/workspaceHandoff.js'

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

export type { ResumeCheckpointV1 }
