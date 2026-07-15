import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveToolCardExpanded, TranscriptRowsView } from './TranscriptView.js'
import type {
  NestedTranscriptRow,
  ToolCardStatus,
  ToolDiffProjection,
  ToolFamily,
  ToolResultProjection,
} from './transcriptProjector.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

// P4-24 empty-state Welcome fixtures — a real `AccountsSnapshot` shape (mirrors
// reauthBannerState.test.ts / WelcomeScreen.test.ts) so the empty transcript is
// proven to flow a REAL pool row into the Codex table, not a mock.
function account(over: Partial<AccountStatus> & { id: string }): AccountStatus {
  return {
    alias: over.id,
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Ready',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 0,
    usageWeekly: 0,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: false,
    ...over,
  }
}

function pool(accounts: AccountStatus[]): AccountsSnapshot {
  return {
    accounts,
    activeAccountId: accounts.find(a => a.isDefault)?.id ?? null,
    readyCount: accounts.filter(a => a.status === 'healthy' && !a.usageLimitReached)
      .length,
    poolCount: accounts.length,
    initialized: true,
  }
}

// P4-18a helpers: the two producer-id shapes rows carry. `content`-block rows
// (user/thinking/…) carry messageId/blockIndex/parentToolUseId; frame rows
// (session-init/result/boundaries/notices) carry only frameId.
const blockSource = {
  sessionId: 's' as const,
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [] as NestedTranscriptRow[],
}
const frameSource = {
  sessionId: 's' as const,
  frameId: 'f',
  children: [] as NestedTranscriptRow[],
}

function render(row: NestedTranscriptRow): string {
  return renderToStaticMarkup(<TranscriptRowsView rows={[row]} />)
}

test('renders an assistant text row as markdown, not raw source', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          id: 's:m:0:f',
          sessionId: 's',
          messageId: 'm',
          frameId: 'f',
          blockIndex: 0,
          parentToolUseId: null,
          kind: 'assistant-text',
          role: 'assistant',
          content: 'Reading **package.json** now.',
          children: [],
        },
      ]}
    />,
  )

  expect(html).toContain('<strong>package.json</strong>')
  expect(html).not.toContain('**package.json**')
})

test('P4-18c: a fenced code block renders framed with a per-block copy button', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:code',
    kind: 'assistant-text',
    role: 'assistant',
    content: 'Here:\n\n```ts\nconst x = 1\n```\n',
  })

  expect(html).toContain('const x = 1')
  expect(html).toContain('copy') // per-block copy control
  expect(html).toContain('ts') // language label
})

test('P4-18c: a streaming assistant row renders a caret', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:stream',
    kind: 'assistant-text',
    role: 'assistant',
    content: 'partial answer',
    isStreaming: true,
  })

  expect(html).toContain('partial answer')
  expect(html).toContain('animate-pulse') // the blinking streaming caret
})

test('P4-18c: a >60-line assistant body collapses behind a Show-more control', () => {
  const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
  const html = render({
    ...blockSource,
    id: 's:m:0:long',
    kind: 'assistant-text',
    role: 'assistant',
    content: long,
  })

  expect(html).toContain('Show 20 more lines')
  expect(html).toContain('line 0')
  expect(html).not.toContain('line 79') // tail hidden while collapsed
})

// P4-18b tool-card family helper: builds a tool-use nested row. Cards collapse
// by default (prototype FrameEShell), so header assertions (family WORD + target
// + state) are the per-family proof; bodies are asserted where they render
// (errored/imagegen cards expand; a bash card shows a collapsed tail-peek).
function toolRow(fields: {
  toolName: string
  toolFamily: ToolFamily
  input?: Record<string, unknown>
  status?: ToolCardStatus
  result?: ToolResultProjection | null
  children?: NestedTranscriptRow[]
}): NestedTranscriptRow {
  return {
    ...blockSource,
    id: `s:m:0:${fields.toolName}`,
    kind: 'tool-use',
    toolUseId: `toolu_${fields.toolName}`,
    toolName: fields.toolName,
    toolFamily: fields.toolFamily,
    input: fields.input ?? {},
    status: fields.status ?? 'pending',
    result: fields.result ?? null,
    children: fields.children ?? [],
  }
}

