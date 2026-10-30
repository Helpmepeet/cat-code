import type { HostResult } from '../shared/hostApi.js'

export type SessionCloseDependencies = {
  authorize: (id: string) => Promise<HostResult<void>>
  blocked: (id: string) => boolean
  cancel: (id: string) => Promise<void>
  observe: (id: string) => void
  close: (id: string) => Promise<HostResult<void>>
  onFailure?: (id: string, error: unknown) => void
  timeoutMs?: number
  retryMs?: number
}

/** Cancellation never grants permission to kill across an unsettled filesystem move. */
export class SessionCloseCoordinator {
  private readonly pending = new Map<string, Promise<HostResult<void>>>()
  constructor(private readonly deps: SessionCloseDependencies) {}

  isPending(id: string): boolean { return this.pending.has(id) }

  close(id: string): Promise<HostResult<void>> {
    const existing = this.pending.get(id)
    if (existing) return existing
    if (this.pending.size >= 128) return Promise.resolve({
      ok: false, error: { code: 'session_unreachable', message: 'Too many stop requests are pending. Retry shortly.' },
    })
    const operation = this.run(id)
    this.pending.set(id, operation)
    void operation.finally(() => {
      if (this.pending.get(id) === operation) this.pending.delete(id)
    })
    return operation
  }

  private async run(id: string): Promise<HostResult<void>> {
    const deadline = Date.now() + (this.deps.timeoutMs ?? 10_000)
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<HostResult<void>>(resolve => {
      timer = setTimeout(() => {
        expired = true
        resolve({ ok: false, error: { code: 'session_unreachable', message: 'Stop is not confirmed. Open the chat to review it or retry stop.' } })
      }, this.deps.timeoutMs ?? 10_000)
    })
    const cleanup = (async (): Promise<HostResult<void>> => {
      try {
        const authorized = await this.deps.authorize(id)
        if (!authorized.ok || expired) return authorized
        await this.deps.cancel(id)
        while (!expired && this.deps.blocked(id)) {
          const currentOwner = await this.deps.authorize(id)
          if (!currentOwner.ok) return currentOwner
          if (expired) break
          await this.deps.cancel(id)
          this.deps.observe(id)
          await new Promise(resolve => setTimeout(resolve, Math.min(this.deps.retryMs ?? 100, Math.max(0, deadline - Date.now()))))
        }
        if (expired) return { ok: false, error: { code: 'session_unreachable', message: 'Stop is not confirmed. Retry stop.' } }
        return await this.deps.close(id)
      } catch (error) {
        this.deps.onFailure?.(id, error)
        return { ok: false, error: { code: 'session_unreachable', message: 'Stop failed. Open the chat to review it or retry stop.' } }
      }
    })()
    try {
      return await Promise.race([cleanup, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
