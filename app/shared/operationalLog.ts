/**
 * Privacy-safe desktop operational logging.
 *
 * This module deliberately has no Electron, Node filesystem, engine, or IPC
 * dependency. Every producer shares this small closed record vocabulary; the
 * main-process sink is the only persistence owner.
 */

export const OPERATIONAL_LOG_VERSION = 1 as const
export const MAX_OPERATIONAL_STRING_BYTES = 512
export const MAX_OPERATIONAL_FIELDS = 16

export type OperationalLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** Events are intentionally transitions/failures, never arbitrary log lines. */
export const OPERATIONAL_EVENTS = [
  'app.start',
  'app.single_instance.refused',
  'app.ready',
  'app.shutdown.started',
  'app.shutdown.completed',
  'app.fatal',
  'process.started',
  'process.exited',
  'window.created',
  'renderer.load.started',
  'renderer.load.ready',
  'renderer.load.failed',
  'renderer.navigation.started',
  'renderer.navigation.completed',
  'renderer.process.gone',
  'renderer.unresponsive',
  'renderer.responsive',
  'renderer.javascript.error',
  'renderer.promise.unhandled',
  'renderer.component.failed',
  'renderer.health.sample',
  'renderer.health.missed',
  'renderer.health.unavailable',
  'renderer.health.recovered',
  'registry.load.completed',
  'registry.write.failed',
  'registry.orphan.swept',
  'registry.rows.reaped',
  'session.create.requested',
  'sidecar.spawn.started',
  'sidecar.spawn.failed',
  'sidecar.socket.connected',
  'sidecar.ready',
  'sidecar.disconnected',
  'sidecar.exit',
  'session.restore.started',
  'session.restore.completed',
  'session.restore.failed',
  'worker.started',
  'worker.completed',
  'worker.failed',
  'diagnostic',
  'log.coverage.incomplete',
  'log.suppressed',
] as const

export type OperationalEvent = (typeof OPERATIONAL_EVENTS)[number]

export type SafeOperationalValue = string | number | boolean | null
export type OperationalFields = Readonly<Record<string, SafeOperationalValue>>

/**
 * A record cannot smuggle an arbitrary diagnostic blob in under a new field
 * name. Keep this vocabulary deliberately small and metadata-shaped.
 */
const OPERATIONAL_FIELD_KEYS = new Set([
  'arch', 'category', 'code', 'count', 'durationMs', 'elapsedMs', 'eventLoopLagMs', 'exitCode',
  'frame', 'messageCount', 'missed', 'navigation', 'packaged', 'pid',
  'platform', 'queuedBytes', 'reason', 'role', 'sessions', 'source', 'version',
  'signal', 'expected',
])

/**
 * Fields are deliberately discriminated by event. The broad key set above is
 * only the finite universe; this table prevents a valid field for one event
 * (for example a pid) from becoming an arbitrary free-form diagnostic slot on
 * another event.
 */
const OPERATIONAL_EVENT_FIELD_KEYS: Partial<Record<OperationalEvent, readonly string[]>> = {
  'app.start': ['version', 'packaged', 'platform', 'arch'],
  'app.ready': ['durationMs'],
  'app.shutdown.started': ['reason'],
  'app.fatal': ['reason'],
  'process.started': ['role', 'pid'],
  'process.exited': ['role', 'exitCode', 'signal', 'expected'],
  'renderer.load.started': ['source'],
  'renderer.load.failed': ['code', 'reason'],
  'renderer.navigation.started': ['navigation'],
  'renderer.process.gone': ['reason', 'exitCode'],
  'renderer.responsive': ['durationMs'],
  'renderer.health.sample': ['sessions', 'eventLoopLagMs'],
  'renderer.health.missed': ['missed', 'elapsedMs'],
  'renderer.health.unavailable': ['missed', 'elapsedMs'],
  'renderer.health.recovered': ['sessions', 'missed', 'eventLoopLagMs', 'durationMs'],
  'sidecar.spawn.started': ['pid'],
  'sidecar.spawn.failed': ['reason'],
  'sidecar.ready': ['frame', 'pid'],
  'sidecar.disconnected': ['reason'],
  'sidecar.exit': ['exitCode', 'signal', 'expected'],
  'session.restore.completed': ['messageCount'],
  diagnostic: ['source', 'category', 'queuedBytes', 'reason'],
  'log.coverage.incomplete': ['source', 'reason', 'expected'],
  'log.suppressed': ['count', 'reason'],
}