test('P4-18b: a tool card renders the family word, real target, and running state', () => {
  const html = render(
    toolRow({
      toolName: 'Read',
      toolFamily: 'read',
      input: { file_path: '/etc/hosts' },
      status: 'pending',
    }),
  )

  expect(html).toContain('Read') // family word
  expect(html).toContain('/etc/hosts') // real target from input.file_path
  expect(html).toContain('running') // pending → running state word
})

test('renders the rich WelcomeScreen (hero + real Codex table + cwd) when no rows are projected yet', () => {
  // Chat.jsx:1272 renders the SAME WelcomeScreen when the session is empty. The
  // in-session variant shows the cat|wordmark hero, the read-only cwd, and the
  // REAL P4-5 Codex pool table — proven by a fixture account alias reaching the
  // DOM (real data flows, not a shape-only assert). The old bare "How can I
  // help?" paw is gone.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[]}
      accounts={pool([
        account({ id: 'main', alias: 'nightowl', isDefault: true, usagePrimary: 20 }),
      ])}
      orchestratorActive
      cwd="/w/cat-code"
    />,
  )

  // Hero + wordmark instead of the bare paw.
  expect(html).toContain('Welcome back')
  expect(html).toContain('cat ')
  expect(html).toContain('code')
  expect(html).not.toContain('How can I help?')
  // The REAL Codex pool table with a fixture account alias (real data flows).
  expect(html).toContain('Codex')
  expect(html).toContain('nightowl')
  expect(html).toContain('20%')
  // HC1 session variant: read-only cwd context, no interactive project picker.
  expect(html).toContain('/w/cat-code')
  expect(html).not.toContain('<button')
  expect(html).not.toContain('Open a project')
  // Orchestrator reflect is read-only and mirrors the passed active flag.
  expect(html).toContain('aria-readonly="true"')
  expect(html).toContain('>On<')
})

test('P4-8b — threads onToggleOrchestrator to the empty-state WelcomeScreen (interactive switch)', () => {
  // Proves the full renderer path App→…→TranscriptRowsView→WelcomeScreen: when the
  // toggle callback is threaded, the in-session Orchestrator becomes a real button.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[]}
      orchestratorActive={false}
      cwd="/w/cat-code"
      onToggleOrchestrator={() => {}}
    />,
  )
  expect(html).toContain('role="switch"')
  expect(html).toContain('<button')
  expect(html).not.toContain('aria-readonly="true"')
})

test('the empty state degrades honestly with no pool snapshot and no cwd (no fabrication)', () => {
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[]} />)

  // Defaults (no accounts/cwd threaded): the hero still renders, the Codex table
  // says it has no data, and the cwd shows an honest placeholder — never a mock.
  expect(html).toContain('Welcome back')
  expect(html).toContain('No Codex account data')
  expect(html).toContain('This workspace')
})

// IS-C (M5) — restore affordance. A cached preview keeps a non-text divider, an
// engaged restore pulses, and a no-cache restore shows the skeleton instead of
// an empty WelcomeScreen (report F4's "reads as a hang").
const cachedRow: NestedTranscriptRow = {
  ...blockSource,
  id: 's:m:0:f',
  kind: 'assistant-text',
  role: 'assistant',
  content: 'cached line',
}

test('IS-C: preview rows render under a non-text restore divider', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[cachedRow]} restorePhase="preview" />,
  )
  expect(html).toContain('cached line')
  expect(html).toContain('bg-accent')
  // No visible restore labels.
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Opening session')
})

test('IS-C: an engaged preview shows a pulsing non-text divider', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[cachedRow]} restorePhase="resuming" />,
  )
  expect(html).toContain('animate-pulse') // live pulse dot
  expect(html).toContain('cached line')
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Opening session')
})

test('PL-A: a no-cache connecting pane shows a non-text skeleton, never an empty Welcome', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[]} restorePhase="connecting" cwd="/w/cat-code" />,
  )
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('animate-pulse')
  // The whole point of F4: no live/empty WelcomeScreen while a restore is pending.
  expect(html).not.toContain('Welcome back')
  expect(html).not.toContain('Opening session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Restored session')
})

test('IS-C: a preview that distilled to zero rows shows the skeleton, not Welcome', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[]} restorePhase="preview" />,
  )
  expect(html).toContain('aria-busy="true"')
  expect(html).not.toContain('Welcome back')
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Opening session')
})

