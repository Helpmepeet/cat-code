/** Keep renderer imports inside the desktop package's typecheck boundary. */
import { fileURLToPath } from 'node:url'

const child = Bun.spawn([
  process.execPath,
  'run',
  fileURLToPath(new URL('../../app/scripts/resourceWasteRenderer.ts', import.meta.url)),
], {
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exitCode = await child.exited
