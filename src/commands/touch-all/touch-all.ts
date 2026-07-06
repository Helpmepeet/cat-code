import { touchAll } from '../../services/api/codexTokenRefresh.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async () => {
  const results = await touchAll()

  if (results.length === 0) {
    return {
      type: 'text',
      value: 'No vault accounts found.',
    }
  }

  const lines: string[] = ['Token Refresh Results:', '']

  for (const r of results) {
    const id =
      r.accountId.length > 12
        ? `${r.accountId.slice(0, 12)}...`
        : r.accountId
    const statusTag =
      r.status === 'refreshed'
        ? 'OK'
        : r.status === 'locked'
          ? 'LOCKED'
          : r.status === 'skipped'
            ? 'SKIPPED'
            : 'FAILED'
    let line = `  ${id}  [${statusTag}]`
    if (r.detail) line += `  ${r.detail}`
    lines.push(line)
  }

  const refreshed = results.filter((r) => r.status === 'refreshed').length
  const locked = results.filter((r) => r.status === 'locked').length
  const failed = results.filter((r) => r.status === 'failed').length
  const skipped = results.filter((r) => r.status === 'skipped').length

  lines.push('')
  lines.push(
    `Total: ${results.length} (${refreshed} refreshed, ${locked} locked, ${failed} failed, ${skipped} skipped)`,
  )

  return { type: 'text', value: lines.join('\n') }
}