export type OperationalRecord = Readonly<{
  version: typeof OPERATIONAL_LOG_VERSION
  timestamp: string
  monotonicTimestampMs: number
  level: OperationalLogLevel
  event: OperationalEvent
  launchId: string
  process: 'main' | 'host' | 'supervisor' | 'sidecar' | 'worker' | 'renderer'
  processInstanceId: string
  pid: number
  processStartedAt: string
  appSessionId?: string
  engineSessionId?: string
  fields: OperationalFields
}>

export type OperationalRecordInput = Omit<
  OperationalRecord,
  | 'version' | 'timestamp' | 'monotonicTimestampMs' | 'launchId'
  | 'processInstanceId' | 'pid' | 'processStartedAt' | 'fields'
> & {
  fields?: OperationalFields
}

const SECRET_KEY = /(token|secret|password|credential|authorization|cookie|vault|api[_-]?key)/i
// Any rooted POSIX or Windows path is personal/environmental information.  The
// second-pass bundle parser only admits opaque identifiers, but operational
// fields still need this broad first-pass protection.
// A leading-delimiter class only caught a path after whitespace or a quote, so
// any other delimiter carried it through intact ("cwd=/Users/…"). Excluding the
// characters a path segment is built from catches every rooted path while
// leaving a relative segment ("and/or") alone; the inner guard stops the "//"
// of an already-rewritten URL from reading as a rooted path.
const ABSOLUTE_PATH = /(?:(?<![A-Za-z0-9._-])[A-Za-z]:[\\/][^\s"')]*|\\\\[^\s"']+|(?<![A-Za-z0-9._\\/:-])\/\/[^\s"')]+|(?<![A-Za-z0-9._\\/-])\/(?!\/)[^\s"')]+)/g
// Every scheme, not only http(s): a file:// URL names the same home directory.
const URL_WITH_SENSITIVE_PARTS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const TOKEN_SHAPE = /\b(?:bearer\s+)?(?:sk|rk|pk|ghp|eyJ)[A-Za-z0-9._-]{12,}\b/gi
const CONTROL = /[\u0000-\u001f\u007f]/g

/** The same opaque-identifier grammar the export parser enforces. */
export function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function sanitizeOperationalText(value: string): string {
  const redacted = value
    .replace(URL_WITH_SENSITIVE_PARTS, raw => {
      try {
        const url = new URL(raw)
        return `${url.protocol}//${url.host}`
      } catch {
        return '[redacted-url]'
      }
    })
    .replace(EMAIL, '[redacted-email]')
    .replace(ABSOLUTE_PATH, ' [redacted-path]')
    .replace(TOKEN_SHAPE, '[redacted-token]')
    .replace(CONTROL, ' ')
  return truncateUtf8(redacted.trim(), MAX_OPERATIONAL_STRING_BYTES)
}

export function sanitizeOperationalFields(
  fields: OperationalFields | undefined,
  event?: OperationalEvent,
): OperationalFields {
  if (!fields) return {}
  const entries = Object.entries(fields)
  if (entries.length > MAX_OPERATIONAL_FIELDS) {
    throw new Error('operational record has too many fields')
  }
  const result: Record<string, SafeOperationalValue> = {}
  for (const [key, value] of entries) {
    const allowedForEvent = event ? OPERATIONAL_EVENT_FIELD_KEYS[event] ?? [] : undefined
    if (!OPERATIONAL_FIELD_KEYS.has(key) || (allowedForEvent !== undefined && !allowedForEvent.includes(key)) || SECRET_KEY.test(key)) {
      throw new Error(`operational record has unsafe field ${key}`)
    }
    if (typeof value === 'string') result[key] = sanitizeOperationalText(value)
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
    else if (typeof value === 'boolean' || value === null) result[key] = value
    else throw new Error(`operational record has unsupported field ${key}`)
  }
  return result
}

export function createOperationalRecord(
  input: OperationalRecordInput,
  context: Pick<OperationalRecord, 'launchId' | 'processInstanceId'> & {
    now?: () => Date
    monotonicNow?: () => number
    pid?: number
    processStartedAt?: string
  },
): OperationalRecord {
  if (!(OPERATIONAL_EVENTS as readonly string[]).includes(input.event)) {
    throw new Error(`unknown operational event ${String(input.event)}`)
  }
  if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(input.level)) {
    throw new Error(`unknown operational level ${String(input.level)}`)
  }
  if (!['main', 'host', 'supervisor', 'sidecar', 'worker', 'renderer'].includes(input.process)) {
    throw new Error(`unknown operational process ${String(input.process)}`)
  }
  return {
    version: OPERATIONAL_LOG_VERSION,
    timestamp: (context.now ?? (() => new Date()))().toISOString(),
    monotonicTimestampMs: (context.monotonicNow ?? (() => performance.now()))(),
    level: input.level,
    event: input.event,
    launchId: context.launchId,
    process: input.process,
    processInstanceId: context.processInstanceId,
    pid: context.pid ?? (typeof process === 'undefined' ? 0 : process.pid),
    processStartedAt: context.processStartedAt ?? (context.now ?? (() => new Date()))().toISOString(),
    ...(input.appSessionId ? { appSessionId: sanitizeOperationalText(input.appSessionId) } : {}),
    ...(input.engineSessionId
      ? { engineSessionId: sanitizeOperationalText(input.engineSessionId) }
      : {}),
    fields: sanitizeOperationalFields(input.fields, input.event),
  }
}

