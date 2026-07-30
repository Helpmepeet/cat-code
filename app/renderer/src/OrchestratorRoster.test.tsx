/**
 * P4-32a — the docked worker roster (ruling R1). Renders every prototype UX state
 * over the REAL `AgentModeWorkerItem` shape; the two-axis invariant (D2 C2) is
 * asserted at the surface, not only in the selector, so a regression that colours
 * an orchestrator-owned worker amber fails here.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrchestratorRoster } from './OrchestratorRoster.js'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'

/** The two baton faces, matched on rendered text so a tone swap cannot hide. */
const BATON_ORCHESTRATOR = '→</span>orchestrator'
const BATON_YOU = '→</span>you'

function worker(over: Partial<AgentModeWorkerItem> = {}): AgentModeWorkerItem {
  return {
    agentId: 'w-1',
    handle: 'Turing',
    role: 'agent-mode-coding-worker',
    status: 'running',
    description: 'Port the roster',
    ...over,
  }
}

test('no workers renders nothing (the roster never occupies the composer dock idly)', () => {
  expect(
    renderToStaticMarkup(<OrchestratorRoster active workers={[]} />),
  ).toBe('')
})

test('one worker renders the named row: handle, delegated task, lifecycle', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster active workers={[worker()]} />,
  )
  expect(html).toContain('Turing')
  expect(html).toContain('Port the roster')
  expect(html).toContain('Running')
  // A running worker needs nobody, so no baton is drawn at all.
  expect(html).not.toContain(BATON_ORCHESTRATOR)
  expect(html).not.toContain(BATON_YOU)
})

test('several quiet workers render the resting line: counts, no privileged name', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster
      active
      workers={[
        worker({ agentId: 'w-1' }),
        worker({ agentId: 'w-2', handle: 'Hopper' }),
        worker({
          agentId: 'w-3',
          handle: 'Bell',
          status: 'completed',
          synthesisStatus: 'synthesized',
        }),
      ]}
    />,
  )
  expect(html).toContain('3 subagents')
  expect(html).toContain('2 working')
  expect(html).toContain('1 done')
  expect(html).toContain('animate-pulse')
  // The hover/focus roster is always in the DOM, so every handle is present.
  expect(html).toContain('3 SUBAGENTS')
  expect(html).toContain('Hopper')
})

test('a swarm with news promotes one worker and keeps the rest as neutral counts', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster
      active
      workers={[
        worker({ agentId: 'w-run' }),
        worker({ agentId: 'w-fail', handle: 'Hopper', status: 'failed' }),
      ]}
    />,
  )
  expect(html).toContain('Hopper')
  expect(html).toContain('Attention')
  expect(html).toContain('1 working')
  // A failure awaits the ORCHESTRATOR, so the baton is the neutral one even though
  // the lifecycle word itself is an amber "Attention" (two independent axes).
  expect(html).toContain(BATON_ORCHESTRATOR)
  expect(html).not.toContain(BATON_YOU)
})

test('a blocked worker stays neutral under an active orchestrator and escalates only when solo', () => {
  const blocked = [worker({ status: 'completed', handoffStatus: 'blocked' })]

  const withOrchestrator = renderToStaticMarkup(
    <OrchestratorRoster active workers={blocked} />,
  )
  expect(withOrchestrator).toContain('Waiting on orchestrator')
  expect(withOrchestrator).toContain(BATON_ORCHESTRATOR)
  expect(withOrchestrator).not.toContain(BATON_YOU)
  expect(withOrchestrator).not.toContain('text-tone-warn')

  const solo = renderToStaticMarkup(
    <OrchestratorRoster active={false} workers={blocked} />,
  )
  expect(solo).toContain('Needs you')
  expect(solo).toContain(BATON_YOU)
  expect(solo).not.toContain(BATON_ORCHESTRATOR)
})

test('the compact state dims the resting header only (the counts stay legible)', () => {
  const workers = [worker({ agentId: 'w-1' }), worker({ agentId: 'w-2' })]
  const resting = renderToStaticMarkup(
    <OrchestratorRoster active workers={workers} />,
  )
  const compact = renderToStaticMarkup(
    <OrchestratorRoster active compact workers={workers} />,
  )
  expect(resting).toContain('text-text-subtle">2 subagents')
  expect(compact).toContain('text-text-faint">2 subagents')
  expect(compact).toContain('2 working')
})

test('a handle-less worker degrades to a generic name rather than an empty row', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster active workers={[worker({ handle: null, description: null })]} />,
  )
  expect(html).toContain('subagent')
})

test('the mention sigil is stripped from a handle for display', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster active workers={[worker({ handle: '@Turing' })]} />,
  )
  expect(html).toContain('>Turing<')
  expect(html).not.toContain('@Turing')
})
