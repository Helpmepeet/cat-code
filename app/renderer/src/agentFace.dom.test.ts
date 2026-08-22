/**
 * DOM proof for the SESSION registry's lifetime — the one thing a
 * `renderToStaticMarkup` suite cannot reach, because it mounts a fresh tree per
 * call and the whole property here is what survives a RE-render.
 *
 * The registry moved from the transcript pane to the shell so the docked
 * surfaces draw the same faces, which made its lifetime everyone's problem: a
 * registry re-minted at the wrong moment re-rolls every deduped worker's
 * silhouette, on every surface at once.
 *
 * No JSX here on purpose: keeping the file `.ts` keeps it outside the
 * `lint:fast-refresh` component-boundary rule that governs `renderer/src/**.tsx`.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import {
  useAgentFaceRegistryStore,
  useSessionAgentFaceRegistry,
  type AgentFaceRegistry,
  type AgentFaceRegistryStore,
} from './agentFace.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

const seen: AgentFaceRegistry[] = []

function Probe({ sessionId }: { sessionId: string | null }) {
  seen.push(useSessionAgentFaceRegistry(sessionId))
  return null
}

test('one session keeps one registry across re-renders, and a transient null does not reset it', async () => {
  seen.length = 0
  const tree = await harness.mount(createElement(Probe, { sessionId: 'session-a' }))
  await tree.render(createElement(Probe, { sessionId: 'session-a' }))
  // The gap a restore opens: the shell has no active session for a beat, and the
  // transcript's own `rows` empty. Rebuilding here would hand every worker a new
  // silhouette the moment their session came back.
  await tree.render(createElement(Probe, { sessionId: null }))
  await tree.render(createElement(Probe, { sessionId: 'session-a' }))

  expect(seen.length).toBe(4)
  expect(new Set(seen).size).toBe(1)
})

test('a different session gets a different registry', async () => {
  seen.length = 0
  const tree = await harness.mount(createElement(Probe, { sessionId: 'session-a' }))
  await tree.render(createElement(Probe, { sessionId: 'session-b' }))

  // Dedupe is a property of ONE session's set of workers. Carrying it across a
  // switch would make a face depend on what the previous transcript rendered.
  expect(new Set(seen).size).toBe(2)
})

test('the same session hands every caller the same faces', async () => {
  seen.length = 0
  await harness.mount(createElement(Probe, { sessionId: 'session-a' }))
  const registry = seen[0]

  const first = registry.faceFor('agent-1', 'Ada')
  const again = registry.faceFor('agent-1', 'Ada')

  expect(again).toEqual(first)
  expect(registry.faceFor('agent-2', 'Grace').fill).not.toBe(first.fill)
})

/* ── the shell's per-session store (2026-08-22) ─────────────────────────────── */

const stores: AgentFaceRegistryStore[] = []
const paneRegistries: AgentFaceRegistry[] = []

/** The shell, re-rendering as another pane takes focus. */
function ShellProbe({ activeSessionId }: { activeSessionId: string | null }) {
  const store = useAgentFaceRegistryStore()
  stores.push(store)
  // Both panes of a split view ask on every one of the shell's renders.
  paneRegistries.push(store.registryFor('session-a'))
  paneRegistries.push(store.registryFor('session-b'))
  store.registryFor(activeSessionId)
  return null
}

test('focusing another pane re-mints nothing the panes are already drawing into', async () => {
  // The defect: the shell held ONE registry minted from the active session, so
  // moving focus between panes handed every still-mounted pane a fresh empty
  // pool and re-rolled faces on rows that were already settled. A registry is
  // now per session, so the only thing a focus change moves is which session the
  // SHELL's own furniture reads.
  stores.length = 0
  paneRegistries.length = 0
  const tree = await harness.mount(
    createElement(ShellProbe, { activeSessionId: 'session-a' }),
  )
  await tree.render(createElement(ShellProbe, { activeSessionId: 'session-b' }))
  await tree.render(createElement(ShellProbe, { activeSessionId: null }))
  await tree.render(createElement(ShellProbe, { activeSessionId: 'session-a' }))

  expect(stores.length).toBe(4)
  expect(new Set(stores).size).toBe(1)
  // Two sessions, two registries, and neither moved across the four renders.
  expect(new Set(paneRegistries).size).toBe(2)
})
