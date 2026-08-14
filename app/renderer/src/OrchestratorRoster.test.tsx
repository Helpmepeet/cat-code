/**
 * P4-32a — the docked worker roster (ruling R1). Renders every prototype UX state
 * over the REAL `AgentModeWorkerItem` shape; the two-axis invariant (D2 C2) is
 * asserted at the surface, not only in the selector, so a regression that colours
 * an assistant-owned worker amber, or points its baton at the user, fails here.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrchestratorRoster } from './OrchestratorRoster.js'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'

/** The baton's rendered text, matched literally so a tone swap cannot hide. */
const BATON_ASSISTANT = '→</span>assistant'

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
    renderToStaticMarkup(<OrchestratorRoster workers={[]} />),
  ).toBe('')
})

test('one worker renders the named row: handle, task, normalized type, and lifecycle pip', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster workers={[worker()]} />,
  )
  expect(html).toContain('Turing')
  expect(html).toContain('Port the roster')
  expect(html).toContain('Coding worker')
  expect(html).toContain('status Running')
  expect(html).not.toContain('>Running<')
  // One leading role dot + one trailing lifecycle pip. The type is text only,
  // so the reviewed double-ring regression cannot return.
  expect(html.match(/rounded-full/g)).toHaveLength(2)
  expect(html).not.toContain('border-[1.4px]')
  expect(html.indexOf('h-1.5 w-1.5')).toBeLessThan(html.indexOf('>Turing<'))
  expect(html.indexOf('h-2 w-2')).toBeGreaterThan(html.indexOf('>Port the roster<'))
  expect(html.indexOf('>Coding worker<')).toBeGreaterThan(html.indexOf('h-2 w-2'))
  // A running worker needs nobody, so no baton is drawn at all.
  expect(html).not.toContain(BATON_ASSISTANT)
})

test('several quiet workers render the resting line: counts, no privileged name', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster
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
      workers={[
        worker({ agentId: 'w-run' }),
        worker({ agentId: 'w-fail', handle: 'Hopper', status: 'failed' }),
      ]}
    />,
  )
  expect(html).toContain('Hopper')
  expect(html).toContain('status Failed')
  expect(html).not.toContain('>Attention<')
  expect(html).toContain('1 working')
  // A failure awaits the ASSISTANT, so the baton is the neutral one while the
  // lifecycle remains available through the pip and accessible status text.
  expect(html).toContain(BATON_ASSISTANT)
})

test('an unnamed promoted worker leads with its task description and keeps count context accessible', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster
      workers={[
        worker({ agentId: 'w-run', handle: null, role: 'general-purpose' }),
        worker({
          agentId: 'w-fail',
          handle: 'w-fail',
          role: 'general-purpose',
          status: 'failed',
          description: 'Investigate the failing handoff',
        }),
      ]}
    />,
  )
  expect(html).toContain('Investigate the failing handoff')
  expect(html).toContain('General-purpose')
  expect(html).toContain('aria-label="Investigate the failing handoff, type General-purpose, status Failed, 1 working"')
  expect(html).not.toContain('>Attention<')
})

test('a blocked worker is neutral and hands the baton to the assistant, never to you', () => {
  const blocked = [worker({ status: 'completed', handoffStatus: 'blocked' })]

  const html = renderToStaticMarkup(<OrchestratorRoster workers={blocked} />)
  expect(html).toContain('status Waiting on the assistant')
  expect(html).not.toContain('>Waiting on the assistant<')
  expect(html).toContain(BATON_ASSISTANT)
  // The amber escalation is gone: the handoff is already queued to the parent
  // conversation, so nothing here is owed to the user.
  expect(html).not.toContain('Needs you')
  expect(html).not.toContain('>you<')
  expect(html).not.toContain('text-tone-warn')
})

test('the compact state dims the resting header only (the counts stay legible)', () => {
  const workers = [worker({ agentId: 'w-1' }), worker({ agentId: 'w-2' })]
  const resting = renderToStaticMarkup(
    <OrchestratorRoster workers={workers} />,
  )
  const compact = renderToStaticMarkup(
    <OrchestratorRoster compact workers={workers} />,
  )
  expect(resting).toContain('text-text-subtle">2 subagents')
  expect(compact).toContain('text-text-faint">2 subagents')
  expect(compact).toContain('2 working')
})

test('an unnamed worker omits its name and puts the normalized type on the right', () => {
  // `handle` is null whenever the Agent tool ran unnamed (the common case). The row
  // must not print a word the engine never supplied, and must not dress a role up
  // in the `@handle` styling.
  const html = renderToStaticMarkup(
    <OrchestratorRoster
      workers={[worker({ handle: null, role: 'Explore', description: null })]}
    />,
  )
  expect(html).toContain('Explore')
  expect(html).not.toContain('>Unnamed worker<')
  expect(html).not.toContain('text-purple-200')
})

test('a worker with neither handle nor role still renders an honest row', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster
      workers={[worker({ handle: null, role: null, description: 'Do the thing' })]}
    />,
  )
  // No name at all is correct: the task text and lifecycle carry the row.
  expect(html).toContain('Do the thing')
  expect(html).toContain('status Running')
  expect(html).not.toContain('>Running<')
})

test('a legacy handle equal to the worker id never leaks through the roster', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster
      workers={[worker({ agentId: 'internal-agent-id', handle: 'internal-agent-id' })]}
    />
  )
  expect(html).not.toContain('internal-agent-id')
  expect(html).toContain('Port the roster')
  expect(html).toContain('Coding worker')
})

test('compact rows hide Resumable as a word while retaining it in accessible status text', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster
      workers={[
        worker({
          agentId: 'legacy-resumable-id',
          handle: 'legacy-resumable-id',
          role: 'general-purpose',
          status: 'completed',
          origin: 'prior',
          resumable: true,
          description: 'Resume the investigation',
        }),
      ]}
    />,
  )
  expect(html).toContain('General-purpose')
  expect(html).toContain('status Resumable')
  expect(html).not.toContain('>Resumable<')
  expect(html).not.toContain('legacy-resumable-id')
})

test('the mention sigil is stripped from a handle for display', () => {
  const html = renderToStaticMarkup(
    <OrchestratorRoster workers={[worker({ handle: '@Turing' })]} />,
  )
  expect(html).toContain('>Turing<')
  expect(html).not.toContain('@Turing')
})
