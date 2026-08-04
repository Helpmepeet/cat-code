import { expect, test } from 'bun:test'
import { OrchestratorBadge } from './AgentChrome.js'
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

test('the Orchestrator switch negates the mode and never re-selects its host row', () => {
  // No DOM click harness in this package (the OrchestratorReflect convention): call
  // the hook-free component and read its onClick off the returned element, which is
  // the exact code path a real click runs. The stopPropagation assertion matters:
  // the host row is itself clickable, so without it toggling would also select it.
  const calls: boolean[] = []
  let stopped = 0
  const event = { stopPropagation: () => { stopped += 1 } }

  const off = OrchestratorBadge({ active: false, onToggle: next => calls.push(next) })
  expect(off).not.toBeNull()
  off?.props.onClick(event)
  expect(calls).toEqual([true])
  expect(stopped).toBe(1)

  const on = OrchestratorBadge({ active: true, onToggle: next => calls.push(next) })
  on?.props.onClick(event)
  expect(calls).toEqual([true, false])
  expect(stopped).toBe(2)
})

test('a session out of the mode with no callback renders nothing', () => {
  // Otherwise an ordinary row would carry dead orchestrator chrome.
  expect(OrchestratorBadge({ active: false })).toBeNull()
  expect(OrchestratorBadge({ active: true })).not.toBeNull()
})
