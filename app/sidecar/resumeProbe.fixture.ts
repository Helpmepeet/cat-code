/**
 * Test fixture — drives the sidecar's REAL resume machinery
 * (`resumeEngineSession`) in its own Bun process and prints the engine-returned
 * result as JSON. Used by the P3-1 resume probe to assert that the resumed
 * session's state actually contains the prior messages, read from the engine's
 * deserialized `Message[]` — NOT by re-reading the JSONL.
 *
 * Run (the probe spawns it rooted in the session cwd + the fixture's config home,
 * matching how a real sidecar would resume):
 *
 *   CLAUDE_CONFIG_DIR=… bun run app/sidecar/resumeProbe.fixture.ts <engineSessionId> <marker>
 *
 * Prints one JSON line `RESUME_RESULT={…}` on stdout and exits 0 on success; a
 * failed resume throws and exits non-zero (loud, never a silent empty result).
 */

import { init } from '../../src/entrypoints/init.js'
import { resumeEngineSession } from './sessionResume.js'

async function main(): Promise<void> {
  const engineSessionId = process.argv[2]
  const marker = process.argv[3] ?? ''
  if (!engineSessionId) {
    throw new Error('usage: resumeProbe.fixture.ts <engineSessionId> [marker]')
  }

  await init()
  const result = await resumeEngineSession(engineSessionId, process.cwd())

  const payload = {
    engineSessionId: result.engineSessionId,
    count: result.messages.length,
    hasMarker: JSON.stringify(result.messages).includes(marker),
  }
  process.stdout.write(`RESUME_RESULT=${JSON.stringify(payload)}\n`)
  // Flush stdout before exit so the parent reliably reads the line.
  await new Promise<void>(resolve => {
    if (process.stdout.write('')) resolve()
    else process.stdout.once('drain', () => resolve())
  })
  process.exit(0)
}

void main().catch(error => {
  process.stderr.write(
    `resume-probe failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
