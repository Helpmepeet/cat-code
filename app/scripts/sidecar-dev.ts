import { fileURLToPath } from 'node:url'
import { resolveSidecarLaunch } from '../main/mainDecisions.js'

const launch = resolveSidecarLaunch({
  packaged: false,
  mainDir: fileURLToPath(new URL('../main', import.meta.url)),
  bunBin: process.execPath,
})
const sidecar = Bun.spawn([launch.command, ...launch.argsFor('session', process.argv.slice(2))], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
})
process.on('SIGINT', () => sidecar.kill('SIGINT'))
process.on('SIGTERM', () => sidecar.kill('SIGTERM'))
process.exitCode = await sidecar.exited
