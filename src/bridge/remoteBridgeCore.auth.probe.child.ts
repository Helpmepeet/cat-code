import { expect, mock } from 'bun:test'

const mode = process.argv[2]
const modulePath = (name: string) => new URL(name, import.meta.url).href
let token = 'oauth-a-r0'
let identity = { accountId: 'a', generation: 1, revision: 0 }
let authReadThrows = false
let repairCalls = 0
let preparations = 0
let poisoned = false
let scheduler: any
const transports: any[] = []
const fetched: string[] = []
const archives: string[] = []
const events: Array<{ name: string; data: any }> = []
const states: string[] = []
const archiveGate = Promise.withResolvers<{ status: number; data: object }>()
const archiveStarted = Promise.withResolvers<void>()
const prepareGate = Promise.withResolvers<any>()
const prepareStarted = Promise.withResolvers<void>()
const credentials = () => ({ worker_jwt: 'worker-jwt', expires_in: 3600, api_base_url: 'https://ingress.invalid', worker_epoch: fetched.length + 1 })

mock.module(modulePath('./replBridgeTransport.ts'), () => ({
  createV2ReplTransport: async () => {
    const transport: any = {
      closed: false, onConnect: () => {}, onClose: () => {},
      setOnConnect(fn: () => void) { this.onConnect = fn },
      setOnData() {}, setOnClose(fn: (code: number) => void) { this.onClose = fn },
      connect() { this.onConnect() }, close() { this.closed = true },
      getLastSequenceNum: () => 0, reportState() {}, write: async () => {}, writeBatch: async () => {},
    }
    transports.push(transport)
    return transport
  },
}))
mock.module(modulePath('./workSecret.ts'), () => ({ buildCCRv2SdkUrl: () => 'https://ingress.invalid/session' }))
mock.module(modulePath('./sessionIdCompat.ts'), () => ({ toCompatSessionId: () => 'session-isolated' }))
mock.module(modulePath('./jwtUtils.ts'), () => ({ createTokenRefreshScheduler: (options: any) => {
  scheduler = options
  return { scheduleFromExpiresIn() {}, cancelAll() {} }
} }))
mock.module(modulePath('./trustedDevice.ts'), () => ({ getTrustedDeviceToken: () => undefined }))
mock.module(modulePath('./envLessBridgeConfig.ts'), () => ({ getEnvLessBridgeConfig: async () => ({
  http_timeout_ms: 100, teardown_archive_timeout_ms: 100, init_retry_max_attempts: 1,
  uuid_dedup_buffer_size: 100, connect_timeout_ms: 60_000,
}) }))
mock.module(modulePath('./bridgeMessaging.ts'), () => ({
  handleIngressMessage() {}, handleServerControlRequest() {}, makeResultMessage: () => ({}),
  isEligibleBridgeMessage: () => false, extractTitleText: () => undefined,
  BoundedUUIDSet: class extends Set { constructor(_capacity: number) { super() } },
}))
mock.module(modulePath('./debugUtils.ts'), () => ({ logBridgeSkip() {} }))
mock.module(modulePath('../utils/debug.ts'), () => ({ logForDebugging() {} }))
mock.module(modulePath('../utils/diagLogs.ts'), () => ({ logForDiagnosticsNoPII() {} }))
mock.module(modulePath('../utils/envUtils.ts'), () => ({ isInProtectedNamespace: () => false }))
mock.module(modulePath('../utils/errors.ts'), () => ({ errorMessage: () => 'isolated error' }))
mock.module(modulePath('../utils/sleep.ts'), () => ({ sleep: async () => {} }))
mock.module(modulePath('../utils/cleanupRegistry.ts'), () => ({ registerCleanup: () => () => {} }))
mock.module(modulePath('../services/analytics/index.ts'), () => ({ logEvent: (name: string, data: any) => events.push({ name, data }) }))
mock.module(modulePath('./codeSessionApi.ts'), () => ({
  createCodeSession: async () => 'cse-isolated',
  fetchRemoteCredentials: async (_session: string, _url: string, sent: string) => { fetched.push(sent); return credentials() },
}))
mock.module(modulePath('./bridgeConfig.ts'), () => ({ getBridgeBaseUrlOverride: () => undefined }))
mock.module('axios', () => ({ default: {
  post: async (_url: string, _body: unknown, config: any) => {
    archives.push(config.headers.Authorization)
    archiveStarted.resolve()
    return archives.length === 1 && mode.startsWith('archive-') ? archiveGate.promise : { status: 200, data: {} }
  },
  isAxiosError: () => false,
} }))

