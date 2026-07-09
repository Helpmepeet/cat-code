/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import type { CodexStatusRefreshMode } from '../../services/api/codexStatus.js'

/**
 * `cat-code codex status` — emit ONE read-only, advisory JSON observation of the
 * Codex credential pool, then exit. Exit 0 for every valid observation
 * (including "all capped" and "no account"); nonzero only on internal failure.
 */
export async function codexStatus(opts: {
  json?: boolean
  refresh?: string
}): Promise<void> {
  const refresh: CodexStatusRefreshMode = opts.refresh === 'never' ? 'never' : 'auto'
  try {
    const { buildCodexStatus } = await import('../../services/api/codexStatus.js')
    const observation = await buildCodexStatus({ refresh })
    process.stdout.write(JSON.stringify(observation, null, 2) + '\n')
    process.exit(0)
  } catch (err) {
    const { buildCodexStatusError } = await import('../../services/api/codexStatus.js')
    process.stdout.write(JSON.stringify(buildCodexStatusError(err), null, 2) + '\n')
    process.exit(1)
  }
}
