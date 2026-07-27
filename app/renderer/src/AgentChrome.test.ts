import { expect, test } from 'bun:test'
import {
  AGENT_STATE_TONE_CLASS,
  AGENT_TYPE_TONE_CLASS,
} from './agentChromeModel.js'
import { AGENT_STATE_META, AGENT_TYPE_META } from './agentIdentity.js'

// Tailwind v4 only emits class literals it can statically see — a dynamic
// `text-[${hex}]` never generates (the P4-9 colourless-badge bug). Assert every
// class in the tone maps is a STATIC utility with no interpolation / arbitrary
// value, so the orchestrator dots/chips actually render coloured.
function assertStaticClasses(classes: string[]) {
  for (const className of classes) {
    for (const token of className.split(/\s+/)) {
      if (token.length === 0) continue
      expect(token).not.toContain('${')
      expect(token).not.toContain('[#')
      expect(token).not.toContain('[$')
    }
  }
}

test('every state-tone class is a static Tailwind utility (no arbitrary/interpolated values)', () => {
  const classes = Object.values(AGENT_STATE_TONE_CLASS).flatMap(tone => [
    tone.text,
    tone.dot,
    tone.border,
    tone.soft,
    tone.line,
  ])
  assertStaticClasses(classes)
})

test('every type-tone class is a static Tailwind utility', () => {
  const classes = Object.values(AGENT_TYPE_TONE_CLASS).flatMap(tone => [
    tone.text,
    tone.soft,
    tone.line,
    tone.dot,
  ])
  assertStaticClasses(classes)
})

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
