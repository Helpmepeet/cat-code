import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentConfigSnapshot } from '../../shared/protocol.js'
import { AgentInspectDrawer, AgentsPage } from './AgentsPage.js'

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
      readOnlyReason: 'Read-only here. Edit the agent file to change it.',
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
  const html = renderToStaticMarkup(<AgentsPage snapshot={SNAPSHOT} />)

  expect(html).toContain('2 agent definitions')
  expect(html).toContain('Project')
  expect(html).toContain('Built-in')
  expect(html).toContain('reviewer')
  expect(html).toContain('active')
  expect(html).toContain('inactive')
  expect(html).toContain('overridden')
  expect(html).toContain('Read-only')
  expect(html).not.toContain('Unavailable')
  expect(html).not.toContain('mcp missing')
  // The landing pane of Settings is the first thing the operator sees, so the
  // deferral list that used to sit here — withheld payloads, undesigned writers
  // — is gone rather than reworded (CLAUDE.md §7).
  expect(html).not.toContain('Scope flags')
  expect(html).not.toContain('System prompt bodies')
  expect(html).not.toContain('deferred')
})

test('without a snapshot, reports a read failure rather than requiring a session', () => {
  const html = renderToStaticMarkup(<AgentsPage snapshot={null} />)
  expect(html).toContain('Agent definitions could not be read')
  expect(html).not.toContain('Open a session')
  expect(html).not.toContain('MOCK')
})

test('failed agent files show copyable paths and bounded, sanitized repair details', () => {
  const failedFiles = [
    {
      path: '/repo/.cat-code/agents/broken.md',
      error: 'Missing required "description" field in frontmatter',
    },
    {
      path: `/repo/.cat-code/agents/${'long-name'.repeat(200)}.md`,
      error: `Read failed at https://user:synthetic-credential@example.test/private?token=synthetic-credential\u0000 ${'detail '.repeat(200)}`,
    },
    ...Array.from({ length: 1000 }, (_, index) => ({
      path: `/repo/.cat-code/agents/extra-${index}.md`,
      error: 'Unknown parsing error',
    })),
  ]
  const html = renderToStaticMarkup(
    <AgentsPage snapshot={{ ...SNAPSHOT, failedFiles }} />,
  )

  expect(html).toContain('/repo/.cat-code/agents/broken.md')
  expect(html).toContain('Missing required &quot;description&quot; field in frontmatter')
  expect(html).toContain('aria-label="Copy agent definition file path"')
  expect(html).toContain('Read failed at https://example.test')
  expect(html).not.toContain('synthetic-credential')
  expect(html).not.toContain('\u0000')
  expect(html).not.toContain(failedFiles[1]!.path)
  expect(html).not.toContain('/repo/.cat-code/agents/extra-999.md')
  expect(html.length).toBeLessThan(25_000)
})

test('P4-57 agent definition file paths have a keyboard-reachable copy button', () => {
  const definition = { ...SNAPSHOT.definitions[0]!, available: false, missingMcpServers: ['linear'] }
  const html = renderToStaticMarkup(
    <AgentInspectDrawer definition={definition} onClose={() => {}} />,
  )

  expect(html).toContain(definition.filePath!)
  expect(html).toContain('aria-label="Copy agent definition file path"')
  expect(html).toContain('title="Copy agent definition file path"')
  expect(html).toContain('type="button"')
  expect(html).toContain('Configured')
  expect(html).not.toContain('Missing MCP')
  expect(html).not.toContain('>Available<')
  expect(html).not.toContain('payload withheld')
  expect(html).not.toContain('config withheld')
})

test('P4-57 wires the agent copy payload directly from the trusted definition path', () => {
  // The SSR suite has no DOM or clipboard implementation, so payload and
  // confirmation timing cannot be exercised here.
  const source = readFileSync(new URL('./AgentsPage.tsx', import.meta.url), 'utf8')
  const flat = source.replace(/\s+/g, ' ')

  expect(flat).toContain('<PathValue key="file-path" path={definition.filePath} />')
  expect(flat).toContain('<PathCopyButton label="agent definition file path" path={path} />')
  expect(flat).toContain("import { PathCopyButton } from './PathCopyButton.js'")
  expect(flat).toContain("import { EmptyState } from './EmptyState.js'")
  expect(flat).not.toContain('function PathCopyButton')

  const copySource = readFileSync(new URL('./PathCopyButton.tsx', import.meta.url), 'utf8')
  expect(copySource).toContain('.writeText(path)')
  expect(copySource).toContain('Path copied to clipboard')
})
