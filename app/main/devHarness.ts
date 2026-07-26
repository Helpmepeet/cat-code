import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionDescriptor } from '../shared/hostApi.js'
import {
  DEBUG_STATE_VERSION,
  type DebugPendingPermission,
  type DebugRendererSnapshot,
  type DebugSidebarRow,
  type DebugTab,
} from '../shared/debugState.js'

export type DevCwdValidation = { ok: true; realpath: string } | { ok: false }

export type DevHarnessConfig = Readonly<{
  picker:
    | { kind: 'disabled' }
    | { kind: 'ready'; entries: readonly string[] }
    | { kind: 'broken'; reason: string }
  initialCwd: string | null
  initialCwdInvalid: boolean
  debugState: boolean
}>

export function resolveDevHarnessConfig(args: {
  isPackaged: boolean
  env: Partial<Record<string, string | undefined>>
  validateCwd: (cwd: string) => DevCwdValidation
  log: (line: string) => void
}): DevHarnessConfig {
  if (args.isPackaged) {
    return freezeConfig({
      picker: { kind: 'disabled' },
      initialCwd: null,
      initialCwdInvalid: false,
      debugState: false,
    })
  }

  let picker: DevHarnessConfig['picker'] = { kind: 'disabled' }
  const rawAllowlist = args.env.CATCODE_TEST_CWD_ALLOWLIST
  if (rawAllowlist && rawAllowlist.trim().length > 0) {
    const rawEntries = rawAllowlist.split(':').filter(part => part.length > 0)
    const entries: string[] = []
    let broken: string | null = null
    for (const entry of rawEntries) {
      const validated = args.validateCwd(entry)
      if (!validated.ok) {
        broken = `invalid allowlist cwd: ${entry}`
        break
      }
      entries.push(validated.realpath)
    }
    if (broken || entries.length === 0) {
      const reason = broken ?? 'empty allowlist'
      args.log(`[main] DEV CATCODE_TEST_CWD_ALLOWLIST broken: ${reason}`)
      picker = { kind: 'broken', reason }
    } else {
      args.log(`[main] DEV CATCODE_TEST_CWD_ALLOWLIST enabled (${entries.length} cwd(s))`)
      picker = { kind: 'ready', entries }
    }
  }

  let initialCwd: string | null = null
  let initialCwdInvalid = false
  const rawInitial = args.env.CATCODE_INITIAL_CWD
  if (rawInitial && rawInitial.trim().length > 0) {
    const validated = args.validateCwd(rawInitial)
    if (validated.ok) {
      initialCwd = validated.realpath
      args.log(`[main] DEV CATCODE_INITIAL_CWD enabled: ${validated.realpath}`)
    } else {
      initialCwdInvalid = true
      args.log(`[main] DEV CATCODE_INITIAL_CWD invalid: ${rawInitial}`)
    }
  }

  const debugState = args.env.CATCODE_DEBUG_STATE === '1'
  if (debugState) args.log('[main] DEV CATCODE_DEBUG_STATE enabled')

  return freezeConfig({ picker, initialCwd, initialCwdInvalid, debugState })
}

function freezeConfig(config: {
  picker: DevHarnessConfig['picker']
  initialCwd: string | null
  initialCwdInvalid: boolean
  debugState: boolean
}): DevHarnessConfig {
  if ('entries' in config.picker) Object.freeze(config.picker.entries)
  Object.freeze(config.picker)
  return Object.freeze(config)
}

export function createDevPickerBypass(
  config: DevHarnessConfig,
  args: {
    validateCwd: (cwd: string) => DevCwdValidation
    log: (line: string) => void
  },
): { enabled: boolean; pick: () => string | null } {
  if (config.picker.kind === 'disabled') {
    return { enabled: false, pick: () => null }
  }
  let cursor = 0
  return {
    enabled: true,
    pick() {
      const picker = config.picker
      if (picker.kind === 'broken') {
        args.log(`[main] DEV picker bypass broken: ${picker.reason}`)
        return null
      }
      if (picker.kind !== 'ready') return null
      const index = cursor
      const cwd = picker.entries[index]
      const validated = args.validateCwd(cwd)
      if (!validated.ok) {
        args.log(`[main] DEV picker bypass failed validation: ${cwd}`)
        return null
      }
      cursor = (cursor + 1) % picker.entries.length
      args.log(
        `[main] DEV picker bypass -> ${validated.realpath} (${index + 1}/${picker.entries.length})`,
      )
      return validated.realpath
    },
  }
}

export function createReadinessLatch(onReady: () => void): {
  windowReady: () => void
  rendererReady: () => void
} {
  let sawWindow = false
  let sawRenderer = false
  let emitted = false
  const maybe = () => {
    if (emitted || !sawWindow || !sawRenderer) return
    emitted = true
    onReady()
  }
  return {
    windowReady() {
      sawWindow = true
      maybe()
    },
    rendererReady() {
      sawRenderer = true
      maybe()
    },
  }
}