test('IS-C: an ordinary empty pane (no restore) still shows the WelcomeScreen', () => {
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[]} />)
  expect(html).toContain('Welcome back')
  expect(html).not.toContain('Opening session')
  expect(html).not.toContain('Restored session')
})

test('IS-C: an ordinary live pane renders no restore divider', () => {
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[cachedRow]} />)
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).toContain('cached line')
})

test('P4-18b: a resolved bash card shows the collapsed tail-peek output and done state', () => {
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'echo hi' },
      status: 'success',
      result: { isError: false, content: 'hi\n', diff: null },
    }),
  )

  expect(html).toContain('done') // success → done state word
  expect(html).toContain('hi') // tail-peek surfaces output even collapsed
})

test('P4-18b: a bash card tints an error line and expands failed results', () => {
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'run tests' },
      status: 'error',
      result: { isError: true, content: 'ERROR: boom\nline two', diff: null },
    }),
  )

  expect(html).toContain('failed')
  expect(html).toContain('ERROR: boom') // errored card is expanded by default
  expect(html).toContain('text-tone-danger')
})

test('P4-18b: an edit card renders a dual-gutter diff with +adds/−dels counts', () => {
  const diff: ToolDiffProjection = {
    filePath: '/repo/app.ts',
    hunks: [
      {
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 2,
        lines: [' const a = 1', '-const b = 2', '+const b = 3'],
      },
    ],
  }
  const html = render(
    toolRow({
      toolName: 'Edit',
      toolFamily: 'edit',
      input: { file_path: '/repo/app.ts' },
      status: 'error', // expand so the diff body renders
      result: { isError: true, content: '', diff },
    }),
  )

  expect(html).toContain('/repo/app.ts')
  expect(html).toContain('+1') // one addition
  expect(html).toContain('−1') // one deletion
  expect(html).toContain('const b = 3')
})

test('P4-18b: an MCP card frames the target as server › tool', () => {
  const html = render(
    toolRow({
      toolName: 'mcp__gpt-agent__spawn',
      toolFamily: 'mcp',
      input: {},
      status: 'pending',
    }),
  )

  expect(html).toContain('MCP') // family word
  expect(html).toContain('gpt-agent › spawn') // server › tool framing
})

test('P4-18b: each tool family renders its own glyph + word header', () => {
  const families: Array<{ family: ToolFamily; word: string }> = [
    { family: 'read', word: 'Read' },
    { family: 'write', word: 'Write' },
    { family: 'grep', word: 'Search' },
    { family: 'web', word: 'Web' },
    { family: 'notebook', word: 'Notebook' },
    { family: 'lsp', word: 'LSP' },
    { family: 'skill', word: 'Skill' },
    { family: 'imagegen', word: 'Image' },
    { family: 'other', word: 'Tool' },
  ]
  for (const { family, word } of families) {
    const html = render(
      toolRow({ toolName: `T_${family}`, toolFamily: family, status: 'pending' }),
    )
    expect(html).toContain(word)
  }
})

test('P4-18b: a GenerateImage card flags the missing inline-image seam, never mocks a tile', () => {
  const html = render(
    toolRow({
      toolName: 'GenerateImage',
      toolFamily: 'imagegen',
      input: { prompt: 'a cat' },
      status: 'success',
      result: { isError: false, content: 'saved to /tmp/cat.png', diff: null },
    }),
  )

  expect(html).toContain('saved to /tmp/cat.png') // real result text
  expect(html).toContain('inline image tile pending') // flagged, not mocked
})

// P4-8c: a top-level Agent tool-use row (the DelegateGroup member / lone card).
// messageId is shared ('m' via blockSource) so two of these coalesce; distinct
// ids/toolUseIds keep them separate rows.
function agentRow(
  suffix: string,
  input: Record<string, unknown>,
  status: ToolCardStatus,
  children: NestedTranscriptRow[] = [],
): NestedTranscriptRow {
  return {
    ...blockSource,
    id: `s:m:0:agent-${suffix}`,
    kind: 'tool-use',
    toolUseId: `toolu_agent_${suffix}`,
    toolName: 'Agent',
    toolFamily: 'agent',
    input,
    status,
    result: null,
    children,
  }
}

