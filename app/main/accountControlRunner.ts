import type { AccountControlVerb, AccountControlEvent } from '../shared/accountControlWorker.js'
import { MAX_ACCOUNT_CONTROL_RECORD_BYTES, parseAccountControlEvent, parseAccountControlVerb } from '../shared/accountControlWorker.js'
import { PROTOCOL_VERSION, type AccountResultFrame } from '../shared/protocol.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { runNdjsonWorker, type NdjsonWorkerOptions } from './ndjsonWorker.js'

type ProgressEvent = Extract<AccountControlEvent, { type: 'progress' }>
type LaunchOptions = Pick<NdjsonWorkerOptions, 'command' | 'args' | 'cwd' | 'env' | 'spawnWorker' | 'onWorkerLifecycle' | 'log'>

/** One lazy engine worker for account management, independent of the chat fleet. */
export function createAccountControlRunner(options: {
  launch: () => LaunchOptions
  onProgress: (event: ProgressEvent) => void
  onPoolChanged: () => void
}) {
  let task: Promise<void> | null = null
  let send: ((input: string) => void) | null = null
  let abort: AbortController | null = null
  let disposed = false
  let retirement: Promise<void> | null = null
  let releaseRetirement: (() => void) | null = null
  let latest: ProgressEvent | null = null
  let loginActive = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const spawnTimes: number[] = []
  const pending = new Map<string, { verb: AccountControlVerb; resolve: (frame: AccountResultFrame) => void; reject: (error: Error) => void }>()
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }
  const finishRetirement = () => {
    const release = releaseRetirement
    retirement = null
    releaseRetirement = null
    release?.()
  }
  const idle = () => {
    clearIdle()
    if (pending.size || loginActive || !task) return
    idleTimer = setTimeout(() => { send = null; abort?.abort() }, 30_000)
    idleTimer.unref?.()
  }
  const progress = (event: ProgressEvent) => {
    latest = event
    loginActive = event.progress !== null && !['success', 'error'].includes(event.progress.state)
    options.onProgress(event)
    if (event.progress?.state === 'success') options.onPoolChanged()
    idle()
  }

  async function start(): Promise<void> {
    if (retirement) await retirement
    if (send) return
    if (task) await task
    if (send) return
    if (disposed) throw new Error('account control disposed')
    const now = Date.now()
    while (spawnTimes.length && spawnTimes[0]! < now - 10_000) spawnTimes.shift()
    if (spawnTimes.length >= 8) throw new Error('account control spawn limit')
    spawnTimes.push(now)
    const controller = new AbortController()
    abort = controller
    let protocolError = false
    task = runNdjsonWorker({
      ...options.launch(), simpleMode: false, signal: controller.signal,
      timeoutMs: 30 * 60_000, forceKillOnAbort: true, escalateKillAfterMs: 2_000,
      maxRecordBytes: MAX_ACCOUNT_CONTROL_RECORD_BYTES,
      connectInput: writer => { send = writer; return () => { send = null } },
      onOversizeRecord: () => { protocolError = true },
      onRecord: line => {
        let raw: unknown
        try { raw = JSON.parse(line.toString('utf8')) } catch { protocolError = true; return 'stop' }
        const event = parseAccountControlEvent(raw)
        if (!event || !scanForSecrets(event).ok) { protocolError = true; return 'stop' }
        if (event.type === 'progress') { progress(event); return 'continue' }
        const request = pending.get(event.requestId)
        if (!request || request.verb.type !== event.verb) { protocolError = true; return 'stop' }
        pending.delete(event.requestId)
        request.resolve({ kind: 'account.result', protocolVersion: PROTOCOL_VERSION, sessionId: '', requestId: event.requestId, verb: event.verb, ok: event.ok, message: event.message, ...(event.touchAllResults ? { touchAllResults: event.touchAllResults } : {}) })
        if (event.ok && event.changed) options.onPoolChanged()
        idle()
        // The Codex flow can keep its callback listener alive after a cancel.
        // Reap this owner before the next login tries to bind the same port.
        if (event.verb === 'account.oauthCancel') {
          if (event.ok) {
            clearIdle()
            send = null
            controller.abort()
          } else {
            finishRetirement()
          }
        }
        return 'continue'
      },
    }).then(() => undefined).catch(() => undefined).finally(() => {
      clearIdle()
      send = null
      task = null
      abort = null
      for (const request of pending.values()) request.reject(new Error('account worker stopped'))
      pending.clear()
      finishRetirement()
      if (loginActive && !disposed) progress({ type: 'progress', version: 1, provider: latest?.provider ?? 'openai', progress: { state: 'error', message: 'Sign-in stopped. Try again.' } })
      if (protocolError) options.launch().log?.('[account-control] worker output rejected')
    })
  }

  return {
    async run(raw: unknown): Promise<AccountResultFrame> {
      const verb = parseAccountControlVerb(raw)
      if (!verb || disposed || pending.size >= 16 || pending.has(verb.requestId)) throw new Error('account control request rejected')
      clearIdle()
      do {
        await start()
        // A cancellation may have been admitted while start() yielded.
      } while (retirement)
      // Concurrent callers may have awaited the same retiring worker.
      if (pending.size >= 16 || pending.has(verb.requestId) || !send) throw new Error('account control busy')
      return new Promise<AccountResultFrame>((resolve, reject) => {
        if (verb.type === 'account.oauthCancel') {
          retirement = new Promise<void>(release => { releaseRetirement = release })
        }
        pending.set(verb.requestId, { verb, resolve, reject })
        send!(`${JSON.stringify(verb)}\n`)
      })
    },
    // Success is a presentation beat, not an active attempt on renderer reload.
    replay: () => latest?.progress?.state === 'success' ? null : latest,
    dispose() { disposed = true; clearIdle(); send = null; abort?.abort(); return task ?? Promise.resolve() },
  }
}
