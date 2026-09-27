import { expect, test } from 'bun:test'
import { parseSettingsInventoryWorkerResult } from './settingsInventoryWorker.js'

test('inventory boundary rejects undeclared credential fields inside nested MCP entries', () => {
  const record = {
    type: 'inventory',
    version: 1,
    cwd: '/project',
    extensions: {
      mcp: [{ name: 'server', transport: 'stdio', scope: 'project', command: 'server', argCount: 0 }],
      plugins: [],
      skills: [],
      hooks: [],
    },
    agents: { definitions: [], failedFiles: [], availableMcpServers: [] },
    settings: null,
    memory: null,
  }
  expect(parseSettingsInventoryWorkerResult(record)).not.toBeNull()
  expect(parseSettingsInventoryWorkerResult({
    ...record,
    extensions: {
      ...record.extensions,
      mcp: [{ ...record.extensions.mcp[0], env: { API_KEY: 'secret' } }],
    },
  })).toBeNull()
})
