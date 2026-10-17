// Isolated process fixture. Keep the normal index/controller/QueryEngine path;
// only the optional installation probe is replaced.
import { spyOn } from 'bun:test'
import { appendFileSync } from 'node:fs'
await (await import('./workerRuntime.js')).bootstrapWorkerEngine()
const status = await import('../../src/utils/status.js')
spyOn(status, 'buildInstallationDiagnostics').mockImplementation(() => {
  appendFileSync(process.env.OPTIONAL_PROBE_LOG!, `${process.cwd()}\n`)
  return new Promise(() => {})
})
await import('./index.js')