test('P4-8c: an Agent card derives type/state/task from the row input + status (data-path honest)', () => {
  const html = render(
    agentRow('solo', { subagent_type: 'Explore', description: 'map the seam' }, 'pending'),
  )

  expect(html).toContain('Agent') // family word (◆ Agent header)
  expect(html).toContain('Explore') // worker type from input.subagent_type
  expect(html).toContain('map the seam') // description line (header target)
  expect(html).toContain('Running') // derived AgentStateLabel (pending → running)
})

test('P4-8c: a completed Agent card shows the Completed agent state', () => {
  const html = render(
    agentRow('done', { subagent_type: 'Explore', description: 'done task' }, 'success'),
  )

  expect(html).toContain('Completed') // deriveAgentToolState: success → completed
})

test('D2/C4: an owning Agent card nests its subagent COLLAPSED by default with a child-count affordance', () => {
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate the seam' }, 'pending', [
      toolRow({
        toolName: 'Grep',
        toolFamily: 'grep',
        input: { pattern: 'foo' },
        status: 'pending',
      }),
    ]),
  )

  expect(html).toContain('Agent') // parent family word (always-visible header)
  expect(html).toContain('1 nested') // child-count expand affordance in the header
  // C4: children are COLLAPSED by default — the nested subagent content is not
  // rendered until the card is expanded, so it must not leak top-level.
  expect(html).not.toContain('Search') // nested grep family word hidden
  expect(html).not.toContain('foo') // nested target hidden
})

test('D2/§3: two co-spawned Agent rows (same messageId) render as ONE DelegateGroup with both members', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        agentRow('a', { subagent_type: 'Explore', description: 'audit A' }, 'pending'),
        agentRow('b', { subagent_type: 'Explore', description: 'audit B' }, 'pending'),
      ]}
    />,
  )

  expect(html).toContain('Delegate') // group eyebrow
  expect(html).toContain('Running 2 Explore agents') // engine-faithful group summary
  expect(html).toContain('audit A') // member A card
  expect(html).toContain('audit B') // member B card
})

test('P4-8c: the Agent card + DelegateGroup emit only static tone utilities (no interpolated/arbitrary classes)', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        agentRow('a', { subagent_type: 'Explore', description: 'x' }, 'pending'),
        agentRow('b', { subagent_type: 'Explore', description: 'y' }, 'pending'),
      ]}
    />,
  )

  // Static utilities from the 8a tone maps actually reach the DOM (a dynamic
  // `text-[${hex}]` would silently never generate — the P4-9 trap).
  expect(html).toContain('text-blue-400') // running state tone (AGENT_STATE_TONE_CLASS.info)
  expect(html).toContain('bg-blue-400')
  expect(html).toContain('text-sky-300') // Explore type tone (AGENT_TYPE_TONE_CLASS.sky)
  // No template-literal interpolation ever leaks into a className.
  expect(html).not.toContain('${')
})

// ── P4-18a: user turns + core/boundary rows (the functional fix) ────────────

test('P4-18a REGRESSION: a projected user-text turn is rendered, not dropped', () => {
  // Pre-18a, TranscriptView returned null for every non-tool-use kind, so the
  // running app showed no user messages. This proves the drop is fixed.
  const html = render({
    ...blockSource,
    id: 's:m:0:user-text',
    kind: 'user-text',
    role: 'user',
    content: 'restart the sidecar please',
    isReplay: false,
  })

  expect(html).toContain('restart the sidecar please')
})

test('P4-18a: a command echo renders the slash command in the user column', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:command-echo',
    kind: 'command-echo',
    commandName: 'resume',
    args: 'abc123',
    content: '/resume abc123',
    skillFormat: false,
    isReplay: false,
  })

  expect(html).toContain('/resume')
  expect(html).toContain('abc123')
})

test('P4-18a: a skill-format command echo renders Skill(name)', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:command-echo',
    kind: 'command-echo',
    commandName: 'pickup',
    args: null,
    content: 'Skill(pickup)',
    skillFormat: true,
    isReplay: false,
  })

  expect(html).toContain('Skill(pickup)')
})

test('P4-18a: a pasted user image renders an img with the data URI', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:user-image',
    kind: 'user-image',
    source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' },
    isReplay: false,
  })

  expect(html).toContain('<img')
  expect(html).toContain('data:image/png;base64,AAAA')
})

