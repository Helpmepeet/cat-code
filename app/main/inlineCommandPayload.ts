import type { InlineCommandMessage } from '../shared/protocol.js'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}
function index(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Main's closed transport gate; the sidecar independently resolves source and authority.
 * Decision: docs/plans/2026-10-22-inline-command-run.md §4A,B.
 */
export function parseInlineCommandPayload(
  raw: unknown,
  type: InlineCommandMessage['type'],
): { sessionId: string; verb: InlineCommandMessage } | null {
  if (!record(raw) || !keys(raw, ['sessionId', 'verb']) || !id(raw.sessionId)) return null
  const verb = raw.verb
  if (!record(verb) || verb.type !== type || !id(verb.requestId)) return null
  if (type === 'inline-command.get') {
    if (!keys(verb, ['type', 'requestId'])) return null
  } else {
    if (!id(verb.generation)) return null
    if (type === 'inline-command.stop') {
      if (!keys(verb, ['type', 'requestId', 'generation', 'runId']) || !id(verb.runId)) return null
    } else {
      if (!keys(verb, ['type', 'requestId', 'generation', 'source'])) return null
      const source = verb.source
      if (!record(source) || !keys(source, ['engineSessionId', 'messageUuid', 'contentBlockIndex', 'fenceOrdinal']) ||
          !id(source.engineSessionId) || !id(source.messageUuid) ||
          !index(source.contentBlockIndex) || !index(source.fenceOrdinal)) return null
    }
  }
  return { sessionId: raw.sessionId, verb: verb as InlineCommandMessage }
}
