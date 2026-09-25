import { expect, test } from 'bun:test'
import {
  AGENT_STATE_TONE_CLASS,
  AGENT_TYPE_TONE_CLASS,
} from './agentChromeModel.js'
import { AGENT_STATE_META, AGENT_TYPE_META } from './agentIdentity.js'

test('the tone maps cover every tone the shared vocabulary can produce', () => {
  // A new AGENT_STATE_META / AGENT_TYPE_META tone with no class entry would render
  // colourless — fail loudly here rather than silently at runtime.
  const stateTones = new Set(Object.values(AGENT_STATE_META).map(meta => meta.tone))
  for (const tone of stateTones) {
    expect(AGENT_STATE_TONE_CLASS[tone]).toBeDefined()
  }
  const typeTones = new Set(Object.values(AGENT_TYPE_META).map(meta => meta.tone))
  for (const tone of typeTones) {
    expect(AGENT_TYPE_TONE_CLASS[tone]).toBeDefined()
  }
})