export function createDebouncedAction(
  action: () => void,
  options: {
    delayMs: number
    setTimer?: (callback: () => void, delayMs: number) => unknown
    clearTimer?: (timer: unknown) => void
  },
): { schedule: () => void; cancel: () => void } {
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let timer: unknown = null

  return {
    schedule() {
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => {
        timer = null
        action()
      }, options.delayMs)
    },
    cancel() {
      if (timer === null) return
      clearTimer(timer)
      timer = null
    },
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function resolvePickerDefaultPath(
  sessions: readonly SessionDescriptor[],
  activeSessionId: unknown,
): string | undefined {
  if (typeof activeSessionId === 'string' && UUID_RE.test(activeSessionId)) {
    const match = sessions.find(row => row.appSessionId === activeSessionId)
    if (match) return match.cwd
  }
  return sessions
    .filter(row => !row.restorable)
    .slice()
    .sort((a, b) => b.lastAttachedAt - a.lastAttachedAt)[0]?.cwd
}

type ParseResult =
  | { ok: true; value: DebugRendererSnapshot }
  | { ok: false; error: string }

const MAX_STRING = 1024
/**
 * Collection sanity bound for the debug snapshot parse (tabs, sidebar rows,
 * pending permissions, suggestion labels).
 *
 * A literal, deliberately NOT derived from `MAX_REGISTRY_SESSIONS` as it was
 * until 2026-07-26. That constant is a registry file-growth backstop; when it
 * was raised 32 → 256 for the browse-eviction fix (`decisions/REGISTRY.md` §3),
 * the derived form would have quadrupled this validation cap 128 → 1024 as a
 * silent side effect. 128 preserves the previously effective value.
 */
const MAX_ITEMS = 128
const TONES = new Set(['live', 'busy', 'warn', 'dead'])
const SIDEBAR_KINDS = new Set(['live', 'restorable'])

export function parseDebugSnapshot(input: unknown): ParseResult {
  if (!isPlainObject(input)) return fail('not an object')
  if (!exactKeys(input, ['debugStateVersion', 'rendererStateAt', 'renderer'])) {
    return fail('unknown top-level keys')
  }
  if (input.debugStateVersion !== DEBUG_STATE_VERSION) return fail('bad version')
  if (!isFiniteNumber(input.rendererStateAt)) return fail('bad rendererStateAt')
  const renderer = input.renderer
  if (!isPlainObject(renderer)) return fail('bad renderer')
  if (!exactKeys(renderer, ['activeSessionId', 'tabs', 'sidebar', 'permissions'])) {
    return fail('unknown renderer keys')
  }
  if (
    renderer.activeSessionId !== null &&
    !boundedString(renderer.activeSessionId)
  ) {
    return fail('bad activeSessionId')
  }
  if (!Array.isArray(renderer.tabs) || renderer.tabs.length > MAX_ITEMS) {
    return fail('bad tabs')
  }
  if (!Array.isArray(renderer.sidebar) || renderer.sidebar.length > MAX_ITEMS) {
    return fail('bad sidebar')
  }
  for (const tab of renderer.tabs) {
    if (!parseTab(tab)) return fail('bad tab')
  }
  for (const row of renderer.sidebar) {
    if (!parseSidebar(row)) return fail('bad sidebar row')
  }
  if (!isPlainObject(renderer.permissions)) return fail('bad permissions')
  const permissions = renderer.permissions as Record<string, unknown>
  if (Object.keys(permissions).length > MAX_ITEMS) return fail('too many permissions')
  for (const [sessionId, value] of Object.entries(permissions)) {
    if (!boundedString(sessionId) || !parsePermissionSession(value)) {
      return fail('bad permission session')
    }
  }
  return { ok: true, value: input as DebugRendererSnapshot }
}

function parseTab(input: unknown): input is DebugTab {
  if (!isPlainObject(input)) return false
  if (
    !exactKeys(input, [
      'appSessionId',
      'title',
      'label',
      'tone',
      'restartable',
      'needsAttention',
    ])
  ) return false
  return (
    boundedString(input.appSessionId) &&
    boundedString(input.title) &&
    boundedString(input.label) &&
    typeof input.tone === 'string' &&
    TONES.has(input.tone) &&
    typeof input.restartable === 'boolean' &&
    typeof input.needsAttention === 'boolean'
  )
}

function parseSidebar(input: unknown): input is DebugSidebarRow {
  if (!isPlainObject(input)) return false
  if (
    !exactKeys(input, [
      'appSessionId',
      'title',
      'subtitle',
      'kind',
      'label',
      'tone',
      'restorable',
    ])
  ) return false
  return (
    boundedString(input.appSessionId) &&
    boundedString(input.title) &&
    boundedString(input.subtitle) &&
    typeof input.kind === 'string' &&
    SIDEBAR_KINDS.has(input.kind) &&
    boundedString(input.label) &&
    typeof input.tone === 'string' &&
    TONES.has(input.tone) &&
    typeof input.restorable === 'boolean'
  )
}

function parsePermissionSession(input: unknown): boolean {
  if (!isPlainObject(input)) return false
  if (!exactKeys(input, ['mode', 'pending'])) return false
  if (!boundedString(input.mode)) return false
  if (!Array.isArray(input.pending) || input.pending.length > MAX_ITEMS) return false
  return input.pending.every(parsePendingPermission)
}

function parsePendingPermission(input: unknown): input is DebugPendingPermission {
  if (!isPlainObject(input)) return false
  if (
    !exactKeys(input, [
      'requestId',
      'toolName',
      'toolDisplayName',
      'displayTitle',
      'suggestionLabels',
    ])
  ) return false
  return (
    boundedString(input.requestId) &&
    boundedString(input.toolName) &&
    boundedString(input.toolDisplayName) &&
    boundedString(input.displayTitle) &&
    Array.isArray(input.suggestionLabels) &&
    input.suggestionLabels.length <= MAX_ITEMS &&
    input.suggestionLabels.every(boundedString)
  )
}

export function atomicWriteJson0600(path: string, value: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${Date.now()}.${process.pid}.tmp`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = keys.slice().sort()
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function fail(error: string): ParseResult {
  return { ok: false, error }
}
