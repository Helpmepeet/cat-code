import { expect, test } from 'bun:test'
import { ownedSidecarCandidatesFromRegistry } from './reap-orphan-sidecars.js'

test('orphan reaper candidates come only from live registry rows with both identity hints', () => {
  const candidates = ownedSidecarCandidatesFromRegistry(
    JSON.stringify({
      registryVersion: 1,
      sessions: [
        { shutdown: null, enginePid: 501, socketPath: '/tmp/owned.sock' },
        // A terminal row may retain advisory values, but it is history, not kill authority.
        { shutdown: 'clean', enginePid: 502, socketPath: '/tmp/terminal.sock' },
        { shutdown: null, enginePid: 503 },
        { shutdown: null, socketPath: '/tmp/no-pid.sock' },
      ],
    }),
  )

  expect(candidates).toEqual([{ pid: 501, socketPath: '/tmp/owned.sock' }])
})

test('orphan reaper fails closed for malformed or unknown registry documents', () => {
  expect(ownedSidecarCandidatesFromRegistry('{not json')).toEqual([])
  expect(
    ownedSidecarCandidatesFromRegistry(
      JSON.stringify({ registryVersion: 999, sessions: [] }),
    ),
  ).toEqual([])
})
