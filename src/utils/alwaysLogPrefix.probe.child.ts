/**
 * Child for alwaysLogPrefix.probe.test.ts. Runs OUTSIDE bun test so
 * NODE_ENV is unset: shouldLogDebugMessage short-circuits under
 * NODE_ENV==='test', which is why the always-log routing cannot be
 * exercised in-process by any suite in this repo.
 */
import { flushDebugLogs, logForDebugging, RECOVERED_TERMINAL_TEXT_PREFIX } from './debug.js'

logForDebugging(`${RECOVERED_TERMINAL_TEXT_PREFIX} source=probe part=0:0 chars=7`, {
  level: 'warn',
})
logForDebugging('[codex-fetch] an ordinary gated line', { level: 'warn' })
await flushDebugLogs()
