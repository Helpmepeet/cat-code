/** Synthetic engine process for the shared-usage tests; never real auth. */
import type { PoolAccount } from './codexAccountPool.js'

const endpoint = process.env.CATCODE_USAGE_PROBE_URL
if (!endpoint || new URL(endpoint).hostname !== '127.0.0.1' || !process.env.CLAUDE_CONFIG_DIR) {
  throw new Error('usage probe requires a temporary home and loopback endpoint')
}
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'test', BUILD_TIME: 'test' }
const realFetch = globalThis.fetch
globalThis.fetch = ((url, options) => {
  if (url !== 'https://chatgpt.com/backend-api/wham/usage') {
    throw new Error('usage probe blocked unexpected outbound request')
  }
  const authorization = new Headers(options?.headers).get('Authorization')
  if (!authorization?.startsWith('Bearer synthetic-')) throw new Error('probe requires synthetic credentials')
  return realFetch(endpoint, options)
}) as typeof fetch

const { fetchPoolUsage, invalidateUsageCache } = await import('./codexUsage.js')
const { seedCodexAccountPoolForTest, getPoolStatus } = await import('./codexAccountPool.js')

type Command = {
  id: number
  action: 'seed' | 'fetch' | 'invalidate'
  accounts?: PoolAccount[]
  forceRefresh?: boolean
}

process.on('message', (command: Command) => {
  void (async () => {
    try {
      if (command.action === 'seed') {
        seedCodexAccountPoolForTest({ accounts: command.accounts ?? [], activeAccountId: command.accounts?.[0]?.accountId })
        process.send?.({ id: command.id, ok: true })
      } else if (command.action === 'invalidate') {
        invalidateUsageCache()
        process.send?.({ id: command.id, ok: true })
      } else {
        const snapshot = await fetchPoolUsage({ forceRefresh: command.forceRefresh, updateRoutingHints: true })
        process.send?.({ id: command.id, snapshot, hints: getPoolStatus().accounts.map(account => account.usagePrimary ?? null) })
      }
    } catch (error) {
      process.send?.({ id: command.id, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})
process.send?.({ ready: true })