const { initEnvLessBridgeCore } = await import('./remoteBridgeCore.js')
const handle = await initEnvLessBridgeCore({
  baseUrl: 'https://isolated.invalid', orgUUID: 'org', title: 'isolated',
  getAccessToken: () => { if (authReadThrows) throw new Error('isolated auth read unavailable'); return token },
  captureAuthIdentity: mode === 'archive-unbound' ? undefined : () => identity,
  prepareOAuth: async () => {
    preparations++
    prepareStarted.resolve()
    if (mode === 'prepare-selection-race') return prepareGate.promise
    if (mode.endsWith('-pending')) return { status: 'persistence_pending', handle: identity }
    if (mode.endsWith('-uncertain')) return { status: 'refresh_uncertain', handle: identity }
    return { status: 'ready', handle: identity, credentials: { accessToken: token, refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 } }
  },
  onAuth401: async (failed, captured) => {
    repairCalls++
    expect(failed).toBe('oauth-a-r0')
    expect(captured).toEqual({ accountId: 'a', generation: 1, revision: 0 })
    if (!mode.startsWith('archive-')) { poisoned = true; throw new Error('JWT expiry must not reject OAuth') }
    if (mode === 'archive-throws') throw new Error('isolated repair unavailable')
    if (mode === 'archive-false') { token = 'oauth-a-r1'; identity = { accountId: 'a', generation: 1, revision: 1 }; return false }
    if (mode === 'archive-pending') return { status: 'persistence_pending' } as never
    if (mode === 'archive-uncertain') return { status: 'refresh_uncertain' } as never
    if (mode === 'archive-successor') { token = 'oauth-a-r1'; identity = { accountId: 'a', generation: 1, revision: 1 } }
    return true
  },
  toSDKMessages: () => [], initialHistoryCap: 0, onStateChange: state => states.push(state),
})
expect(handle).not.toBeNull()

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Isolated remote bridge did not settle')
    await Bun.sleep(1)
  }
}
try {
  if (mode.startsWith('archive-')) {
    const teardown = handle!.teardown()
    await archiveStarted.promise
    if (mode === 'archive-selection') { token = 'oauth-b'; identity = { accountId: 'b', generation: 1, revision: 0 } }
    if (mode === 'archive-login') { token = 'oauth-a-r0'; identity = { accountId: 'a', generation: 2, revision: 0 } }
    archiveGate.resolve({ status: 401, data: {} })
    await teardown
    expect(repairCalls).toBe(mode === 'archive-unbound' ? 0 : 1)
    expect(archives).toEqual(mode === 'archive-successor' ? ['Bearer oauth-a-r0', 'Bearer oauth-a-r1'] : ['Bearer oauth-a-r0'])
    expect(transports[0].closed).toBe(true)
    expect(events.some(event => event.name === 'tengu_bridge_repl_teardown')).toBe(true)
  } else if (mode === 'auth-read-throws') {
    authReadThrows = true
    await handle!.teardown()
    expect(archives).toHaveLength(0)
    expect(transports[0].closed).toBe(true)
    expect(events.some(event => event.name === 'tengu_bridge_repl_teardown')).toBe(true)
  } else if (mode === 'prepare-selection-race') {
    transports[0].onClose(401)
    await prepareStarted.promise
    token = 'oauth-b'; identity = { accountId: 'b', generation: 1, revision: 0 }
    prepareGate.resolve({ status: 'ready', handle: { accountId: 'a', generation: 1, revision: 0 }, credentials: { accessToken: 'oauth-a-r0' } })
    await until(() => states.includes('failed'))
    expect(fetched).toEqual(['oauth-a-r0'])
    expect(repairCalls).toBe(0)
  } else if (mode.startsWith('proactive')) {
    const prepared = await scheduler.getAccessToken()
    if (mode === 'proactive' || mode === 'proactive-selection-after-prepare') {
      expect(prepared).toBe('oauth-a-r0')
      if (mode === 'proactive-selection-after-prepare') {
        token = 'oauth-b'; identity = { accountId: 'b', generation: 1, revision: 0 }
      }
      scheduler.onRefresh('cse-isolated', prepared)
      if (mode === 'proactive') {
        await until(() => transports.length === 2)
        expect(fetched).toEqual(['oauth-a-r0', 'oauth-a-r0'])
      } else {
        expect(fetched).toEqual(['oauth-a-r0'])
      }
    } else {
      expect(prepared).toBeUndefined()
      expect(fetched).toEqual(['oauth-a-r0'])
    }
    expect(preparations).toBe(1)
    expect(repairCalls).toBe(0)
    expect(poisoned).toBe(false)
  } else {
    transports[0].onClose(401)
    if (mode === 'sse') {
      await until(() => transports.length === 2)
      expect(fetched).toEqual(['oauth-a-r0', 'oauth-a-r0'])
    } else {
      await until(() => states.includes('failed'))
      expect(fetched).toEqual(['oauth-a-r0'])
    }
    expect(preparations).toBe(1)
    expect(repairCalls).toBe(0)
    expect(poisoned).toBe(false)
  }
} finally { await handle!.teardown() }
