import { appendFileSync } from 'node:fs'

// Safety preload for cold engine probes. A network attempt fails the process,
// rather than turning a live request into evidence about isolated recovery.
function denyProbeNetwork(): never {
  const message = new Error('Isolated recovery probe blocked a network request').stack ?? 'Blocked network request'
  const audit = process.env.CATCODE_PROBE_NETWORK_AUDIT
  if (audit) appendFileSync(audit, `${message}\n`)
  process.stderr.write(`${message}\n`)
  process.exit(91)
}
globalThis.fetch = Object.assign(async () => denyProbeNetwork(), { preconnect: denyProbeNetwork })