/** Reject untrusted sidecar/renderer records rather than ever echoing them. */
export function parseOperationalRecord(value: unknown): OperationalRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const allowed = new Set([
    'version', 'timestamp', 'monotonicTimestampMs', 'level', 'event', 'launchId',
    'process', 'processInstanceId', 'pid', 'processStartedAt', 'appSessionId',
    'engineSessionId', 'fields',
  ])
  if (
    Object.keys(item).some(key => !allowed.has(key)) ||
    item.version !== OPERATIONAL_LOG_VERSION ||
    typeof item.timestamp !== 'string' ||
    !Object.values<string>(OPERATIONAL_EVENTS).includes(item.event as string) ||
    !['debug', 'info', 'warn', 'error', 'fatal'].includes(item.level as string) ||
    !['main', 'host', 'supervisor', 'sidecar', 'worker', 'renderer'].includes(item.process as string) ||
    // These four are minted identifiers, never prose. Accepting any string here
    // left the widest hole at this boundary: a producer could carry a path, an
    // address, or a credential out through an id rather than a metadata field,
    // where only pattern redaction stood in the way.
    !isOpaqueIdentifier(item.launchId) ||
    !isOpaqueIdentifier(item.processInstanceId) ||
    (item.appSessionId !== undefined && !isOpaqueIdentifier(item.appSessionId)) ||
    (item.engineSessionId !== undefined && !isOpaqueIdentifier(item.engineSessionId)) ||
    !item.fields ||
    typeof item.fields !== 'object' ||
    Array.isArray(item.fields)
  ) {
    return null
  }
  try {
    return {
      version: OPERATIONAL_LOG_VERSION,
      timestamp: new Date(item.timestamp).toISOString(),
      monotonicTimestampMs: typeof item.monotonicTimestampMs === 'number' && Number.isFinite(item.monotonicTimestampMs)
        ? item.monotonicTimestampMs
        : 0,
      level: item.level as OperationalLogLevel,
      event: item.event as OperationalEvent,
      launchId: sanitizeOperationalText(item.launchId),
      process: item.process as OperationalRecord['process'],
      processInstanceId: sanitizeOperationalText(item.processInstanceId),
      pid: typeof item.pid === 'number' && Number.isSafeInteger(item.pid) && item.pid >= 0 ? item.pid : 0,
      processStartedAt: typeof item.processStartedAt === 'string'
        ? new Date(item.processStartedAt).toISOString()
        : new Date(item.timestamp).toISOString(),
      ...(typeof item.appSessionId === 'string'
        ? { appSessionId: sanitizeOperationalText(item.appSessionId) }
        : {}),
      ...(typeof item.engineSessionId === 'string'
        ? { engineSessionId: sanitizeOperationalText(item.engineSessionId) }
        : {}),
      fields: sanitizeOperationalFields(item.fields as OperationalFields, item.event as OperationalEvent),
    }
  } catch {
    return null
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return value
  return new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes - 3))) + '...'
}
