import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { switchSession } from '../../src/bootstrap/state.js'
import { asSessionId } from '../../src/types/ids.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { createSidecarAgentModeDomain } from './agentModeDomain.js'

const [projectDir, sessionA, sessionB] = process.argv.slice(2)

if (!projectDir || !sessionA || !sessionB) {
  throw new Error('expected project directory and two session ids')
}

const store = createStore({ ...getDefaultAppState(), tasks: {} })
const domain = createSidecarAgentModeDomain(store)

await writeFile(
  join(projectDir, `${sessionA}.agent-mode-state.json`),
  JSON.stringify({
    sessionId: sessionA,
    mode: 'agent',
    objective: 'Session A objective',
    activeWorkers: {
      Turing: { role: 'Explore', agentId: 'worker-a' },
    },
    knownWorkers: {
      'worker-a': {
        agentId: 'worker-a',
        handle: 'Turing',
        role: 'Explore',
        description: 'Inspect session A',
        status: 'completed',
        resumable: true,
        worktreePath: null,
      },
    },
  }),
)

switchSession(asSessionId(sessionA), projectDir)
const a = await domain.getSnapshot()

switchSession(asSessionId(sessionB), projectDir)
const b = await domain.getSnapshot()

console.log(JSON.stringify({ a, b }))
