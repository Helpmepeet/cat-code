import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { runNdjsonWorker } from './ndjsonWorker.js'
import { MAX_DOCUMENT_INPUT_BYTES, MAX_DOCUMENT_OUTPUT_BYTES, parsePreviewDocumentTableResult, type PreviewDocumentTableResult } from '../shared/previewDocument.js'

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
async function executable(command: string): Promise<string> {
  if (isAbsolute(command)) return realpath(command)
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (!folder) continue
    const path = join(folder, command)
    try { await access(path, constants.X_OK); return await realpath(path) } catch { /* Try the next installed runtime. */ }
  }
  throw new Error('Document runtime unavailable')
}
type Pending = { resolve: (value: PreviewDocumentTableResult) => void; timer: ReturnType<typeof setTimeout> }
type WarmWorker = { control: AbortController; send: ((line: string) => void) | null; pending: Pending | null; done: Promise<unknown>; invalid: boolean; expired: boolean }
export function createPreviewDocumentRunner(options: { command: string; args: string[]; cwd: string }) {
  let worker: WarmWorker | null = null
  let operation: AbortController | null = null
  let serial: Promise<unknown> = Promise.resolve()
  let generation = 0
  async function start(control: AbortController): Promise<WarmWorker> {
    const command = await executable(options.command)
    const wrapped = await SandboxManager.wrapWithSandbox(`exec ${[command, ...options.args].map(quote).join(' ')}`, '/bin/sh', {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { allowWrite: [], denyWrite: ['/'], denyRead: [] },
    }, control.signal)
    if (control.signal.aborted) throw new Error('Cancelled')
    const next: WarmWorker = { control, send: null, pending: null, done: Promise.resolve(), invalid: false, expired: false }
    worker = next
    const finish = (reason: 'failed' | 'limit' | 'cancelled') => {
      if (next.pending) { clearTimeout(next.pending.timer); next.pending.resolve({ ok: false, reason }); next.pending = null }
      if (worker === next) worker = null
    }
    next.done = runNdjsonWorker({
      command: '/bin/sh', args: ['-c', `exec ${wrapped}`], cwd: '/', inheritEnv: false,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/var/empty', LANG: 'en_US.UTF-8', TMPDIR: '/tmp', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
      signal: control.signal, forceKillOnAbort: true, maxRssBytes: 512 * 1024 * 1024,
      // Per-request timeouts below kill this warm worker; this is its outer lifetime cap.
      timeoutMs: 24 * 60 * 60 * 1000, escalateKillAfterMs: 250, maxRecordBytes: MAX_DOCUMENT_OUTPUT_BYTES,
      mutationKey: 'preview-document-parser',
      connectInput: send => { next.send = send; return () => { next.send = null } },
      onRecord: line => {
        try {
          const parsed = parsePreviewDocumentTableResult(JSON.parse(line.toString('utf8')))
          if (!next.pending || !parsed) next.invalid = true
          else { clearTimeout(next.pending.timer); next.pending.resolve(parsed); next.pending = null }
        } catch { next.invalid = true }
        return next.invalid ? 'stop' : 'continue'
      },
      onOversizeRecord: () => { next.invalid = true },
    }).then(outcome => {
      finish(next.expired || outcome.memoryExceeded || outcome.timedOut ? 'limit' : outcome.aborted ? 'cancelled' : 'failed')
    }, () => finish(control.signal.aborted ? 'cancelled' : 'failed'))
    return next
  }
  return {
    abort(): Promise<void> {
      generation++; operation?.abort(); worker?.control.abort()
      const pending = serial
      return Promise.resolve(worker?.done).then(() => pending).then(() => {})
    },
    read(input: { format: 'csv' | 'tsv' | 'xlsx'; bytes: Uint8Array; sheet?: string; sourceTruncated?: boolean }, signal?: AbortSignal): Promise<PreviewDocumentTableResult> {
      const ticket = ++generation
      // A newer request replaces a busy parser, while an idle one stays warm.
      if (operation) { operation.abort(); worker?.control.abort() }
      const task = serial.catch(() => {}).then(async (): Promise<PreviewDocumentTableResult> => {
        if (ticket !== generation || signal?.aborted) return { ok: false, reason: 'cancelled' }
        if (input.bytes.byteLength > MAX_DOCUMENT_INPUT_BYTES) return { ok: false, reason: 'limit' }
        if (process.platform !== 'darwin' || SandboxManager.getConfig()) return { ok: false, reason: 'refused' }
        const own = new AbortController()
        operation = own
        const cancel = () => { own.abort(); worker?.control.abort() }
        signal?.addEventListener('abort', cancel, { once: true })
        try {
          if (worker?.control.signal.aborted) await worker.done
          const current = worker ?? await start(new AbortController())
          if (own.signal.aborted || ticket !== generation) { current.control.abort(); await current.done; return { ok: false, reason: 'cancelled' } }
          const result = await new Promise<PreviewDocumentTableResult>(resolve => {
            current.expired = false
            const timer = setTimeout(() => { current.expired = true; current.control.abort() }, 15_000)
            current.pending = { resolve, timer }
            if (!current.send) { clearTimeout(timer); current.pending = null; resolve({ ok: false, reason: 'failed' }); return }
            current.send(`${JSON.stringify({ format: input.format, bytes: Buffer.from(input.bytes).toString('base64'), ...(input.sheet === undefined ? {} : { sheet: input.sheet }), sourceTruncated: input.sourceTruncated === true })}\n`)
          })
          if (own.signal.aborted || ticket !== generation) { current.control.abort(); await current.done; return { ok: false, reason: 'cancelled' } }
          if (!result.ok) { current.control.abort(); await current.done }
          return result
        } catch { worker?.control.abort(); if (worker) await worker.done; return { ok: false, reason: own.signal.aborted ? 'cancelled' : 'failed' } }
        finally { signal?.removeEventListener('abort', cancel); if (operation === own) operation = null }
      })
      serial = task
      return task
    },
  }
}
