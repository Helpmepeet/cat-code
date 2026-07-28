import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentConfigSnapshot } from '../../shared/protocol.js'
import { AgentsPage } from './AgentsPage.js'

const SNAPSHOT: AgentConfigSnapshot = {
  definitions: [
    {
      id: 'project:reviewer',
      agentType: 'reviewer',
      source: 'projectSettings',
      filePath: '/repo/.cat-code/agents/reviewer.md',
      whenToUse: 'Review code',
      tools: { mode: 'list', names: ['Read', 'Grep'] },
      model: 'inherit',
      provider: 'runtime',
      permissionMode: 'default',
      background: true,
      hasInitialPrompt: true,
      hasHooks: true,
      hasMcpServers: true,
      mcpServerRefs: ['linear'],
      inlineMcpServerNames: ['privateServer'],
      requiredMcpServers: ['linear'],
      missingMcpServers: [],
      active: true,
      available: true,
      editable: false,
      readOnlyReason: 'P4-7 exposes a read-only snapshot; desktop editing waits for a full-fidelity writer.',
      systemPrompt: { available: true, withheldReason: 'secret-boundary' },
    },
    {
      id: 'built-in:reviewer',
      agentType: 'reviewer',
      source: 'built-in',
      whenToUse: 'Built-in review',
      tools: { mode: 'all' },
      provider: 'runtime',
      background: false,
      hasInitialPrompt: false,
      hasHooks: false,
      hasMcpServers: false,
      mcpServerRefs: [],
      inlineMcpServerNames: [],
      requiredMcpServers: [],
      missingMcpServers: [],
      active: false,
      overriddenBy: 'projectSettings',
      available: false,
      editable: false,
      readOnlyReason: 'Built-in definitions ship with Cat Code.',
      systemPrompt: { available: true, withheldReason: 'secret-boundary' },
    },
  ],
  failedFiles: [],
  availableMcpServers: ['linear-prod'],
}

test('renders real agent definition groups, with no note about our own build', () => {
  const html = renderToStaticMarkup(<AgentsPage embedded snapshot={SNAPSHOT} />)

  expect(html).toContain('2 agent definitions')
  expect(html).toContain('Project')
  expect(html).toContain('Built-in')
  expect(html).toContain('reviewer')
  expect(html).toContain('active')
  expect(html).toContain('inactive')
  expect(html).toContain('overridden')
  expect(html).toContain('Read-only')
  // The landing pane of Settings is the first thing the operator sees, so the
  // deferral list that used to sit here — withheld payloads, undesigned writers
  // — is gone rather than reworded (CLAUDE.md §7).
  expect(html).not.toContain('Scope flags')
  expect(html).not.toContain('System prompt bodies')
  expect(html).not.toContain('deferred')
})

test('with no session, says what to do rather than naming the missing frame', () => {
  const html = renderToStaticMarkup(<AgentsPage embedded snapshot={null} />)
  // The read is session-keyed but Settings renders with no session, so this is a
  // no-session state, not a load. The copy it replaced promised a fill that
  // never came and named internals (CLAUDE.md §7).
  expect(html).toContain('Open a session to see its agent definitions')
  expect(html).not.toContain('MOCK')
})
