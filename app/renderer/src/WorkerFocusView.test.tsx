import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'
import { WorkerFocusView } from './WorkerFocusView.js'

const noop = () => {}

function worker(over: Partial<AgentModeWorkerItem> = {}): AgentModeWorkerItem {
  return {
    agentId: 'w-1',
    handle: 'Turing',
    role: 'agent-mode-coding-worker',
    status: 'running',
    description: 'Build the roster',
    ...over,
  }
}

test('focus header names the viewed worker and is read-only (claim reduced, no composer)', () => {
  const html = renderToStaticMarkup(
    <WorkerFocusView worker={worker()} active onBack={noop} />,
  )
  expect(html).toContain('Viewing')
  expect(html).toContain('Turing')
  expect(html).toContain('Orchestrator') // back affordance
  expect(html).toContain('read-only')
  expect(html).toContain('Task from orchestrator')
  expect(html).toContain('Build the roster')
  // No composer / send affordance is wired (no inbound verb in P4-8b).
  expect(html).not.toContain('aria-label="Prompt"')
})

test('a blocked worker under an active orchestrator shows the waiting-on-orchestrator gate from the real blockReason', () => {
  const html = renderToStaticMarkup(
    <WorkerFocusView
      worker={worker({
        status: 'completed',
        handoffStatus: 'blocked',
        blockReason: 'Need the API base URL',
      })}
      active
      onBack={noop}
    />,
  )
  expect(html).toContain('Waiting on orchestrator')
  expect(html).toContain('Need the API base URL')
  expect(html).toContain('The orchestrator resolves this')
})

test('M1 (2026-07-12 review): a blocked worker with NO active orchestrator (the real desktop case) shows the needs-you gate, never claiming an orchestrator resolves it', () => {
  const html = renderToStaticMarkup(
    <WorkerFocusView
      worker={worker({
        status: 'completed',
        handoffStatus: 'blocked',
        blockReason: 'Need the API base URL',
      })}
      active={false}
      onBack={noop}
    />,
  )
  // Same label the amber badge/baton already show for this worker — no
  // second gate invented, just reused.
  expect(html).toContain('Needs you')
  expect(html).toContain('Need the API base URL')
  // The active-orchestrator claim must NOT appear when there is no active
  // orchestrator plane (agentMode.active is always false in the desktop app).
  expect(html).not.toContain('The orchestrator resolves this')
})

test('a verifier renders a Verdict card from the real verdict; others render Result', () => {
  const verifier = renderToStaticMarkup(
    <WorkerFocusView
      worker={worker({
        role: 'verification',
        status: 'completed',
        verdict: 'PASS',
        outputSummary: 'All checks green',
      })}
      active={false}
      onBack={noop}
    />,
  )
  expect(verifier).toContain('Verdict · PASS')
  expect(verifier).toContain('All checks green')

  const coder = renderToStaticMarkup(
    <WorkerFocusView
      worker={worker({ status: 'completed', outputSummary: 'Wrote the reducer' })}
      active={false}
      onBack={noop}
    />,
  )
  expect(coder).toContain('Result')
  expect(coder).toContain('Wrote the reducer')
})
