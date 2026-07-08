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
  notes: [],
}

test('renders real agent definition groups and scope flags', () => {
  const html = renderToStaticMarkup(<AgentsPage embedded snapshot={SNAPSHOT} />)

  expect(html).toContain('2 agent definitions')
  expect(html).toContain('Project')
  expect(html).toContain('Built-in')
  expect(html).toContain('reviewer')
  expect(html).toContain('active')
  expect(html).toContain('inactive')
  expect(html).toContain('overridden')
  expect(html).toContain('Read-only snapshot')
  expect(html).toContain('System prompt bodies')
  expect(html).toContain('runtime-selected')
})

test('renders waiting state without fixtures', () => {
  const html = renderToStaticMarkup(<AgentsPage embedded snapshot={null} />)
  expect(html).toContain("Waiting for the engine&#x27;s agent config snapshot")
  expect(html).not.toContain('MOCK')
})
