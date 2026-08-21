import { expect, test } from 'bun:test'
import { AGENT_FACE_IDENTITY_FILL } from './agentChromeModel.js'
import { FACE_FILL_COUNT } from './agentFace.js'

test('the identity palette is exactly as long as the registry believes', () => {
  // `agentFace.ts` dedupes colours against a count it cannot import without a
  // cycle. A palette that grew here and not there would hand out an index with
  // no class behind it.
  expect(AGENT_FACE_IDENTITY_FILL).toHaveLength(FACE_FILL_COUNT)
})