test('P4-18a: a thinking row renders its reasoning body and eyebrow', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:thinking',
    kind: 'thinking',
    content: 'weighing the socket options',
    reasoningKind: 'summary',
  })

  expect(html).toContain('Thinking')
  expect(html).toContain('weighing the socket options')
  expect(html).toContain('summary')
})

test('P4-18a: a redacted-thinking row renders a redacted placeholder', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:redacted-thinking',
    kind: 'redacted-thinking',
    data: 'ENCRYPTED',
  })

  expect(html).toContain('redacted by the model provider')
  // The encrypted payload must never be printed.
  expect(html).not.toContain('ENCRYPTED')
})

// P4-23 (operator, 2026-07-09): the ✦ "Session started" banner row was removed.
// The init frame still runs (it captures the P3-7 slash catalog — see
// transcriptProjector.test.ts) but emits no transcript row, so there is no
// SessionInitBanner render case to test here anymore.

test('P4-18a: a completed result row renders a Completed seam with duration', () => {
  const html = render({
    ...frameSource,
    id: 's:f:result',
    kind: 'result',
    subtype: 'success',
    isError: false,
    errors: [],
    durationMs: 4200,
    totalCostUsd: 0.0123,
  })

  expect(html).toContain('Completed')
  expect(html).toContain('4.2s')
})

test('P4-18a: an errored result row renders an Errored seam', () => {
  const html = render({
    ...frameSource,
    id: 's:f:result',
    kind: 'result',
    subtype: 'error_during_execution',
    isError: true,
    errors: ['boom'],
  })

  expect(html).toContain('Errored')
})

test('P4-18a: a compact-boundary row renders the compaction seam', () => {
  const html = render({
    ...frameSource,
    id: 's:f:compact-boundary',
    kind: 'compact-boundary',
    trigger: 'auto',
    preTokens: 120000,
  })

  expect(html).toContain('Conversation compacted')
  expect(html).toContain('auto')
})

test('P4-18a: a system-notice row renders the notice box with its tag', () => {
  const html = render({
    ...frameSource,
    id: 's:f:system-notice',
    kind: 'system-notice',
    noticeType: 'api_retry',
    content: 'retrying after 429',
  })

  expect(html).toContain('retrying after 429')
  expect(html).toContain('api_retry')
})

test('P4-18a: snip-boundary and tombstone typed-degraded rows still render', () => {
  const snip = render({
    ...frameSource,
    id: 's:f:snip-boundary',
    kind: 'snip-boundary',
  })
  const tombstone = render({
    ...frameSource,
    id: 's:f:tombstone',
    kind: 'tombstone',
  })

  expect(snip).toContain('Stale tool output snipped')
  expect(tombstone).toContain('message removed')
})

test('P4-18a: a schema-drifted unknown kind degrades to a tolerant fallback, not a throw', () => {
  // Simulates a wire kind past the pinned union (display = degrade gracefully).
  const drifted = {
    ...frameSource,
    id: 's:f:future',
    kind: 'future-row-kind',
  } as unknown as NestedTranscriptRow

  const html = render(drifted)

  expect(html).toContain('Unrecognized transcript row')
  expect(html).toContain('future-row-kind')
})

// P4-REVIEW B3: `resolveToolCardExpanded` is the pure decision logic behind
// ToolCardShell's collapse state. Before this fix, `expanded` was seeded once
// from `defaultExpanded` via `useState(defaultExpanded ?? false)`, so a stable
// row that lived through a live pending→error (or imagegen success) transition
// never re-read the new `defaultExpanded` — the card stayed collapsed. SSR
// can't exercise that live re-render (no effects, no re-render), so this
// helper is unit-tested directly; the live transition itself is covered only
// by the P4-18 GUI acceptance pass.
test('P4-REVIEW B3: resolveToolCardExpanded defaults to defaultExpanded until the user overrides it', () => {
  // The fix: no user toggle yet (null) → defaultExpanded wins every time,
  // including a fresh pending→error flip on an already-mounted card.
  expect(resolveToolCardExpanded(null, true)).toBe(true)
  expect(resolveToolCardExpanded(null, false)).toBe(false)
})

test('P4-REVIEW B3: resolveToolCardExpanded lets a user override win over either default', () => {
  expect(resolveToolCardExpanded(true, false)).toBe(true)
  expect(resolveToolCardExpanded(false, true)).toBe(false)
})
