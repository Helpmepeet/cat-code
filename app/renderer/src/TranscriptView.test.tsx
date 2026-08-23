import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  ToolInspectorOverlay,
  TranscriptRowsView,
} from './TranscriptView.js'
import {
  dequote,
  findNestedToolUseRow,
  logLineClass,
  resolveToolCardExpanded,
  groupGrepLines,
  selectPeekLines,
  splitGrepLine,
} from './transcriptViewModel.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { TRANSCRIPT_ROW_KEY_ATTRIBUTE } from './transcriptScrollMemory.js'
import {
  createToolCardExpansionStore,
  ToolCardExpansionContext,
  type ToolCardExpansionStore,
} from './toolCardExpansion.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
} from './transcriptProjector.js'
import type {
  AgentCompletionProjection,
  NestedTranscriptRow,
  NestedToolUseRow,
  ToolCardStatus,
  ToolDiffProjection,
  ToolFamily,
  ToolResultProjection,
} from './transcriptProjector.js'
import {
  ReasoningLayoutContext,
  type ReasoningLayoutMode,
} from './reasoningLayout.js'
import { MAX_MOUNTED_COMPOSITE_CHILDREN } from './compositeChildWindow.js'
import {
  AgentFaceRegistryContext,
  createAgentFaceRegistry,
  faceHash,
  FACE_FILL_COUNT,
} from './agentFace.js'
import { AGENT_FACE_IDENTITY_FILL } from './agentChromeModel.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

// P4-24 empty-state Welcome fixtures — a real `AccountsSnapshot` shape (mirrors
// WelcomeScreen.test.ts) so the empty transcript is
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
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    anthropicRouteAvailable: false,
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

/** Render rows under an explicit reasoning-display mode. No provider (the
 * `render` helper above) means the context default — the shipped default mode. */
function renderRows(
  rows: NestedTranscriptRow[],
  mode: ReasoningLayoutMode,
): string {
  return renderToStaticMarkup(
    <ReasoningLayoutContext.Provider value={{ mode, setMode: () => {} }}>
      <TranscriptRowsView rows={rows} />
    </ReasoningLayoutContext.Provider>,
  )
}

function thinkingRow(id: string, content: string): NestedTranscriptRow {
  return { ...blockSource, id, kind: 'thinking', content }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * The rendered text with its tags removed, entities left escaped.
 *
 * For asserting that some source is ON SCREEN in a syntax-colored body. The
 * highlighter splits a line into token spans, so `const greeting` is no longer
 * one contiguous run in the markup even though it is one contiguous run to the
 * reader. Asserting through this says "the file's text is visible" instead of
 * pinning which tokenizer ran.
 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '')
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

  expect(html).toContain(
    '<strong><button class="inline-flex items-center gap-0.5 rounded-sm align-baseline font-mono text-accent hover:text-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent" type="button" aria-label="Open package.json"><svg',
  )
  expect(html).toContain('</svg>package.json</button></strong>')
  expect(html).not.toContain('**package.json**')
})

test('renders workspace file paths as open-file controls without linkifying web URLs', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:paths',
    kind: 'assistant-text',
    role: 'assistant',
    content:
      'Created at:docs/reports/2026-08-13-session-label-flow.md. Read README.md, **package.json**, `src/main.ts`, and `docs/My Report.md`. See https://example.com/readme.md, example.com/readme.md, and www.example.com/readme.md.',
  })

  expect(html).toContain(
    '<button class="inline-flex items-center gap-0.5 rounded-sm align-baseline font-mono text-accent hover:text-accent-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent" type="button" aria-label="Open docs/reports/2026-08-13-session-label-flow.md"><svg',
  )
  expect(html).toContain('https://example.com/readme.md')
  expect(html).not.toContain('aria-label="Open /example.com/readme.md"')
  expect(html).toContain(
    'aria-label="Open src/main.ts"><svg',
  )
  expect(html).toContain('</svg><code>src/main.ts</code>')
  expect(html).toContain('aria-label="Open README.md"><svg')
  expect(html).toContain('</svg>README.md</button>')
  expect(html).toContain(
    'aria-label="Open package.json"><svg',
  )
  expect(html).toContain(
    'aria-label="Open docs/My Report.md"><svg',
  )
  expect(html).toContain('</svg><code>docs/My Report.md</code>')
  expect(html).not.toContain('aria-label="Open example.com/readme.md"')
  expect(html).not.toContain('aria-label="Open www.example.com/readme.md"')
})

test('a markdown link to a workspace path opens the file, and a line suffix is dropped', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:filelink',
    kind: 'assistant-text',
    role: 'assistant',
    content:
      'See [foo.ts](src/utils/foo.ts) and [Bar.tsx:42](app/components/Bar.tsx:42), plus [the docs](https://example.com/readme.md).',
  })

  expect(html).toContain('aria-label="Open src/utils/foo.ts"><svg')
  expect(html).toContain('</svg>foo.ts</button>')
  // The `:42` addresses a line, not a file on disk: main stats the path itself.
  expect(html).toContain('aria-label="Open app/components/Bar.tsx"><svg')
  expect(html).toContain('</svg>Bar.tsx:42</button>')
  // An external link stays an anchor, never an open-file control, and carries
  // the target that routes it to the OS browser through the window-open policy.
  expect(html).toContain(
    '<a href="https://example.com/readme.md" target="_blank" rel="noreferrer">the docs</a>',
  )
  expect(html).not.toContain('aria-label="Open https://example.com/readme.md"')
})

test('a version number is not a file path', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:version',
    kind: 'assistant-text',
    role: 'assistant',
    content:
      'Claude Code 2.1.238 has a regression, and `2.1.234` fixed one. Read src/main.ts.',
  })

  expect(html).not.toContain('aria-label="Open .1.238"')
  expect(html).not.toContain('aria-label="Open 2.1.234"')
  expect(html).toContain('2.1.238')
  expect(html).toContain('aria-label="Open src/main.ts"><svg')
})

test('P4-18c: a fenced code block renders framed + copyable with syntax highlight tokens', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:code',
    kind: 'assistant-text',
    role: 'assistant',
    content: 'Here:\n\n```ts\nconst x = 1\n```\n',
  })

  // rehype-highlight tokenizes the block — the code is split across hljs spans
  // (so it is no longer one contiguous string), but every token still renders.
  expect(html).toContain('hljs-keyword') // `const` colored as a keyword token
  expect(html).toContain('const') // code content still present, tokenized
  expect(html).toContain('copy') // per-block copy control
  expect(html).toContain('ts') // floating language label
})

test('bounds a giant assistant response before react-markdown creates its full tree', () => {
  const content = Array.from(
    { length: 1_000 },
    (_, index) => `Paragraph ${index + 1}`,
  ).join('\n\n')
  const html = render({
    ...blockSource,
    id: 's:m:0:giant',
    kind: 'assistant-text',
    role: 'assistant',
    content,
  })

  expect(html).toContain('Paragraph 1')
  expect(html).not.toContain('Paragraph 1000')
  expect(html).toContain('aria-hidden="true"')
})

/* CC-59: the bounded body used to hand each source chunk to its own Markdown
 * parse, so a table cut mid-body lost its header, an ordered list restarted at
 * 1, and a long fence became one card per chunk. The whole reply is parsed once
 * now and only a range of that ONE tree mounts. */

test('CC-59: a long fence stays one card with one copy control while its lines are bounded', () => {
  const fence = [
    '```ts',
    ...Array.from({ length: 400 }, (_, index) => `const line${index} = ${index}`),
    '```',
  ].join('\n')
  const html = render(proseRow(fence, 'longfence'))

  // One card: one framed <pre>, one floating language label, one copy control.
  expect(occurrences(html, 'pt-[38px]')).toBe(1)
  expect(occurrences(html, '&lt;/&gt;')).toBe(1)
  expect(occurrences(html, '>copy</button>')).toBe(1)
  expect(html).toContain('hljs-keyword')

  // Bounded: the window mounts a fraction of the 400 lines, and a spacer stands
  // in for the rest.
  const mounted = html.match(/line\d+/g)?.length ?? 0
  expect(mounted).toBeGreaterThan(0)
  expect(mounted).toBeLessThan(400)
  expect(html).toContain('aria-hidden="true"')
})

test('CC-59: a table longer than one window keeps its header row and prototype chrome', () => {
  const rows = Array.from({ length: 500 }, (_, index) => `| a${index} | b${index} |`).join('\n')
  const html = render(proseRow(`| Name | Role |\n|------|------|\n${rows}`, 'longtable'))

  expect(html).toContain('<thead>')
  expect(html).toContain('Name')
  expect(html).toContain('Role')
  expect(html).toContain('bg-white/[0.03]') // header wash still applied
  expect(html).toContain('a0')
  expect(html).not.toContain('a499')
  expect(occurrences(html, '<table')).toBe(1)
})

test('CC-59: a reference link resolves even though its definition never renders', () => {
  const html = render(
    proseRow('See the [manual][ref] for details.\n\n[ref]: https://example.com/manual\n', 'reflink'),
  )

  expect(html).toContain('href="https://example.com/manual"')
  expect(html).not.toContain('[manual][ref]')
  expect(html).not.toContain('[ref]:')
})

test('a blockquote gets its own per-quote copy control', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:quote',
    kind: 'assistant-text',
    role: 'assistant',
    content: 'Here is the message I would send:\n\n> Ship the fix today.\n',
  })

  expect(html).toContain('<blockquote')
  expect(html).toContain('Ship the fix today.')
  expect(html).toContain('aria-label="Copy quote"') // per-quote copy control
  expect(html).not.toContain('md-callout')
})

test('a recognized alert renders as rich Markdown with its fenced code card intact', () => {
  const html = render(
    proseRow(
      [
        '> [!NOTE]',
        '> Keep **this structure** together.',
        '>',
        '> - First item',
        '> - Second item',
        '>',
        '> ```ts',
        '> const value = 1',
        '> ```',
      ].join('\n'),
      'callout-rich',
    ),
  )

  expect(html).toContain('<aside class="md-callout" data-callout-kind="note">')
  expect(html).toContain('<div class="md-callout-label">Note</div>')
  expect(html).not.toContain('[!NOTE]')
  expect(html).toContain('<strong>this structure</strong>')
  expect(html).toContain('<ul>')
  expect(html).toContain('First item')
  expect(html).toContain('hljs-keyword')
  expect(html).toContain('const')
  expect(html).toContain('pt-[38px]')
  expect(html).toContain('&lt;/&gt;')
  expect(html).toContain('>copy</button>')
  expect(html).toContain('>ts</span>')
  expect(html).not.toContain('aria-label="Copy quote"')
})

test.each([
  ['TIP', 'tip', 'Tip'],
  ['IMPORTANT', 'important', 'Important'],
  ['WARNING', 'warning', 'Warning'],
  ['CAUTION', 'caution', 'Caution'],
])('the %s alert marker renders the %s callout', (marker, kind, label) => {
  const html = render(proseRow(`> [!${marker}]\n> Body`, `callout-${kind}`))

  expect(html).toContain(`data-callout-kind="${kind}"`)
  expect(html).toContain(`>${label}</div>`)
  expect(html).not.toContain(`[!${marker}]`)
})

test('an unknown alert marker stays visible in an ordinary blockquote', () => {
  const html = render(proseRow('> [!TEXT]\n> Keep this literal.', 'unknown-callout'))

  expect(html).toContain('<blockquote')
  expect(html).toContain('[!TEXT]')
  expect(html).toContain('Keep this literal.')
  expect(html).toContain('aria-label="Copy quote"')
  expect(html).not.toContain('md-callout')
})

test('quote and reasoning markdown component types stay stable between content changes', () => {
  // SSR cannot preserve click state, so pin the component-identity guard at its
  // source: changing unrelated streamed rows must not remount QuoteCopyChip.
  const source = readFileSync(new URL('./TranscriptView.tsx', import.meta.url), 'utf8')
  expect(source).toContain('const components = useMemo(')
  expect(source).toContain('REASONING_HEADING_COMPONENTS')
})

test('prose with no blockquote gets no per-quote copy control', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:no-quote',
    kind: 'assistant-text',
    role: 'assistant',
    content: 'Just a plain answer, no quoted message inside it.',
  })

  expect(html).not.toContain('<blockquote')
  expect(html).not.toContain('aria-label="Copy quote"')
  expect(html).not.toContain('copy')
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
  agentCompletion?: AgentCompletionProjection | null
  children?: NestedTranscriptRow[]
  /** Only needed when a test renders more than one row of the same tool. */
  id?: string
}): NestedToolUseRow {
  return {
    ...blockSource,
    id: fields.id ?? `s:m:0:${fields.toolName}`,
    kind: 'tool-use',
    toolUseId: `toolu_${fields.id ?? fields.toolName}`,
    toolName: fields.toolName,
    toolFamily: fields.toolFamily,
    agentCompletion: fields.agentCompletion ?? null,
    input: fields.input ?? {},
    status: fields.status ?? 'pending',
    result: fields.result ?? null,
    children: fields.children ?? [],
  }
}

test('P4-18b: a Read tool card renders the filename, not its full path', () => {
  const html = render(
    toolRow({
      toolName: 'Read',
      toolFamily: 'read',
      input: { file_path: '/etc/hosts' },
      status: 'pending',
    }),
  )

  expect(html).toContain('Read') // family word
  expect(html).toContain('hosts') // filename from input.file_path
  expect(html).not.toContain('/etc/hosts')
  // The state word is dropped from the header pill (operator call, 2026-08-05):
  // a colour-coded dot carries it, labelled for a11y rather than printed.
  expect(html).toContain('aria-label="running"')
})

test('renders a cancelled tool without its interruption body', () => {
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      status: 'cancelled',
      result: {
        isError: true,
        isCancelled: true,
        content: 'Interrupted by user with provider details',
        diff: null,
      },
    }),
  )

  expect(html).toContain('aria-label="stopped"')
  expect(html).toContain('This tool was stopped before it finished.')
  expect(html).not.toContain('Interrupted by user with provider details')
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

// IS-C (M5) — restore affordance. Cached transcript rows retain their content
// without startup decoration; a no-cache restore shows the skeleton instead of
// an empty WelcomeScreen (report F4's "reads as a hang").
const cachedRow: NestedTranscriptRow = {
  ...blockSource,
  id: 's:m:0:f',
  kind: 'assistant-text',
  role: 'assistant',
  content: 'cached line',
}

test('IS-C: preview rows render without a restore divider', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[cachedRow]} restorePhase="preview" />,
  )
  expect(html).toContain('cached line')
  expect(html).not.toContain('h-px flex-1 bg-accent/20')
  // No visible restore chrome or labels.
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Opening session')
})

test('IS-C: an engaged preview does not add a pulsing restore divider', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[cachedRow]} restorePhase="resuming" />,
  )
  expect(html).toContain('cached line')
  expect(html).not.toContain('h-px flex-1 bg-accent/20')
  expect(html).not.toContain('animate-pulse')
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

  expect(html).toContain('aria-label="done"') // success → done state, dot-only
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

  expect(html).toContain('aria-label="failed"')
  expect(html).toContain('ERROR: boom') // errored card is expanded by default
  expect(html).toContain('text-tone-danger')
})

// Quote-free slice of ResumeAgent's real ack: SSR escapes the `"@Ramanujan"`
// the engine's wording puts around the name, so assert on the rest of it.
const RESUME_ACK = 'in the background. Previous context: ~105k / 372k tokens (28%).'

test('a resumed agent is an independent agent card named by the follow-up prompt', () => {
  const html = render(
    toolRow({
      toolName: 'ResumeAgent',
      toolFamily: 'agent',
      input: { agentId: '@Ramanujan', prompt: 'measure the card height' },
      status: 'success',
      result: {
        isError: false,
        content: JSON.stringify({
          success: true,
          message: `Resumed "@Ramanujan" ${RESUME_ACK}`,
        }),
        diff: null,
        // NO `agentName`: ResumeAgentTool's structured result is `{success,
        // message}` and nothing else (`src/tools/ResumeAgentTool/
        // ResumeAgentTool.tsx:38-39,156-160`), and a backgrounded resume sends
        // this card no nested frames to carry one either. A resume card is
        // nameless on real data — see the flag test below.
      },
      agentCompletion: {
        status: 'completed',
        summary: 'Agent @Ramanujan completed',
        result: 'The card is 84 pixels high.',
        usage: { totalTokens: 9500, toolUses: 5, durationMs: 52000 },
      },
    }),
  )

  // Titled with the RESUME PROMPT, not the original task, and typed `resumed`.
  expect(html).toContain('measure the card height')
  expect(html).toContain('resumed')
  expect(html).toContain('The card is 84 pixels high.')
  expect(html).toContain('~9.5k tokens')
  expect(html).not.toContain('resume @Ramanujan')
  expect(html).not.toContain(RESUME_ACK)
  expect(html).not.toContain('"success"')
  // The lifecycle WORD is gone from every state but the two that need to stop a
  // reader (Failed, Stopped). The face carries no state at all (2026-08-21),
  // including to a screen reader: it is the identity mark beside the worker's own
  // name, so it is decorative and the row's text is what announces the run.
  expect(html).not.toContain('>Completed<')
  expect(html).not.toContain('aria-label="Completed"')
  // The ◇ mark went with the family word; only a REJECTED resume still carries
  // one, because it has no face to identify it.
  expect(html).not.toContain('◇')
})

test('ack card: a FAILED ack tints the peek while the header still reports the call', () => {
  const html = render(
    toolRow({
      toolName: 'ResumeAgent',
      toolFamily: 'agent-control',
      input: { agentId: '@Ramanujon', prompt: 'go' },
      // The tool call succeeded; the operation it performed did not.
      status: 'success',
      result: {
        isError: false,
        content: JSON.stringify({
          success: false,
          message: 'No subagent found for "@Ramanujon".',
        }),
        diff: null,
      },
    }),
  )

  expect(html).toContain('No subagent found')
  expect(html).toContain('text-tone-danger') // ack tone, from `success:false`
  expect(html).toContain('aria-label="done"') // call status, unchanged and still true
  expect(html).not.toContain('aria-label="failed"')
})

test('ack card: the expanded body labels the result and the prompt that was sent', () => {
  const html = render(
    toolRow({
      toolName: 'ResumeAgent',
      toolFamily: 'agent-control',
      input: { agentId: '@Ramanujan', prompt: 'measure the card height' },
      // An errored row is the default-expanded case, so SSR can see the body.
      status: 'error',
      result: {
        isError: true,
        content: JSON.stringify({ success: false, message: 'Failed to resume.' }),
        diff: null,
      },
    }),
  )

  expect(html).toContain('Result')
  expect(html).toContain('Failed to resume.')
  expect(html).toContain('Sent')
  expect(html).toContain('measure the card height')
})

test('ack card: a non-ack result keeps its existing rendering untouched', () => {
  const html = render(
    toolRow({
      toolName: 'SomeFutureTool',
      toolFamily: 'other',
      status: 'error',
      result: { isError: true, content: 'plain stdout, not JSON', diff: null },
    }),
  )

  expect(html).toContain('plain stdout, not JSON')
  expect(html).toContain('Tool') // still the neutral family
})

test('TaskOutput renders the structured agent answer in a Task Output card', () => {
  const html = render(
    toolRow({
      toolName: 'TaskOutput',
      toolFamily: 'other',
      status: 'success',
      result: {
        isError: false,
        content:
          '<retrieval_status>success</retrieval_status><output>raw payload</output>',
        diff: null,
        taskOutput: {
          taskId: 'task-1',
          description: 'Find every caller of the retry helper',
          output: 'Four callers, all in the request layer.',
        },
      },
    }),
  )

  expect(html).toContain('Task Output')
  expect(html).toContain('Find every caller of the retry helper')
  expect(html).toContain('Four callers, all in the request layer.')
  expect(html).not.toContain('&lt;retrieval_status&gt;')
  expect(html).toContain('task-1')
})

test('P4-18b: an expanded edit card keeps its counts in the shell and one current-file gutter', () => {
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

  expect(html).toContain('+1') // one addition
  expect(html).toContain('−1') // one deletion
  // ToolCardShell owns the count badge; DiffView does not repeat a file/count header.
  expect(html.match(/>\+1</g)).toHaveLength(1)
  expect(html.match(/>−1</g)).toHaveLength(1)
  expect(html.match(/w-\[26px\]/g)).toHaveLength(3) // one gutter for each source row
  // P4-18c word-level intra-line highlight: the replaced token (2 → 3) is washed
  // per side; the shared prefix dims. The line is no longer one contiguous string.
  expect(html).toContain('bg-tone-danger/28') // removed word wash
  expect(html).toContain('bg-tone-success/26') // added word wash
  expect(visibleText(html)).toContain('const b = ') // shared, dimmed prefix
})

test('P4-18b: a collapsed edit card keeps its diff counts visible in the header', () => {
  const html = render(
    toolRow({
      toolName: 'Edit',
      toolFamily: 'edit',
      input: { file_path: '/repo/app.ts' },
      status: 'success',
      result: {
        isError: false,
        content: '',
        diff: {
          filePath: '/repo/app.ts',
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
        },
      },
    }),
  )

  expect(html).toContain('>+1</span>')
  expect(html).toContain('>−1</span>')
  expect(html).not.toContain('w-[26px]') // body remains collapsed
})

test('P4-18b: a collapsed Write-create card counts input content before a result exists', () => {
  const html = render(
    toolRow({
      toolName: 'Write',
      toolFamily: 'write',
      input: { file_path: '/repo/new.ts', content: 'const a = 1\nconst b = 2\n' },
      status: 'pending',
    }),
  )

  expect(html).toContain('>+3</span>')
  expect(html).not.toContain('>−')
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
    { family: 'agent-control', word: 'Agent' },
    { family: 'other', word: 'Tool' },
  ]
  for (const { family, word } of families) {
    const html = render(
      toolRow({ toolName: `T_${family}`, toolFamily: family, status: 'pending' }),
    )
    expect(html).toContain(word)
  }
})

test('a completed GenerateImage card shows the generated image by default', () => {
  const html = render(
    toolRow({
      toolName: 'GenerateImage',
      toolFamily: 'imagegen',
      input: { prompt: 'a cat', quality: 'high' },
      status: 'success',
      result: {
        isError: false,
        content: 'saved to /tmp/cat.png',
        diff: null,
        generatedImage: {
          filePath: '/tmp/cat.png',
          model: 'gpt-image-2',
          size: '1024x1024',
          outputFormat: 'png',
          bytes: 4,
          preview: { mediaType: 'image/png', data: 'AAAA' },
        },
      },
    }),
  )

  expect(html).toContain('alt="Generated image"')
  expect(html).toContain('data:image/png;base64,AAAA')
  expect(html).toContain('gpt-image-2')
  expect(html).toContain('1024x1024')
  expect(html).toContain('4 B')
  expect(html).toContain('Saved to')
  expect(html).toContain('tmp/')
  expect(html).toContain('title="/tmp/cat.png"')
  expect(html).toContain('Copy path')
  expect(html).not.toContain('high')
  expect(html).not.toContain('aria-expanded')

  const source = readFileSync(new URL('./TranscriptView.tsx', import.meta.url), 'utf8')
  expect(source).toContain(
    "toast('Could not write to the clipboard', { tone: 'warn' })",
  )
  expect(source).toContain('clearTimeout(copiedResetRef.current)')
  expect(source).toContain('copiedResetRef.current = setTimeout')
})

// P4-8c: a top-level Agent tool-use row (the DelegateGroup member / lone card).
// messageId is shared ('m' via blockSource) so two of these coalesce; distinct
// ids/toolUseIds keep them separate rows.
function agentRow(
  suffix: string,
  input: Record<string, unknown>,
  status: ToolCardStatus,
  children: NestedTranscriptRow[] = [],
  agentCompletion: AgentCompletionProjection | null = null,
  result: ToolResultProjection | null = null,
): NestedToolUseRow {
  return {
    ...blockSource,
    id: `s:m:0:agent-${suffix}`,
    kind: 'tool-use',
    toolUseId: `toolu_agent_${suffix}`,
    toolName: 'Agent',
    toolFamily: 'agent',
    agentCompletion,
    input,
    status,
    result,
    children,
  }
}

test('P4-8c: an Agent card derives type/state/task from the row input + status (data-path honest)', () => {
  const html = render(
    agentRow('solo', { subagent_type: 'Explore', description: 'map the seam' }, 'pending'),
  )

  expect(html).toContain('explore') // worker type from input.subagent_type
  expect(html).toContain('map the seam') // the task, on line 2
  // Running reads as a pulsing face plus what the worker is doing — never a
  // lifecycle word, and never the ◆ AGENT family header the redesign removed.
  // The pulse is the only state left on the face; its colour is identity.
  expect(html).toContain('animate-face-pulse')
  expect(html).not.toContain('>Running<') // no visible word
  expect(html).not.toContain('◆')
})

test('P4-8c: a completed Agent card settles to a still face, with no word', () => {
  const html = render(
    agentRow('done', { subagent_type: 'Explore', description: 'done task' }, 'success'),
  )

  expect(html).not.toContain('>Completed<')
  // A settled card is completely still.
  expect(html).not.toContain('animate-face-pulse')
})

test('a failed card keeps its word and its tool calls, and drops the token figure', () => {
  const html = render(
    agentRow('boom', { subagent_type: 'Explore', description: 'audit' }, 'error', [], null, {
      isError: true,
      content: 'failed',
      diff: null,
      agentUsage: { totalTokens: 9100, toolUses: 6 },
    }),
  )

  expect(html).toContain('Failed') // one of the two states that keeps its word
  expect(html).toContain('6 tool calls')
  expect(html).not.toContain('9.1k tokens')
})

test('a stopped card keeps its word', () => {
  const html = render(
    {
      ...agentRow('halt', { agentId: 'agent-1', prompt: 'keep going' }, 'success', [], {
        status: 'killed',
        summary: null,
        result: null,
        usage: null,
      }),
      toolName: 'ResumeAgent',
    },
  )

  expect(html).toContain('Stopped')
})

/* ── the finished background agent (leak fix, 2026-08-01) ─────────────────── */

const ADA_COMPLETION: AgentCompletionProjection = {
  status: 'completed',
  summary: 'Agent @Ada completed',
  result: 'Sidebar lives in app/renderer/src/Sidebar.tsx',
  usage: { totalTokens: 12400, toolUses: 3, durationMs: 48000 },
}

test('a background agent card remains a launch record without completion output', () => {
  const html = render(
    agentRow(
      'bg',
      {
        subagent_type: 'Explore',
        description: 'find the sidebar owner',
        run_in_background: true,
      },
      'success',
      [],
      ADA_COMPLETION,
    ),
  )

  // `launched`: an ack, not a run under way. Teal-versus-blue on the face used
  // to carry that; it is a word now.
  expect(html).toContain('launched')
  expect(html).not.toContain('Result')
  expect(html).not.toContain('Sidebar lives in app/renderer/src/Sidebar.tsx')
  expect(html).not.toContain('~12.4k tokens')
  expect(html).not.toContain('Agent @Ada completed')
  expect(html).not.toContain('>In background<')
  expect(html).not.toContain('>Completed<')
})

test('a foreground agent card grows no result section, and offers no way to open one', () => {
  const html = render(
    agentRow('fg', { subagent_type: 'Explore', description: 'inline work' }, 'success'),
  )
  expect(html).not.toContain('Result')
  // No children and no separate completion means nothing to expand to, so the
  // card must not promise content it does not have.
  expect(html).not.toContain('aria-expanded')
  expect(html).not.toContain('<button')
})

test('a foreground agent card WITH children keeps the C4 collapsed default', () => {
  const html = render(
    agentRow('fgkids', { subagent_type: 'Explore', description: 'inline work' }, 'success', [
      toolRow({ toolName: 'Grep', toolFamily: 'grep', input: { pattern: 'x' }, status: 'success' }),
    ]),
  )
  expect(html).toContain('aria-expanded="false"')
})

/* ── a backgrounded agent's launch ack is not its finish (bug, 2026-08-05) ── */

test('a backgrounded agent is a neutral past-tense launch record without a lifecycle chip', () => {
  const html = render(
    agentRow(
      'launched',
      { subagent_type: 'Explore', description: 'audit launcher lifecycle claims', run_in_background: true },
      'success',
    ),
  )
  expect(html).toContain('launched')
  expect(html).not.toContain('>In background<')
  expect(html).not.toContain('>Completed<')
})

test('a backgrounded agent remains byte-stable in meaning if completion data is present', () => {
  const html = render(
    agentRow(
      'settled',
      { subagent_type: 'Explore', description: 'audit restore startup claims', run_in_background: true },
      'success',
      [],
      ADA_COMPLETION,
    ),
  )
  expect(html).toContain('launched')
  expect(html).not.toContain('>Completed<')
  expect(html).not.toContain('Sidebar lives in app/renderer/src/Sidebar.tsx')
})

test('background launch records do not form a stale lifecycle group', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        agentRow(
          'a',
          { subagent_type: 'Explore', description: 'audit A', run_in_background: true },
          'success',
        ),
        agentRow(
          'b',
          { subagent_type: 'Explore', description: 'audit B', run_in_background: true },
          'success',
        ),
      ]}
    />,
  )
  expect(html.match(/launched/g)).toHaveLength(2)
  expect(html).not.toContain('Running 2 Explore agents')
  expect(html).not.toContain('Delegate')
})

test('background launch records stay independent even if completion facts are present', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        agentRow(
          'a',
          { subagent_type: 'Explore', description: 'audit A', run_in_background: true },
          'success',
          [],
          ADA_COMPLETION,
        ),
        agentRow(
          'b',
          { subagent_type: 'Explore', description: 'audit B', run_in_background: true },
          'success',
          [],
          ADA_COMPLETION,
        ),
      ]}
    />,
  )
  expect(html.match(/launched/g)).toHaveLength(2)
  expect(html).not.toContain('Running 2 Explore agents')
  expect(html).not.toContain('Delegate')
})

test('an unmergeable completion renders one line, never the model-facing banner', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          ...blockSource,
          id: 's:m:0:task-notification',
          kind: 'task-notification',
          status: 'completed',
          summary: 'Agent @Ada completed',
          toolUseId: null,
          isReplay: false,
          children: [],
        },
      ]}
    />,
  )
  // Printed verbatim, with the worker's own name set in mono inside the line.
  // Bare: the engine's at-sign is the split's needle, never the reader's text.
  expect(html).toContain('Agent ')
  expect(html).toContain('>Ada</span>')
  expect(html).toContain(' completed')
  // The words the operator should never see again.
  for (const leaked of ['Task notification', 'Task ID', 'Output file', 'Tool use ID', 'Agent task']) {
    expect(html).not.toContain(leaked)
  }
  // No status chip beside a summary that already ends in its outcome.
  expect(html).not.toContain('>completed<')
})

test('a summary-less completion draws nothing at all', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          ...blockSource,
          id: 's:m:0:task-notification',
          kind: 'task-notification',
          status: 'completed',
          summary: null,
          toolUseId: null,
          isReplay: false,
          children: [],
        },
      ]}
    />,
  )
  expect(html).not.toContain('completed')
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

  // Nameless until the first nested frame carries an identity, so line 1 leads
  // with the fallback word and the type has to stand on its own.
  expect(html).toContain('AGENT')
  expect(html).toContain('explore')
  // The slot digests the children rather than counting them: while the worker
  // runs, that digest is its most recent nested tool call.
  expect(html).toContain('Grep foo')
  // C4: the child ROWS stay COLLAPSED — the header summarising them is not the
  // same as rendering them, so no nested row may leak top-level.
  expect(html).not.toContain('Search') // nested grep family word hidden
})

test('a finished Agent card leads with the worker NAME, taken from its own result frame', () => {
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate' }, 'success', [], null, {
      isError: false,
      content: 'done',
      diff: null,
      agentName: 'Ada',
    }),
  )
  expect(html).toContain('Ada')
  // The type stays as the qualifier beside it, never replaced by the name.
  expect(html).toContain('explore')
})

test('a running Agent card shows no name, because the transcript has not been told one', () => {
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate' }, 'pending'),
  )
  expect(html).toContain('explore')
  expect(html).toContain('AGENT') // the nameless fallback, until identity lands
  expect(html).not.toContain('Ada')
})

test('a running Agent card leads with the worker name carried by its nested progress frame', () => {
  const child = {
    ...toolRow({
      toolName: 'Grep',
      toolFamily: 'grep',
      input: { pattern: 'projectServerFrame' },
      status: 'pending',
    }),
    agentName: 'Ada',
  }
  const html = render(
    agentRow(
      'owner',
      { subagent_type: 'Explore', description: 'investigate' },
      'pending',
      [child],
    ),
  )
  expect(html).toContain('Ada')
  expect(html).toContain('explore')
})

test('a leading @ on the engine name is stripped before display', () => {
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate' }, 'success', [], null, {
      isError: false,
      content: 'done',
      diff: null,
      agentName: '@Ada',
    }),
  )
  expect(html).toContain('Ada')
  expect(html).not.toContain('@Ada')
})

test('a running Agent card with no nested call yet says so instead of going blank', () => {
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate' }, 'pending', []),
  )
  expect(html).toContain('starting')
})

test('a backgrounded agent never claims to be "starting" for its whole run', () => {
  // The async branch returns its launch ack before the code that yields nested
  // progress, so a background card has no children and nothing truthful to say.
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate', run_in_background: true }, 'success'),
  )
  expect(html).not.toContain('starting')
})

test('a resumed agent keeps settled usage in its result body, not its header', () => {
  const html = render(
    {
      ...agentRow('owner', { agentId: 'agent-1', prompt: 'investigate' }, 'success', [], {
        status: 'completed',
        summary: null,
        result: 'done',
        usage: { totalTokens: 12000, toolUses: 0, durationMs: 1000 },
      }, {
        isError: false,
        content: 'resumed',
        diff: null,
        agentName: 'Ada',
      }),
      toolName: 'ResumeAgent',
    },
  )
  expect(html.match(/~12\.0k tokens/g)).toHaveLength(1)
  expect(html).toContain('0 tools')
})

test('a resumed agent omits a missing token count from its result body', () => {
  const html = render(
    {
      ...agentRow('owner', { agentId: 'agent-1', prompt: 'investigate' }, 'success', [], {
        status: 'completed',
        summary: null,
        result: 'done',
        usage: { totalTokens: 0, toolUses: 55, durationMs: 1000 },
      }, {
        isError: false,
        content: 'resumed',
        diff: null,
        agentName: 'Ada',
      }),
      toolName: 'ResumeAgent',
    },
  )
  expect(html).toContain('55 tools')
  expect(html).not.toContain('0 tokens')
})

test('a finished FOREGROUND agent reports the totals off its own result', () => {
  // A foreground worker never produces a task-notification, so `agentCompletion`
  // is null and its own structured result is the only place its totals exist.
  // Counting nested rows cannot supply tokens at all, and supplies no calls
  // once a restore lands the branch outside the replayed window.
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate' }, 'success', [], null, {
      isError: false,
      content: 'done',
      diff: null,
      agentUsage: { totalTokens: 12000, toolUses: 7 },
    }),
  )
  expect(html).toContain('7 tool calls')
  expect(html).toContain('12.0k tokens')
})

test('the activity line never prints a tool name twice', () => {
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate' }, 'pending', [
      // `deriveTarget` falls back to the tool's own name for this family.
      toolRow({ toolName: 'TodoWrite', toolFamily: 'other', input: {}, status: 'pending' }),
    ]),
  )
  expect(html).toContain('TodoWrite')
  expect(html).not.toContain('TodoWrite TodoWrite')
})

test('a finished Agent card digests TOOL CALLS, never the prose rows mixed in', () => {
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate' }, 'success', [
      toolRow({
        toolName: 'Grep',
        toolFamily: 'grep',
        input: { pattern: 'foo' },
        status: 'success',
      }),
    ]),
  )
  expect(html).toContain('1 tool call')
  expect(html).not.toContain('1 tool calls')
  expect(html).not.toContain('nested')
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

  // The header names the set and closes with what has NOT settled. It can never
  // say finished while a member is still out, and the eyebrow + composed
  // "N agents finished" summary are gone.
  expect(html).toContain('2 explore workers')
  expect(html).toContain('2 still running')
  expect(html).not.toContain('Delegate')
  expect(html).not.toContain('finished')
  expect(html).toContain('audit A') // member A card
  expect(html).toContain('audit B') // member B card
})

test('the task is the only element on the card allowed to shrink', () => {
  const html = render(
    agentRow(
      'long',
      {
        subagent_type: 'Explore',
        description:
          'Trace the permission response path through the preload, the supervisor and the sidecar, and report which one validates the id',
      },
      'pending',
      [],
      null,
      { isError: false, content: 'x', diff: null, agentUsage: { totalTokens: 1000, toolUses: 2 } },
    ),
  )

  // One line, ellipsised, and it is the only `flex-1 min-w-0` on the card.
  expect(html).toContain('min-w-0 flex-1 truncate')
  expect(html.match(/min-w-0 flex-1 truncate/g)).toHaveLength(1)
  // Nothing else on line 2 may reflow around it.
  expect(html).toContain('shrink-0 whitespace-nowrap')
})

test('an unfamiliar 30-character subagent type does not break line 1', () => {
  const type = 'deeply-specialised-audit-agent'
  expect(type).toHaveLength(30)
  const html = render(
    agentRow('odd', { subagent_type: type, description: 'audit' }, 'pending'),
  )

  // Printed as configured (lowercased), never matched against a known set, and
  // never allowed to push the slot off the row.
  expect(html).toContain(type)
  expect(html).toContain('min-w-0 truncate font-mono text-[11px] lowercase')
})

test('a rejected resume has no identity line at all', () => {
  const html = render({
    ...agentRow('rej', { agentId: '@Ghost', prompt: 'pick this back up' }, 'success', [], null, {
      isError: false,
      content: JSON.stringify({
        success: false,
        message: 'No agent found with id agent_01H9Z4',
      }),
      diff: null,
    }),
    toolName: 'ResumeAgent',
  })

  // There is no worker to describe, so there is no face and no name — just the
  // hollow mark, the resume prompt, and the refusal under it. The green dot says
  // the CALL succeeded; only its answer was a refusal.
  expect(html).toContain('◇')
  expect(html).toContain('pick this back up')
  expect(html).toContain('No agent found with id agent_01H9Z4')
  expect(html).toContain('bg-tone-good')
  expect(html).not.toContain('shape-rendering')
  expect(html).not.toContain('AGENT')
})

test('a backgrounded launch says it launched and reports no outcome', () => {
  const html = render(
    agentRow(
      'bglaunch',
      { subagent_type: 'verification', description: 'sweep for stale references', run_in_background: true },
      'success',
      [],
      ADA_COMPLETION,
    ),
  )

  // `launched`, not `backgrounded`: this card only ever knew that the launch was
  // acknowledged. The two used to be told apart by teal versus blue on the face,
  // which the identity-colour ruling took away, so the distinction is a word now.
  expect(html).toContain('launched')
  expect(html).not.toContain('animate-face-pulse')
  expect(html).not.toContain('Completed')
  expect(html).not.toContain('Sidebar lives in app/renderer/src/Sidebar.tsx')
})

test('the pulse runs on a running face and on nothing else on the card', () => {
  const running = render(
    agentRow('p1', { subagent_type: 'Explore', description: 'live' }, 'pending'),
  )
  expect(running.match(/animate-face-pulse/g)).toHaveLength(1)
  expect(running).not.toContain('animate-pulse"')

  const settled = render(
    agentRow('p2', { subagent_type: 'Explore', description: 'done' }, 'success'),
  )
  expect(settled).not.toContain('animate-face-pulse')
})

test('the model closes line 2, in the vocabulary the rest of the app speaks', () => {
  const settled = render(
    agentRow('m1', { subagent_type: 'Explore', description: 'audit' }, 'success', [], null, {
      isError: false,
      content: 'done',
      diff: null,
      agentId: 'agent_1',
      agentModel: 'claude-sonnet-5-20260115',
    }),
  )
  expect(settled).toContain('Sonnet 5')
  expect(settled).not.toContain('claude-sonnet-5-20260115')

  // A RUNNING worker has no result yet, so the model comes off its own nested
  // frames instead.
  const live = render(
    agentRow('m2', { subagent_type: 'Explore', description: 'audit' }, 'pending', [
      {
        ...toolRow({ toolName: 'Grep', toolFamily: 'grep', input: { pattern: 'x' }, status: 'pending' }),
        model: 'gpt-5.6-luna',
      },
    ]),
  )
  expect(live).toContain('GPT-5.6 Luna')
})

test('a worker with no model stated says nothing about one', () => {
  const html = render(
    agentRow('m3', { subagent_type: 'Explore', description: 'audit' }, 'success'),
  )
  expect(html).not.toContain('Sonnet')
  expect(html).not.toContain('Unknown Model')
})

test('an image result never lends its model to an agent card', () => {
  // `model` is a generic key: ImageGen's own structured result names its model
  // too, and an ungated read would print it on the worker's line 2.
  const html = render(
    agentRow('m4', { subagent_type: 'Explore', description: 'audit' }, 'success', [], null, {
      isError: false,
      content: 'done',
      diff: null,
      generatedImage: {
        filePath: '/tmp/a.png',
        model: 'dall-e-3',
        size: '1024x1024',
        outputFormat: 'png',
        bytes: 10,
      },
    }),
  )
  expect(html).not.toContain('dall-e-3')
})

test('two named workers on screen never share a silhouette', () => {
  const named = (suffix: string, name: string) =>
    agentRow(suffix, { subagent_type: 'Explore', description: `job ${suffix}` }, 'pending', [
      {
        ...toolRow({
          toolName: 'Grep',
          toolFamily: 'grep',
          input: { pattern: suffix },
          status: 'pending',
        }),
        agentName: name,
      },
    ])
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[named('x', 'Scout'), named('y', 'Wick')]} />,
  )

  // Four stamps: the group header shows each worker once, and each member card
  // shows its own again. TWO distinct silhouettes, one per worker — a worker
  // wears the same face everywhere it appears, and no two workers share one.
  const stamps = [...html.matchAll(/<svg[^>]*>(.*?)<\/svg>/g)].map(match => match[1])
  expect(stamps).toHaveLength(4)
  expect(new Set(stamps).size).toBe(2)
})

test('a resume card is nameless, because the engine never tells it a name', () => {
  // §0 flag — 🔁 deferred(resume identity). The design shows a resumed worker
  // wearing its own name in its own subagent-type colour. Neither fact reaches
  // this card: `ResumeAgentTool`'s structured result is `{success, message}`
  // (`src/tools/ResumeAgentTool/ResumeAgentTool.tsx:38-39`), a resume runs in
  // the background so no nested frame carries `agent_name` here, and the input
  // is an agentId plus a prompt with no `subagent_type`. Closing this needs a
  // new field on the resume result, which is an engine/protocol change.
  const html = render({
    ...agentRow('anon-resume', { agentId: '@Ramanujan', prompt: 'carry on' }, 'success', [], {
      status: 'completed',
      summary: null,
      result: 'done',
      usage: null,
    }, {
      isError: false,
      content: JSON.stringify({ success: true, message: 'Resumed "@Ramanujan".' }),
      diff: null,
    }),
    toolName: 'ResumeAgent',
  })

  expect(html).toContain('AGENT')
  expect(html).toContain('resumed')
  expect(html).toContain('carry on')
  expect(html).not.toContain('text-sky-300')
})

test('a background launch that errored reads as failed, not as backgrounded', () => {
  // `deriveAgentToolState` gives a launch record with an errored tool_result the
  // `failed` state. The card used to override the slot on the RECORD shape, so
  // it said "backgrounded" in the slot, drew a teal face, and printed "Failed"
  // on line 2 — three different claims about one worker.
  const html = render(
    agentRow(
      'bgfail',
      { subagent_type: 'Explore', description: 'audit', run_in_background: true },
      'error',
      [],
      null,
      { isError: true, content: 'boom', diff: null, agentUsage: { totalTokens: 900, toolUses: 2 } },
    ),
  )

  // A launch whose ack came back an error is a failure and has to read as one.
  // It used to be told by the face going danger-red instead of teal; the word is
  // the carrier now, and the slot must not still claim the worker launched.
  expect(html).toContain('Failed')
  expect(html).not.toContain('launched')
  expect(html).not.toContain('backgrounded')
  expect(html).toContain('2 tool calls')
  expect(html).not.toContain('900 tokens')
})

test('a stopped worker shows tool calls and no token figure, like a failed one', () => {
  const html = render(
    {
      ...agentRow('halted', { agentId: 'agent-1', prompt: 'keep going' }, 'success', [], {
        status: 'killed',
        summary: null,
        result: null,
        usage: null,
      }, {
        isError: false,
        content: 'x',
        diff: null,
        agentUsage: { totalTokens: 4200, toolUses: 4 },
      }),
      toolName: 'ResumeAgent',
    },
  )

  expect(html).toContain('Stopped')
  expect(html).toContain('4 tool calls')
  expect(html).not.toContain('4.2k tokens')
})

test('two workers under one handle draw two faces, through the real render path', () => {
  // The test that would have caught the id never reaching the card: every
  // registry test calls `faceFor` directly with literal ids, so none of them
  // touch `agentToolSourceOf`, which is where the id has to be copied off the
  // result for any of it to run.
  const settled = (suffix: string, agentId: string): NestedToolUseRow =>
    agentRow(suffix, { subagent_type: 'Explore', description: 'x' }, 'success', [], null, {
      isError: false,
      content: 'done',
      diff: null,
      agentName: 'scout',
      agentId,
    } as ToolResultProjection)
  // The face is the 9x9 svg; a card can carry other icons.
  const stamps = (html: string) =>
    [...html.matchAll(/<svg[^>]*viewBox="0 0 9 9"[^>]*>(.*?)<\/svg>/g)].map(m => m[1])

  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[settled('one', 'agent_aaa'), settled('two', 'agent_bbb')]} />,
  )
  // Four stamps, not two: two sibling Agent rows form a delegate group, whose
  // header stacks a face per member above the cards themselves. Two DISTINCT
  // stamps is the property. Keyed on the name it would be one.
  expect(stamps(html)).toHaveLength(4)
  expect(new Set(stamps(html)).size).toBe(2)
})

test('a worker draws the same stamp whatever it is doing', () => {
  // 2026-08-21: the face is identity. A backgrounded worker used to withhold its
  // whole front, which is what made a fan-out of five render as five blank slabs.
  const live = render(
    agentRow('same', { subagent_type: 'Explore', description: 'x' }, 'pending'),
  )
  const background = render(
    agentRow('same', { subagent_type: 'Explore', description: 'x', run_in_background: true }, 'success'),
  )
  const stamp = (html: string) => /<svg[^>]*>(.*?)<\/svg>/.exec(html)?.[1] ?? ''

  expect(stamp(live).length).toBeGreaterThan(0)
  expect(stamp(live)).toBe(stamp(background))
})

test('the card never puts a div inside its collapse button', () => {
  // Only phrasing content may live in a `button`; React does not warn and
  // browsers render it anyway, so nothing else would catch this.
  const html = render(
    agentRow('btn', { subagent_type: 'Explore', description: 'x' }, 'pending', [
      toolRow({ toolName: 'Grep', toolFamily: 'grep', input: { pattern: 'x' }, status: 'pending' }),
    ]),
  )
  const button = /<button[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? ''

  expect(button.length).toBeGreaterThan(0)
  expect(button).not.toContain('<div')
})

test('the finish row keeps a multi-word worker name whole', () => {
  // Engine names may contain spaces (`normalizeExplicitSubagentName` rejects
  // only @, : and *). A `\\S+` capture read "Ada Lovelace" as "Ada", which gave
  // the finish row a different face from the worker's card and left a stray
  // " Lovelace completed" in body text.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          ...blockSource,
          id: 's:m:0:task-notification',
          kind: 'task-notification',
          status: 'completed',
          summary: 'Agent @Ada Lovelace completed',
          toolUseId: null,
          isReplay: false,
          children: [],
        },
      ]}
    />,
  )

  expect(html).toContain('>Ada Lovelace<')
  expect(html).not.toContain('>Ada<')
})

test('a face drawn in the transcript comes from the shell registry, not a private one', () => {
  // The registry is mounted at the shell so the transcript and the docked
  // surfaces agree about every worker. A transcript that minted its own would
  // dedupe against a different set and hand the same worker a second colour on
  // the roster.
  //
  // The discriminator is colour. Ada's hashed colour is claimed here by another
  // worker first, so a SHARED registry must move her off it; a private registry
  // would have nothing taken and would hand her the hashed one.
  const registry = createAgentFaceRegistry()
  const hashedFill = faceHash('Ada', 8) % FACE_FILL_COUNT
  for (let index = 0; index < FACE_FILL_COUNT; index += 1) {
    if (registry.faceFor(`squatter-${index}`).fill === hashedFill) break
  }
  const shared = registry.faceFor(null, 'Ada')
  expect(shared.fill).not.toBe(hashedFill)

  const html = renderToStaticMarkup(
    <AgentFaceRegistryContext.Provider value={registry}>
      <TranscriptRowsView
        rows={[
          {
            ...blockSource,
            id: 's:m:0:task-notification',
            kind: 'task-notification',
            status: 'completed',
            summary: 'Agent @Ada completed',
            toolUseId: null,
            isReplay: false,
            children: [],
          },
        ]}
      />
    </AgentFaceRegistryContext.Provider>,
  )

  expect(html).toContain(AGENT_FACE_IDENTITY_FILL[shared.fill])
  expect(html).not.toContain(AGENT_FACE_IDENTITY_FILL[hashedFill])
})

test('the finish row highlights the name, and prints no at-sign anywhere', () => {
  // The at-sign has two jobs on this row and only one of them is the reader's:
  // it is the needle that finds the name inside the ENGINE's own sentence, and
  // it used to be rendered as well. Dropping it from the needle would silently
  // stop the split matching, leaving the sentence whole and the name unmarked
  // with nothing failing. Both halves are asserted here.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          ...blockSource,
          id: 's:m:0:task-notification',
          kind: 'task-notification',
          status: 'completed',
          summary: 'Agent @Ada completed',
          toolUseId: null,
          isReplay: false,
          children: [],
        },
      ]}
    />,
  )

  // Split still happened: the name is its own marked span, and the engine's
  // sentence is no longer one unbroken run of text.
  expect(html).toContain('>Ada</span>')
  expect(html).toContain('Agent ')
  expect(html).toContain(' completed')
  expect(html).not.toContain('Agent @Ada completed')
  expect(html).not.toContain('@')
})

test('a finish row the engine worded differently still draws, with no face claimed', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          ...blockSource,
          id: 's:m:0:task-notification',
          kind: 'task-notification',
          status: 'completed',
          // The engine's own no-name fallback shape.
          summary: 'Agent "sweep the renderer" completed',
          toolUseId: null,
          isReplay: false,
          children: [],
        },
      ]}
    />,
  )

  expect(html).toContain('sweep the renderer')
  expect(html).toContain('shape-rendering') // featureless stamp, still drawn
  expect(html).not.toContain('font-mono text-[#e4e4e7]') // nothing claimed as a handle
})

test('a worker card names the Codex account its lease holds', () => {
  // The join needs no new field on either side: `LeaseOwnerRow.ownerId` IS the
  // subagent's agentId (protocol.ts JOIN KEY), and the Agent tool's structured
  // result carries that same agentId on both the sync and the background paths.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      leases={{
        strategy: 'spread',
        accounts: [],
        owners: [
          {
            leaseId: 'agent_backus',
            ownerId: 'agent_backus',
            ownerType: 'subagent',
            ownerLabel: 'Trace desktop runtime state',
            accountId: '0f9c1d22-aaaa-bbbb-cccc-1234567890ab',
            accountAlias: 'onbi',
            strategy: 'spread',
            state: 'active',
            createdAt: 1,
            updatedAt: 1,
            failoverCount: 0,
            selectionKind: 'initial',
            selectionReason: 'initial pick',
          },
        ],
      }}
      rows={[
        agentRow(
          'leased',
          { subagent_type: 'general-purpose', description: 'Trace desktop runtime state', run_in_background: true },
          'success',
          [],
          null,
          {
            isError: false,
            content: 'launched',
            diff: null,
            agentId: 'agent_backus',
            agentModel: 'gpt-5.6-sol',
          },
        ),
      ]}
    />,
  )

  expect(html).toContain('onbi')
  expect(html).toContain('GPT-5.6 Sol')
  // The redacted alias, never the raw account UUID.
  expect(html).not.toContain('0f9c1d22-aaaa-bbbb-cccc-1234567890ab')
})

test('a finished worker still names its account, with no lease left to join', () => {
  // The defect this closes: the account was a LIVE join only, and the engine
  // DELETES a worker's lease at its terminal. Every finished worker, and every
  // restored transcript, therefore answered null — the card went blank exactly
  // when a reader went looking. `leases` is null here on purpose: that is the
  // state after the worker finished.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      leases={null}
      rows={[
        agentRow(
          'settled',
          { subagent_type: 'general-purpose', description: 'Trace desktop runtime state' },
          'success',
          [],
          null,
          {
            isError: false,
            content: 'done',
            diff: null,
            agentId: 'agent_backus',
            agentModel: 'gpt-5.6-sol',
            agentAccount: {
              accountId: '0f9c1d22-aaaa-bbbb-cccc-1234567890ab',
              accountAlias: 'onbi',
            },
          },
        ),
      ]}
    />,
  )

  expect(html).toContain('onbi')
  expect(html).not.toContain('0f9c1d22-aaaa-bbbb-cccc-1234567890ab')
})

test('a live lease outranks the stamp, which can only be dispatch-time', () => {
  // The two can disagree for exactly one reason: a background worker's stamp is
  // written at dispatch and its row can never be amended, so a lease that moved
  // mid-run is only knowable from the live plane. Live therefore wins while it
  // exists.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      leases={{
        strategy: 'spread',
        accounts: [],
        owners: [
          {
            leaseId: 'agent_moved',
            ownerId: 'agent_moved',
            ownerType: 'subagent',
            ownerLabel: 'work',
            accountId: 'account-after',
            accountAlias: 'after',
            strategy: 'spread',
            state: 'active',
            createdAt: 1,
            updatedAt: 1,
            failoverCount: 1,
            selectionKind: 'failover',
            selectionReason: 'failover',
          },
        ],
      }}
      rows={[
        agentRow(
          'moved',
          { subagent_type: 'general-purpose', description: 'work', run_in_background: true },
          'success',
          [],
          null,
          {
            isError: false,
            content: 'launched',
            diff: null,
            agentId: 'agent_moved',
            agentAccount: { accountId: 'account-before', accountAlias: 'before' },
          },
        ),
      ]}
    />,
  )

  expect(html).toContain('after')
  expect(html).not.toContain('before')
})

test('an un-aliased account is named by a short id, never a whole UUID', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      leases={{
        strategy: 'spread',
        accounts: [],
        owners: [
          {
            leaseId: 'agent_x',
            ownerId: 'agent_x',
            ownerType: 'subagent',
            ownerLabel: 'work',
            accountId: '0f9c1d22-aaaa-bbbb-cccc-1234567890ab',
            accountAlias: null,
            strategy: 'spread',
            state: 'active',
            createdAt: 1,
            updatedAt: 1,
            failoverCount: 0,
            selectionKind: 'initial',
            selectionReason: 'initial pick',
          },
        ],
      }}
      rows={[
        agentRow('unaliased', { subagent_type: 'Explore', description: 'work' }, 'success', [], null, {
          isError: false,
          content: 'done',
          diff: null,
          agentId: 'agent_x',
        }),
      ]}
    />,
  )

  expect(html).toContain('0f9c1d22')
  expect(html).not.toContain('0f9c1d22-aaaa')
})

test('a session with no lease plane says nothing about an account', () => {
  // The ordinary case on an Anthropic-path session, on a worker that has not made
  // a request yet, and on any restored transcript — the lease map is per-process
  // and dies with its engine. Absent, never a blank slot or an empty separator.
  const html = render(
    agentRow('noleases', { subagent_type: 'Explore', description: 'work' }, 'success', [], null, {
      isError: false,
      content: 'done',
      diff: null,
      agentId: 'agent_y',
      agentModel: 'claude-sonnet-5',
    }),
  )

  expect(html).toContain('Sonnet 5')
  // No hairline: it only earns its place between two things.
  expect(html).not.toContain('w-px')
})

test('a card names the account WHILE a foreground worker is still running', () => {
  // The case the stamp design ruled unreachable: a foreground worker's agentId
  // arrives with its RESULT, so the agentId join cannot answer until the run is
  // over. Both planes already carry the description, though — the engine
  // registers the lease under it (`AgentTool.tsx:1502`) and the row holds it as
  // `input.description` — so the running card can name the account after all.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      leases={{
        strategy: 'spread',
        accounts: [],
        owners: [
          {
            leaseId: 'af5c4971',
            ownerId: 'af5c4971',
            ownerType: 'subagent',
            ownerLabel: 'Repair typed SDK error contract',
            accountId: '93ce612e-1315-4466-859d-be060ef879be',
            accountAlias: 'bluesky',
            strategy: 'spread',
            state: 'active',
            createdAt: 1,
            updatedAt: 1,
            failoverCount: 0,
            selectionKind: 'initial',
            selectionReason: 'initial pick',
          },
        ],
      }}
      rows={[
        // RUNNING: no result at all, which is the whole point.
        agentRow(
          'running',
          { subagent_type: 'implementor', description: 'Repair typed SDK error contract' },
          'pending',
        ),
      ]}
    />,
  )

  expect(html).toContain('bluesky')
  // Still the redacted alias, never the raw account UUID.
  expect(html).not.toContain('93ce612e-1315-4466-859d-be060ef879be')
})

test('a running card stays silent when two workers share one description', () => {
  // Ambiguity resolves to silence, not to a guess: naming the wrong account is
  // worse than naming none, and null is what the card already renders as absent.
  const owner = (id: string, alias: string) => ({
    leaseId: id,
    ownerId: id,
    ownerType: 'subagent' as const,
    ownerLabel: 'run the battery',
    accountId: `acct-${id}`,
    accountAlias: alias,
    strategy: 'spread' as const,
    state: 'active' as const,
    createdAt: 1,
    updatedAt: 1,
    failoverCount: 0,
    selectionKind: 'initial' as const,
    selectionReason: 'initial pick',
  })
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      leases={{
        strategy: 'spread',
        accounts: [],
        owners: [owner('agent_a', 'bluesky'), owner('agent_b', 'onbi')],
      }}
      rows={[
        agentRow('ambiguous', { subagent_type: 'Explore', description: 'run the battery' }, 'pending'),
      ]}
    />,
  )

  expect(html).not.toContain('bluesky')
  expect(html).not.toContain('onbi')
})

test('P4-8c: the Agent card + DelegateGroup emit only static tone utilities (no interpolated/arbitrary classes)', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        agentRow('a', { subagent_type: 'Explore', description: 'x' }, 'pending', [
          { ...toolRow({ toolName: 'Grep', toolFamily: 'grep', input: { pattern: 'q' }, status: 'pending' }), agentName: 'Ada' },
        ]),
        agentRow('b', { subagent_type: 'Explore', description: 'y' }, 'pending'),
      ]}
    />,
  )

  // Static utilities from the 8a tone maps actually reach the DOM (a dynamic
  // `text-[${hex}]`/`fill-[${hex}]` would silently never generate — the P4-9 trap).
  expect(html).toContain('text-blue-400') // live slot tone (AGENT_STATE_TONE_CLASS.info)
  expect(html).toMatch(/class="shrink-0 fill-[a-z]+-300/) // identity face fill
  expect(html).toContain('text-sky-300') // Explore type tone on the NAME (AGENT_TYPE_TONE_CLASS.sky)
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

test('an injected turn renders system-side — never in the operator user column', () => {
  // The bug this closes: `coordinator`/`channel`/`teammate`/`deferred-continuation`
  // all carry role:'user' and rendered inside the right-aligned accent bubble,
  // i.e. as if the operator had typed them.
  const cases: Array<[string, string | null, string, string]> = [
    ['coordinator', null, 'Coordinator', 'coordinator'],
    ['channel', 'slack · dana', 'slack · dana', 'channel'],
    ['teammate', 'scout', '@scout', 'teammate'],
    ['deferred-continuation', null, 'Continuation', 'continuation'],
    // A kind from a newer engine: still attributed away from the operator.
    ['future-kind-2027', null, 'Injected message', 'injected'],
  ]
  for (const [injectedKind, label, expectedHeading, rawTag] of cases) {
    const html = render({
      ...blockSource,
      id: `s:m:0:injected-${injectedKind}`,
      kind: 'injected-turn',
      injectedKind,
      label,
      content: 'a message the operator did not write',
      isReplay: false,
    })
    expect(html).toContain('a message the operator did not write')
    expect(html).toContain(expectedHeading)
    expect(html).not.toContain(`>${rawTag}<`)
    // The user-bubble grammar (UserBubble/CommandEchoBubble/UserImageRowView)
    // is right-aligned + accent-tinted; an injected row must use neither.
    expect(html).not.toContain('justify-end')
    expect(html).not.toContain('bg-accent/10')
  }
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

test('P4-18a/#7: the blocks mode renders a thinking row as an expanded markdown block', () => {
  const html = renderRows(
    [
      {
        ...blockSource,
        id: 's:m:0:thinking',
        kind: 'thinking',
        content: 'weighing the **socket** options',
        reasoningKind: 'summary',
      },
    ],
    'blocks',
  )

  expect(html).toContain('Thinking')
  // #7: the reasoning body renders through the markdown path — **bold** becomes
  // <strong>, not literal asterisks.
  expect(html).toContain('<strong>socket</strong>')
  expect(html).not.toContain('**socket**')
  // #7: the "summary" reasoningKind sub-label was removed.
  expect(html).not.toContain('summary')
})

test('P4-18a: the blocks mode renders a redacted-thinking placeholder', () => {
  const html = renderRows(
    [
      {
        ...blockSource,
        id: 's:m:0:redacted-thinking',
        kind: 'redacted-thinking',
        data: 'ENCRYPTED',
      },
    ],
    'blocks',
  )

  expect(html).toContain('redacted by the model provider')
  // The encrypted payload must never be printed.
  expect(html).not.toContain('ENCRYPTED')
})

test('trail mode: a lone reasoning summary is ONE labelled line, not a card', () => {
  const html = render(
    thinkingRow('s:m:0:thinking', 'Locating the transport teardown path'),
  )

  expect(html).toContain('Reasoning')
  expect(html).toContain('Locating the transport teardown path')
  // No run head: a single summary has no step count and nothing to collapse.
  expect(html).not.toContain('steps')
  expect(html).not.toContain('aria-expanded')
  // Not the blocks treatment: no accent-tinted card frame around four words.
  expect(html).not.toContain('border-accent/15')
})

test('trail mode: a summary heading renders its Markdown emphasis', () => {
  const html = render(thinkingRow('s:m:0:thinking', 'weighing the **socket** options'))

  // Summary headings are compact, but must not expose model-authored Markdown
  // delimiters to the user.
  expect(html).toContain('<strong>socket</strong>')
  expect(html).not.toContain('**socket**')
})

test('trail mode: every heading in a reasoning run renders inline Markdown', () => {
  const html = renderRows(
    [
      thinkingRow('s:m:0:thinking', '**Checking** the transport'),
      thinkingRow('s:m:1:thinking', '_Ordering_ the close frame'),
    ],
    'trail',
  )

  expect(html).toContain('<strong>Checking</strong>')
  expect(html).toContain('<em>Ordering</em>')
  expect(html).not.toContain('**Checking**')
  expect(html).not.toContain('_Ordering_')
})

test('trail mode: adjacent reasoning rows coalesce into ONE run with a step count', () => {
  const html = renderRows(
    [
      thinkingRow('s:m:0:thinking', 'Checking close-frame ordering'),
      thinkingRow('s:m:1:thinking', 'Considering the early-abort path'),
      thinkingRow('s:m:2:thinking', 'Planning a focused test run'),
    ],
    'trail',
  )

  expect(html).toContain('3 steps')
  // One head for the run, not one per summary.
  expect(occurrences(html, 'Reasoning')).toBe(1)
  expect(html).toContain('Checking close-frame ordering')
  expect(html).toContain('Considering the early-abort path')
  expect(html).toContain('Planning a focused test run')
})

test('trail mode: an encrypted-only step drops out of a mixed run, payload never printed', () => {
  const html = renderRows(
    [
      thinkingRow('s:m:0:thinking', 'Acknowledging correction on summary display'),
      {
        ...blockSource,
        id: 's:m:1:redacted-thinking',
        kind: 'redacted-thinking',
        data: 'ENCRYPTED',
      },
    ],
    'trail',
  )

  // Only the readable step is left, so it draws as a lone line with no count.
  expect(html).not.toContain('steps')
  expect(html).toContain('Acknowledging correction on summary display')
  expect(html).not.toContain('reasoning not shared by the provider')
  expect(html).not.toContain('ENCRYPTED')
})

test('trail mode: a lone encrypted-only block renders nothing, no placeholder and no payload', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:redacted-thinking',
    kind: 'redacted-thinking',
    data: 'ENCRYPTED',
  })

  expect(html).not.toContain('reasoning not shared by the provider')
  expect(html).not.toContain('ENCRYPTED')
  expect(html).not.toContain('steps')
  expect(html).not.toContain('Reasoning')
})

test('trail mode: a long-form reasoning body keeps its prose, on the trail', () => {
  const long = `The transcript keys thinking rows by message id and block index, which is a sentence long enough that it is plainly reasoning text rather than a heading label.

Which means two consecutive **summary** blocks already produce two distinct rows.`
  const html = render(thinkingRow('s:m:0:thinking', long))

  // A prose step: the trail head with no step count, and the markdown body.
  expect(html).toContain('Reasoning')
  expect(html).toContain('<strong>summary</strong>')
  expect(html).not.toContain('steps')
})

test('trail mode: the adapter\'s "\\n\\n"-merged headings become one step each', () => {
  // The common Codex turn: several summary parts merged into ONE thinking block
  // (codex-fetch-adapter.ts:2018-2031), which must still read as a trail.
  const html = render(
    thinkingRow(
      's:m:0:thinking',
      'Locating the teardown path\n\nChecking close-frame ordering\n\nPlanning a test run',
    ),
  )

  expect(html).toContain('3 steps')
  expect(html).toContain('Locating the teardown path')
  expect(html).toContain('Checking close-frame ordering')
  expect(html).toContain('Planning a test run')
})

test('an empty-bodied thinking row renders nothing in trail, redacted in blocks', () => {
  // Encrypted-only reasoning reaches the app as `thinking` with an empty body
  // carrying the signature (codex-fetch-adapter.ts:2229). Trail has nothing
  // readable to draw, so it draws nothing; blocks keeps its own placeholder card.
  const trail = render(thinkingRow('s:m:0:thinking', ''))
  expect(trail).not.toContain('reasoning not shared by the provider')
  expect(trail).not.toContain('steps')
  expect(trail).not.toContain('Reasoning')

  const blocks = renderRows([thinkingRow('s:m:0:thinking', '')], 'blocks')
  expect(blocks).toContain('redacted by the model provider')
})

test('trail mode: an all-withheld run renders nothing — no head asserting steps', () => {
  const html = renderRows(
    [
      { ...blockSource, id: 's:m:0:r', kind: 'redacted-thinking', data: 'ENCRYPTED' },
      { ...blockSource, id: 's:m:1:r', kind: 'redacted-thinking', data: 'ENCRYPTED' },
    ],
    'trail',
  )

  expect(html).not.toContain('reasoning not shared by the provider')
  expect(html).not.toContain('steps')
  expect(html).not.toContain('aria-expanded')
  expect(html).not.toContain('ENCRYPTED')
  expect(html).not.toContain('Reasoning')
})

test('trail mode: a long run shows every step, with nothing folded away', () => {
  const html = renderRows(
    Array.from({ length: 7 }, (_, index) =>
      thinkingRow(`s:m:${index}:thinking`, `Step number ${index}`),
    ),
    'trail',
  )

  expect(html).toContain('7 steps')
  expect(html).not.toContain('earlier')
  for (let index = 0; index < 7; index += 1) {
    expect(html).toContain(`Step number ${index}`)
  }
})

test('trail mode: a long member inside a run keeps its prose under its own step', () => {
  const long = `A body long enough to be real reasoning rather than a heading label, carrying **emphasis** across more than one hundred and forty characters of text.`
  const html = renderRows(
    [thinkingRow('s:m:0:thinking', long), thinkingRow('s:m:1:thinking', 'Settling on a boxless trail')],
    'trail',
  )

  expect(html).toContain('2 steps')
  expect(html).toContain('<strong>emphasis</strong>')
  expect(html).toContain('Settling on a boxless trail')
})

test('blocks mode: adjacent reasoning rows stay separate blocks, never grouped', () => {
  const html = renderRows(
    [
      thinkingRow('s:m:0:thinking', 'Checking close-frame ordering'),
      thinkingRow('s:m:1:thinking', 'Considering the early-abort path'),
    ],
    'blocks',
  )

  expect(occurrences(html, 'Thinking')).toBe(2)
  expect(html).not.toContain('steps')
})

// P4-23 (operator, 2026-07-09): the ✦ "Session started" banner row was removed.
// The init frame still runs (it captures the P3-7 slash catalog — see
// transcriptProjector.test.ts) but emits no transcript row, so there is no
// SessionInitBanner render case to test here anymore.

test('P4-60/#6: a successful result row renders no turn-footer', () => {
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

  // #6 (operator, 2026-07-19): the success `Completed · Ns · $…` footer was
  // removed entirely — a completed turn surfaces no seam.
  expect(html).not.toContain('Completed')
  expect(html).not.toContain('4.2s')
  expect(html).not.toContain('$0.0123')
})

test.each([
  ['error_max_turns', 'Stopped · max turns reached'],
  ['error_max_budget_usd', 'Stopped · budget limit reached'],
  [
    'error_max_structured_output_retries',
    'Stopped · max output retries',
  ],
] as const)('P4-60: %s retains its result seam', (subtype, label) => {
  const html = render({
    ...frameSource,
    id: `s:f:result:${subtype}`,
    kind: 'result',
    subtype,
    isError: true,
    errors: ['Detailed failure text stays outside the label-only seam'],
    durationMs: 4200,
    totalCostUsd: 0.0123,
  })

  expect(html).toContain(label)
  expect(html).toContain('4.2s')
  expect(html).toContain('$0.0123')
  expect(html).not.toContain('Detailed failure text')
})

test('renders the stopped seam without a user interruption body', () => {
  const html = render({
    ...frameSource,
    id: 's:f:stopped',
    kind: 'turn-stopped',
  })

  expect(html).toContain('Stopped')
  expect(html).not.toContain('interruption')
})

test('renders curated auth and execution failures without raw errors', () => {
  const auth = render({
    ...frameSource,
    id: 's:f:auth',
    kind: 'result',
    subtype: 'error_auth_required',
    isError: true,
    errors: ['OAuth access token has been revoked'],
  })
  const execution = render({
    ...frameSource,
    id: 's:f:execution',
    kind: 'result',
    subtype: 'error_during_execution',
    isError: true,
    errors: ['provider stack trace'],
  })

  expect(auth).toContain('Sign-in expired')
  expect(auth).toContain('Sign in again in Accounts to continue.')
  expect(auth).not.toContain('OAuth access token has been revoked')
  expect(execution).toContain('This turn could not finish')
  expect(execution).toContain('save a diagnostics bundle')
  expect(execution).not.toContain('provider stack trace')
})

test('P4-60: an unknown error subtype renders a generic failure label', () => {
  const html = render({
    ...frameSource,
    id: 's:f:result:future-error',
    kind: 'result',
    subtype: 'error_future_subtype',
    isError: true,
    errors: [],
  })

  expect(html).toContain('Turn failed')
  expect(html).not.toContain('Completed')
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

test('P4-18a: a system-notice row renders the notice box, never its raw type', () => {
  const html = render({
    ...frameSource,
    id: 's:f:system-notice',
    kind: 'system-notice',
    noticeType: 'api_retry',
    content: 'retrying after 429',
  })

  expect(html).toContain('retrying after 429')
  expect(html).toContain('↻') // the glyph is what distinguishes the three types
  // P4-45: the discriminant used to print in the corner of the most-read
  // surface in the app. It is a debug tag (CLAUDE.md §7).
  expect(html).not.toContain('api_retry')
})

test('P4-45: no notice type prints its discriminant', () => {
  for (const noticeType of [
    'api_retry',
    'local_command_output',
    'account_diagnostic',
  ] as const) {
    const html = render({
      ...frameSource,
      // NOT `s:f:${noticeType}`: the row's id is published as its wrapper's
      // identity for the scroll memory, so a fixture id built out of the
      // discriminant would fail this test on its own fixture rather than on
      // anything the component printed.
      id: 's:f:system-notice',
      kind: 'system-notice',
      noticeType,
      content: 'something happened',
    })

    expect(html).toContain('something happened')
    expect(html).not.toContain(noticeType)
  }
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

// Per-quote copy control: `dequote` recovers the plain, paste-ready message a
// blockquote wraps from the RAW markdown source at the node's position, not
// from the parsed <p>/<li> tree — the case that motivated it is a suggested
// message with a bulleted list embedded in the quote, where flattening
// already-rendered elements would run every line together.

test('dequote strips the leading marker off a single-paragraph quote', () => {
  const source = 'Here:\n\n> Ship the fix today.\n'
  const start = source.indexOf('>')
  const end = source.indexOf('\n', start)
  expect(dequote(source, { start: { offset: start }, end: { offset: end } })).toBe(
    'Ship the fix today.',
  )
})

test('dequote preserves paragraph breaks and list bullets, not just the quote markers', () => {
  const source = [
    '> First paragraph.',
    '>',
    '> Please record:',
    '>',
    '> - one item',
    '> - two item',
  ].join('\n')
  expect(dequote(source, { start: { offset: 0 }, end: { offset: source.length } })).toBe(
    ['First paragraph.', '', 'Please record:', '', '- one item', '- two item'].join(
      '\n',
    ),
  )
})

test('dequote returns empty text when the node carries no position', () => {
  expect(dequote('> quoted', undefined)).toBe('')
  expect(dequote('> quoted', { start: {}, end: {} })).toBe('')
})

// ── Output-line tint: the prototype's `logLineColor`, and the two drifts off it
// that made tool output read as colorless. The hues are the prototype's 300-level
// pastels (`Messages.jsx:212-218`), NOT the `--tone-*` 400s this returned before:
// the prototype reserves those for signs/dots (`Messages.jsx:182` body vs `:186`
// sign), so painting body text with them read muddy against `#09090b`.

test('output lines take the prototype logLineColor pastel for their own semantics', () => {
  expect(logLineClass('ERROR: boom')).toBe('text-[#fca5a5]')
  expect(logLineClass('npm ERR! install failed')).toBe('text-[#fca5a5]')
  expect(logLineClass('WARNING: cache exceeded')).toBe('text-[#fcd34d]')
  expect(logLineClass('PASS src/thing.test.ts')).toBe('text-[#86efac]')
  expect(logLineClass('✓ 100 pass')).toBe('text-[#86efac]')
  // Stack/trace continuation lines recede rather than reading as ordinary output.
  expect(logLineClass('    at Object.<anonymous>')).toBe('text-text-faint')
  expect(logLineClass('  > bun run build')).toBe('text-text-faint')
  // Anything unclassified stays the resting body grey.
  expect(logLineClass('src/index.ts')).toBe('text-text-muted')
})

test('splitGrepLine takes both separators and leaves everything else alone', () => {
  expect(splitGrepLine('src/a.ts:25:const x = 1')).toEqual({
    locator: 'src/a.ts:25:',
    path: 'src/a.ts',
    body: 'const x = 1',
  })
  // Context lines from -A/-B/-C use `-`, and are most of a search with context.
  expect(splitGrepLine('src/a.ts-26-  return x')).toEqual({
    locator: 'src/a.ts-26-',
    path: 'src/a.ts',
    body: '  return x',
  })
  // Non-greedy: a path with its own dash must not swallow the line number.
  expect(splitGrepLine('src/my-file.ts:9:hit')).toEqual({
    locator: 'src/my-file.ts:9:',
    path: 'src/my-file.ts',
    body: 'hit',
  })
  // Shapes that are not a locator render untouched.
  expect(splitGrepLine('--')).toBeNull()
  expect(splitGrepLine('src/a.ts')).toBeNull()
  expect(splitGrepLine('3 files matched')).toBeNull()
})

// The prototype's fixtures never contained a COUNT line, so the ported rules
// missed the summary every real runner ends with. These are verbatim `bun test`
// lines — the exact case the operator reported as "still looks the same".
test('a real test summary is colored: counts, not keywords', () => {
  expect(logLineClass(' 18 pass')).toBe('text-[#86efac]')
  expect(logLineClass(' 3 fail')).toBe('text-[#fca5a5]')
  expect(logLineClass('2 passed')).toBe('text-[#86efac]')
  expect(logLineClass('1 failure')).toBe('text-[#fca5a5]')
  expect(logLineClass('4 errors')).toBe('text-[#fca5a5]')
})

test('a ZERO count is good news and must never read as a failure', () => {
  // The whole reason counts are checked before the keyword branch: `0 failed`
  // contains `failed`, and painting a clean run red is worse than not coloring.
  expect(logLineClass(' 0 fail')).toBe('text-text-muted')
  expect(logLineClass('0 failed')).toBe('text-text-muted')
  expect(logLineClass('0 errors')).toBe('text-text-muted')
  // A zero PASS count is not success either.
  expect(logLineClass('0 pass')).toBe('text-text-muted')
})

test('count matching does not swallow ordinary lines that merely start with a number', () => {
  expect(logLineClass(' 28 expect() calls')).toBe('text-text-muted')
  expect(logLineClass('Ran 18 tests across 1 file. [355.00ms]')).toBe('text-text-muted')
  expect(logLineClass('3 files changed')).toBe('text-text-muted')
})

test('output-line tint keeps the prototype branch ORDER, so a failed pass reads failed', () => {
  // Both the error and the pass branch match this line; the prototype tests
  // error FIRST, and a line saying a test suite failed must not read green.
  expect(logLineClass('1 failed, 3 passed')).toBe('text-[#fca5a5]')
})

test('output-line tint anchors the bare FAIL/PASS words, so prose is not a status line', () => {
  // `^\s*FAIL`/`^\s*PASS` — the prototype anchors these, and the earlier port
  // used `\bFAIL\b`/`\bPASS\b`, so a sentence mentioning either was painted as
  // an outcome. Nothing else in those branches rescues the uppercase word:
  // `failed`/`passed` are separate lowercase alternatives.
  expect(logLineClass('the PASS threshold is configurable')).toBe('text-text-muted')
  expect(logLineClass('Tests: 1 FAIL out of 40')).toBe('text-text-muted')
  // Anchored still means leading whitespace is fine — that is how real output
  // indents its status lines.
  expect(logLineClass('  FAIL src/thing.test.ts')).toBe('text-[#fca5a5]')
})

test('output-line tint carries `not wrapped`, the one warn term the first port dropped', () => {
  // Only this one: the parent branch was `/\bWARN(ING)?\b|…/i`, so a lowercase
  // `warn` ALREADY matched. Without `not wrapped`, React's act() warning read as
  // ordinary output, which is the case that motivated re-checking the port.
  expect(logLineClass('An update was not wrapped in act(...)')).toBe('text-[#fcd34d]')
  expect(logLineClass('warn: peer dependency')).toBe('text-[#fcd34d]')
  // `WARNING` carries a `^\s*` anchor in the prototype, but that alternative is
  // unreachable: the branch's `\bwarn(ing)?\b` is unanchored and the whole regex
  // is case-insensitive, so a mid-line `WARNING` still matches. Ported verbatim
  // rather than "cleaned up", and pinned here so the quirk is not read as a bug.
  expect(logLineClass('emitted a WARNING during the run')).toBe('text-[#fcd34d]')
})

test('a bash body tints each line by its own semantics, not one flat wash', () => {
  // `status: 'error'` only EXPANDS the card; `isError: false` is what keeps the
  // per-line tinting path (a known failure paints one danger tone instead).
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'bun test' },
      status: 'error',
      result: {
        isError: false,
        content: 'bun test v1.3\nWARNING: slow suite\nERROR: probe refused\n✓ 1 pass',
        diff: null,
      },
    }),
  )

  expect(html).toContain('text-[#fcd34d]') // the warn line
  expect(html).toContain('text-[#fca5a5]') // the error line
  expect(html).toContain('text-[#86efac]') // the passing line
  expect(html).toContain('text-text-muted') // the unclassified first line
})

test('a bash body numbers its output lines', () => {
  // The prototype runs bash output through `OutputLines`, which always draws a
  // line-number gutter (`Messages.jsx:525,550-554`); this body had none.
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'ls' },
      status: 'error',
      result: { isError: false, content: 'alpha\nbeta\ngamma', diff: null },
    }),
  )

  expect(html).toContain('>1<')
  expect(html).toContain('>2<')
  expect(html).toContain('>3<')
})

test('a truncated bash tail resumes at its TRUE line number, never restarting at 1', () => {
  // Same rule P4-36 established for a truncated read: 900 lines, head 30,
  // tail 6 → the tail is output lines 895..900, not 1..6.
  const content = Array.from({ length: 900 }, (_, i) => `out ${i + 1}`).join('\n')
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'bun test' },
      status: 'error',
      result: { isError: false, content, diff: null },
    }),
  )

  expect(html).toContain('864 lines hidden') // the window really did cut
  expect(html).toContain('>30<') // last head line
  expect(html).toContain('>895<') // first tail line, its real number
  expect(html).toContain('>900<') // last tail line
})

test('an errored bash body stays one danger tone rather than tinting its trace', () => {
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'bun test' },
      status: 'error',
      result: { isError: true, content: 'ERROR: refused\n    at probe.ts:4', diff: null },
    }),
  )

  expect(html).toContain('text-tone-danger')
  expect(html).not.toContain('text-[#fca5a5]') // no per-line heuristic on a known failure
})

test('"Tools open by default" opens a card that would otherwise be closed', () => {
  // The prototype's `toolsExpandedByDefault` (AppV2.jsx:19), which this app had
  // never exposed. Proof it reaches the card: the full body renders on a
  // SUCCESSFUL card, which is otherwise collapsed to a 3-line peek.
  const row = toolRow({
    toolName: 'Bash',
    toolFamily: 'bash',
    input: { command: 'ls' },
    status: 'success',
    result: { isError: false, content: 'alpha\nbeta\ngamma\ndelta', diff: null },
  })

  const closed = renderToStaticMarkup(<TranscriptRowsView rows={[row]} />)
  const open = renderToStaticMarkup(
    <ToolsExpandedContext.Provider
      value={{ expanded: true, setExpanded: () => {} }}
    >
      <TranscriptRowsView rows={[row]} />
    </ToolsExpandedContext.Provider>,
  )

  // Closed: the peek shows only the LAST three lines, and no gutter.
  expect(closed).not.toContain('alpha')
  expect(closed).not.toContain('>1<')
  // Open: the whole body, numbered.
  expect(open).toContain('alpha')
  expect(open).toContain('>1<')
})

test('the preference is the WEAKEST expansion input: a failure still opens itself', () => {
  // An errored card must not close just because the preference says closed —
  // it opens for a reason the preference knows nothing about.
  const html = renderToStaticMarkup(
    <ToolsExpandedContext.Provider
      value={{ expanded: false, setExpanded: () => {} }}
    >
      <TranscriptRowsView
        rows={[
          toolRow({
            toolName: 'Bash',
            toolFamily: 'bash',
            input: { command: 'ls' },
            status: 'error',
            result: { isError: true, content: 'ERROR: boom', diff: null },
          }),
        ]}
      />
    </ToolsExpandedContext.Provider>,
  )

  expect(html).toContain('ERROR: boom')
  expect(html).toContain('text-tone-danger')
})

// Verbatim `bun test` tail. The last-three rule showed the three least
// informative lines and cut the result — observed in the running app.
const BUN_TAIL = [' 18 pass', ' 0 fail', ' 28 expect() calls', 'Ran 18 tests. [355ms]']

test('the peek reaches back for the outcome line instead of cutting it', () => {
  expect(selectPeekLines(BUN_TAIL)).toEqual(BUN_TAIL)
  // …and that really is a change: last-three would have dropped ` 18 pass`.
  expect(BUN_TAIL.slice(-3)).not.toContain(' 18 pass')
})

test('the peek stays THREE lines when the tail carries no outcome', () => {
  const plain = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  expect(selectPeekLines(plain)).toEqual(['gamma', 'delta', 'epsilon'])
})

test('the peek is always a CONTIGUOUS tail, never lines picked out of order', () => {
  // An outcome further back than the cap is left behind rather than reached for
  // across a gap — a preview with a hole in it misrepresents its output.
  const far = [' 9 pass', 'a', 'b', 'c', 'd', 'e', 'f']
  const peek = selectPeekLines(far)
  expect(peek).toEqual(['d', 'e', 'f'])
  expect(peek.length).toBeLessThanOrEqual(5)
})

test('a stack trace does not stretch the peek: context is not an outcome', () => {
  // `text-text-faint` trace lines are excluded from the outcome set on purpose.
  const trace = ['x', '  at Object.<anonymous> (a.ts:1)', 'y', 'z', 'w']
  expect(selectPeekLines(trace)).toEqual(['y', 'z', 'w'])
})

test('the COLLAPSED bash peek tints too, since that is the default view', () => {
  // The regression this pins: a successful card is collapsed by default, so the
  // peek is all most commands ever show. It painted one flat grey while the
  // expanded body underneath was fully tinted, which made a wall of finished
  // commands read as colourless. `status: 'success'` — no expanding here, this
  // is deliberately the closed card.
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'bun test' },
      status: 'success',
      result: { isError: false, content: 'ok\nWARNING: slow\n✓ 3 pass', diff: null },
    }),
  )

  expect(html).not.toContain('864 lines hidden') // sanity: this is the peek
  expect(html).toContain('text-[#fcd34d]') // warn line, in the closed card
  expect(html).toContain('text-[#86efac]') // pass line, in the closed card
})

test('search results are syntax-colored, with the locator receding beside them', () => {
  const html = render(
    toolRow({
      toolName: 'Grep',
      toolFamily: 'grep',
      input: { pattern: 'isError' },
      status: 'error',
      result: {
        isError: false,
        content: 'src/a.ts:25:const isError = true\nsrc/a.ts-26-  return isError',
        diff: null,
      },
    }),
  )

  // Locator recedes into its own column…
  expect(html).toContain('>src/a.ts:25:<')
  // …and a CONTEXT line (`-` separator) splits too, not just a match line.
  expect(html).toContain('>src/a.ts-26-<')
  expect(html).toContain('text-text-faint')
  // …while the matched source is colored as the source it is. This is what
  // "still lacks color" meant: receding the locator alone left the body grey.
  expect(html).toContain('hljs-keyword') // `const`, `return`
  expect(visibleText(html)).toContain('const isError = true')
})

test('search results from ONE file share a block; a new file starts another', () => {
  const html = render(
    toolRow({
      toolName: 'Grep',
      toolFamily: 'grep',
      input: { pattern: 'x' },
      status: 'error',
      result: {
        isError: false,
        content: 'src/a.ts:1:const x = 1\nsrc/a.ts:2:const y = 2\nsrc/b.py:9:x = 3',
        diff: null,
      },
    }),
  )

  // Grouping is by CONSECUTIVE path, so this is two runs, not one merged block
  // and not three. Each takes its OWN language from its own extension.
  expect(occurrences(html, 'hljs')).toBeGreaterThan(0)
  expect(visibleText(html)).toContain('const x = 1')
  expect(visibleText(html)).toContain('x = 3')
  expect(html).toContain('>src/b.py:9:<')
})

test('a failed search shows its error whole, never parsed for locators', () => {
  const html = render(
    toolRow({
      toolName: 'Grep',
      toolFamily: 'grep',
      input: { pattern: '[' },
      status: 'error',
      result: { isError: true, content: 'regex parse error at 1:1', diff: null },
    }),
  )

  expect(html).toContain('text-tone-danger')
  expect(visibleText(html)).toContain('regex parse error')
})

test('groupGrepLines keeps unlocatable lines as their own plain run', () => {
  expect(groupGrepLines(['src/a.ts:1:hit', '--', 'src/a.ts:2:hit2'])).toEqual([
    { kind: 'source', path: 'src/a.ts', locators: ['src/a.ts:1:'], bodies: ['hit'] },
    { kind: 'plain', lines: ['--'] },
    { kind: 'source', path: 'src/a.ts', locators: ['src/a.ts:2:'], bodies: ['hit2'] },
  ])
})

test('a NON-bash body keeps the prototype flat base, NOT the bash line heuristic', () => {
  // Parity guard, and the reason this file does not simply reuse `logLineClass`
  // everywhere: the prototype gives Grep/Web/Mcp/Skill bodies flat `FE_T.t2`
  // (`#a1a1aa` = `text-text-muted`) plus `hl()` syntax coloring
  // (`Messages.jsx:695,715,734,788`), and routes only bash output through
  // `OutputLines`/`logLineColor`. Tinting these by log semantics would be drift.
  const html = render(
    toolRow({
      toolName: 'mcp__probe__scan',
      toolFamily: 'mcp',
      input: { query: 'scan' },
      status: 'error',
      result: {
        isError: false,
        content: 'scanning\nWARNING: slow probe\n✓ 1 recovered',
        diff: null,
      },
    }),
  )

  expect(html).toContain('text-text-muted')
  expect(html).not.toContain('text-[#fcd34d]')
  expect(html).not.toContain('text-[#86efac]')
})

test('a written file is syntax-colored while its gutter remains additions-green', () => {
  const html = render(
    writeRow(
      { file_path: '/w/hello.ts', content: 'const greeting = "hi"' },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(html).toContain('hljs-keyword') // `const` tokenized
  expect(html).toContain('hljs-string') // the quoted literal tokenized
  expect(html).toContain('text-[#86efac]') // the + gutter
  expect(html).toMatch(/class="[^"]*\bhljs\b(?!-)/) // theme base foreground
})

test('a written file whose extension names no language uses the theme base', () => {
  // `detect: false` is the house rule: color only what we can name. An unknown
  // extension must not be guessed at, and must not lose the additions green.
  const html = render(
    writeRow(
      { file_path: '/w/notes.xyz', content: 'const greeting = "hi"' },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(visibleText(html)).toContain('const greeting = &quot;hi&quot;')
  expect(html).toContain('text-[#86efac]') // the + gutter
  expect(html).toMatch(/class="[^"]*\bhljs\b(?!-)/)
  expect(html).not.toContain('hljs-keyword')
})

test('a written file uses add-green only for its + gutter', () => {
  const html = render(
    writeRow(
      { file_path: '/w/hello.ts', content: 'const greeting = "hi"' },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(html).toContain('text-[#86efac]')
  expect(html).not.toContain('text-tone-success')
})

// ── P4-18c dep-gated deferrals resolved: GFM tables + syntax highlight + word-diff

function proseRow(content: string, id: string): NestedTranscriptRow {
  return {
    ...blockSource,
    id: `s:m:0:${id}`,
    kind: 'assistant-text',
    role: 'assistant',
    content,
  }
}

test('P4-18c: a GFM pipe table renders a real <table> with header + body cells', () => {
  const html = render(
    proseRow('| Name | Role |\n|------|------|\n| cat | agent |\n', 'table'),
  )

  expect(html).toContain('<table') // real table element (remark-gfm), not raw text
  expect(html).toContain('<th') // header cells
  expect(html).toContain('<td') // body cells
  expect(html).toContain('Name')
  expect(html).toContain('agent')
  // Prototype ProseTable grammar reaches the DOM (exact header wash + rules).
  expect(html).toContain('bg-white/[0.03]')
  expect(html).toContain('border-white/[0.12]')
})

test('P4-18c: a malformed pipe table degrades tolerantly, never throws', () => {
  // Ragged columns (header 3 / delimiter 1) — GFM declines it as a table and it
  // falls back to text; the point is the prose subtree must not crash.
  const render0 = () =>
    render(proseRow('| A | B | C |\n|---|\n| 1 |\n', 'badtable'))
  expect(render0).not.toThrow()
  expect(render0()).toContain('A') // content still surfaces
})

test('P4-18c: an explicitly-languaged fenced block gets highlight.js token classes', () => {
  const html = render(
    proseRow('```python\ndef greet(name):\n    return name\n```\n', 'py'),
  )

  expect(html).toContain('hljs') // highlight.js base class on the <code>
  expect(html).toContain('hljs-keyword') // `def`/`return` keyword tokens
  expect(html).toContain('python') // floating language label
  expect(html).toContain('greet') // code content still present
})

test('P4-18c: an unknown code language degrades to plain framed code, never throws', () => {
  const render0 = () =>
    render(proseRow('```notalang\nsome plain content\n```\n', 'unklang'))
  expect(render0).not.toThrow()
  const html = render0()
  // ignoreMissing → no highlight, so the body stays a contiguous, legible string.
  expect(html).toContain('some plain content')
  expect(html).toContain('copy') // still framed + copyable
  expect(html).toContain('notalang') // language label passthrough
})

// ── Model-prose typography (`.md-prose`, theme.css)
//
// This suite renders to static markup with no stylesheet, so it can prove the
// class REACHES each prose body and that the elements the class styles are
// really emitted. It cannot prove the computed measure, spacing or scale —
// those are operator-verifiable in a live window only.

test('every model-authored prose body carries the shared typography class', () => {
  const html = render(proseRow('An ordinary answer.', 'plain'))

  expect(html).toContain('md-prose')
  // Typography moved OUT of the className; the old per-tag utility string must
  // not come back alongside it and win by layer order.
  expect(html).not.toContain('[&>*+*]:mt-2')
})

test('deep heading levels reach the DOM as real heading elements to be styled', () => {
  // Preflight flattens h1-h6 to inherited size and weight, so `.md-prose` is the
  // only thing that distinguishes them. Models emit ### and #### freely.
  const html = render(
    proseRow('# One\n\n## Two\n\n### Three\n\n#### Four\n\nBody.\n', 'headings'),
  )

  expect(html).toContain('<h1>One</h1>')
  expect(html).toContain('<h2>Two</h2>')
  expect(html).toContain('<h3>Three</h3>')
  expect(html).toContain('<h4>Four</h4>')
})

test('a loose list keeps its per-item paragraphs, which the class spaces', () => {
  // Blank lines between items make remark wrap each item in <p>. Those are not
  // top-level siblings, so they need `.md-prose li > p + p` to separate at all.
  const html = render(
    proseRow('- first item\n\n  still first\n\n- second item\n', 'loose'),
  )

  expect(html).toContain('<li>')
  expect(html).toContain('<p>first item</p>')
  expect(html).toContain('<p>still first</p>')
})

test('a thematic break renders an <hr> rather than being dropped', () => {
  const html = render(proseRow('Before.\n\n---\n\nAfter.\n', 'rule'))

  expect(html).toContain('<hr/>')
})

function diffToolRow(lines: string[], filePath: string, id: string): NestedTranscriptRow {
  return toolRow({
    toolName: `Edit_${id}`,
    toolFamily: 'edit',
    input: { file_path: filePath },
    status: 'error', // expand so the diff body renders
    result: { isError: true, content: '', diff: { filePath, hunks: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines },
    ] } },
  })
}

test('P4-18c: a replaced diff line shows word-level intra-line highlighting', () => {
  const html = render(
    diffToolRow(['-const timeout = 30', '+const timeout = 60'], '/repo/x.ts', 'word'),
  )

  // The differing token (30 → 60) is washed per side; the shared prefix dims.
  expect(html).toContain('bg-tone-danger/28') // removed word wash (exact prototype 0.28)
  expect(html).toContain('bg-tone-success/26') // added word wash (exact prototype 0.26)
  expect(html).toContain('opacity-60') // unchanged source dims without overriding syntax colors
  expect(visibleText(html)).toContain('const timeout = ') // shared prefix present
})

test('P4-18c: a near-total line rewrite skips word-highlight (line-level), no throw', () => {
  // >90% of the line changed → the prototype guard falls back to line-level.
  const render0 = () =>
    render(diffToolRow(['-aaaaaaaa', '+zzzzzzzzzz'], '/repo/y.ts', 'rewrite'))
  expect(render0).not.toThrow()
  const html = render0()
  expect(html).toContain('zzzzzzzzzz') // whole line intact (not word-split)
  expect(html).not.toContain('bg-tone-success/26') // no word wash — guard tripped
})

// ─── P4-1 ToolInspector wiring: open-from-card affordance + overlay ──────────
// Live-path fixture: project a real tool_use + correlated tool_result through the
// reducer, then read the nested row the transcript actually renders — not a
// hand-built shape (§8 rule 1: prove real data flows).
function inspectorReady(sessionId: string) {
  return {
    kind: 'ready' as const,
    protocolVersion: 1 as const,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready' as const,
      protocolVersion: 1 as const,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' as const },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}

function inspectorMessage(sessionId: string, message: SDKMessage) {
  return {
    kind: 'event' as const,
    protocolVersion: 1 as const,
    sessionId,
    event: { type: 'message' as const, message },
  }
}

function projectedBashRow(): NestedToolUseRow {
  let state = createTranscriptState()
  state = projectServerFrame(state, inspectorReady('insp-1'))
  state = projectServerFrame(
    state,
    inspectorMessage('insp-1', {
      type: 'assistant',
      message: {
        id: 'msg_insp_1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_insp_1',
            name: 'Bash',
            input: { command: 'echo hi' },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d0001',
    }),
  )
  state = projectServerFrame(
    state,
    inspectorMessage('insp-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_insp_1',
            content: [{ type: 'text', text: 'hi from the shell' }],
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d0002',
    }),
  )
  const row = selectNestedTranscriptRows(state, 'insp-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected a projected tool-use row')
  return row
}

test('an expanded card whose output fits offers no route to the drawer at all', () => {
  // Default-expanded (error status), so the body renders in the real path. The
  // always-present `Inspector` footer was removed 2026-08-13
  // (`docs/reports/2026-08-12-tool-inspector-ux-review.md`): it was a second
  // route to a destination that repeated this card. Short output means no band
  // either, so an expanded card that shows everything offers nothing.
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[projectedBashRow()]} />)
  expect(html).toContain('hi from the shell') // the body really did render
  expect(html).not.toContain('Inspector')
  expect(html).not.toContain('Open full output')
})

test('P4-1: the inspector overlay renders the REAL projected row (drawer + backdrop)', () => {
  const html = renderToStaticMarkup(
    <ToolInspectorOverlay row={projectedBashRow()} onClose={() => {}} />,
  )
  // The header names the ROW, not the drawer: the generic "Tool inspector"
  // title and the Tool/Summary/Status/Input stack under it went with the footer.
  expect(html).toContain('echo hi') // real input summary, from the projected row
  expect(html).not.toContain('Tool inspector')
  expect(html).toContain('hi from the shell') // real correlated result output
  expect(html).toContain('bg-black/60') // the dimmed dismiss backdrop
})

test('P4-1: the inspector overlay renders nothing when closed (null row)', () => {
  expect(
    renderToStaticMarkup(<ToolInspectorOverlay row={null} onClose={() => {}} />),
  ).toBe('')
})

test('P4-36: a revealed hidden row renders DIMMED, and only when revealed', () => {
  // Built from the REAL projection of a synthetic frame (the engine's hidden
  // tier), not a hand-made row: the dim depends on the read-time `isHidden`
  // mark, so a hand-made row would prove nothing about the wiring.
  let state = createTranscriptState()
  state = projectServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 's',
    engineSessionId: 'engine-s',
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
  const hiddenFrame: SDKMessage = {
    type: 'user',
    message: { role: 'user', content: 'engine bookkeeping turn' },
    parent_tool_use_id: null,
    session_id: 's',
    uuid: '00000000-0000-4000-8000-0000000036b2',
    isSynthetic: true,
  }
  state = projectServerFrame(state, {
    kind: 'event',
    protocolVersion: 1,
    sessionId: 's',
    event: { type: 'message', message: hiddenFrame },
  })

  // Default view: the row is absent entirely (the transcript the app has always
  // shown), so there is nothing to dim.
  const plain = renderToStaticMarkup(
    <TranscriptRowsView rows={selectNestedTranscriptRows(state, 's')} />,
  )
  expect(plain).not.toContain('engine bookkeeping turn')
  expect(plain).not.toContain('opacity-55')

  // Revealed view: the row renders, wrapped in the prototype's 0.55 dim
  // (Chat.jsx:1285), so it never passes as ordinary conversation.
  const revealed = renderToStaticMarkup(
    <TranscriptRowsView rows={selectNestedTranscriptRows(state, 's', true)} />,
  )
  expect(revealed).toContain('engine bookkeeping turn')
  expect(revealed).toContain('opacity-55')
})

test('an orphaned subagent tail renders as an agent frame, never as user or assistant messages', () => {
  // Built from the REAL projection of subagent frames whose Agent `tool_use`
  // is absent (what a truncated replay hands the renderer), because the guard
  // lives in the nesting selector: hand-made rows would prove nothing about it.
  let state = createTranscriptState()
  state = projectServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 's',
    engineSessionId: 'engine-s',
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
  const orphaned: SDKMessage[] = [
    {
      type: 'user',
      message: { role: 'user', content: 'internal task prompt for the worker' },
      parent_tool_use_id: 'toolu_truncated_away',
      agent_name: 'Ada',
      session_id: 's',
      uuid: '00000000-0000-4000-8000-0000000036c1',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg_orphan',
        role: 'assistant',
        content: [
          { type: 'text', text: 'what the worker reported back' },
          { type: 'text', text: 'and one more block of it' },
        ],
      },
      parent_tool_use_id: 'toolu_truncated_away',
      agent_name: 'Ada',
      session_id: 's',
      uuid: '00000000-0000-4000-8000-0000000036c2',
    },
  ]
  for (const message of orphaned) {
    state = projectServerFrame(state, {
      kind: 'event',
      protocolVersion: 1,
      sessionId: 's',
      event: { type: 'message', message },
    })
  }

  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={selectNestedTranscriptRows(state, 's')} />,
  )

  // The frame names the worker and says why it stands alone.
  expect(html).toContain('Ada')
  // MESSAGES, not projected rows: the assistant reply above is ONE message
  // carrying two text blocks, which the projector splits into two rows.
  expect(html).toContain('2 messages')
  expect(html).toContain('The rest of this agent run is no longer shown.')
  // Collapsed by default, exactly as an Agent card keeps its children (C4), so
  // neither body reaches the transcript flow.
  expect(html).not.toContain('internal task prompt for the worker')
  expect(html).not.toContain('what the worker reported back')
  expect(html).not.toContain('and one more block of it')
  // The failure this guard exists for: the user bubble (`UserBubble`) drawn for
  // a message the user never sent.
  expect(html).not.toContain('rounded-2xl rounded-br')
  // The face replaced the hollow diamond: the frame's other unanswered question
  // is WHO, and an identity-only stamp answers it without claiming anything
  // about a run the missing parent was carrying.
  expect(html).toContain('shape-rendering="crispEdges"')
  expect(html).not.toContain('◇')
  // Named, so the stamp is that name's own, not the featureless base.
  const named = /<svg[^>]*shape-rendering="crispEdges"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? ''
  const anonymous = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          ...blockSource,
          id: 's:m:0:task-notification',
          kind: 'task-notification',
          status: 'completed',
          summary: 'Agent "sweep the renderer" completed',
          toolUseId: null,
          isReplay: false,
          children: [],
        },
      ]}
    />,
  )
  expect(named).not.toBe(
    /<svg[^>]*shape-rendering="crispEdges"[\s\S]*?<\/svg>/.exec(anonymous)?.[0] ?? '',
  )
})

test('P4-1/F1: findNestedToolUseRow re-derives the row by id, or null when gone', () => {
  const row = projectedBashRow()
  // Found at the top level.
  expect(findNestedToolUseRow([row], row.id)).toBe(row)
  // A vanished id resolves to null → the drawer closes instead of pinning a snapshot.
  expect(findNestedToolUseRow([row], 'no-such-id')).toBeNull()
  // Re-derivation reads from the PASSED rows: a freshly-projected row object with
  // the same id supersedes an earlier open-time snapshot (the F1 staleness fix).
  const updated: NestedToolUseRow = { ...row }
  expect(findNestedToolUseRow([updated], row.id)).toBe(updated)
  expect(findNestedToolUseRow([updated], row.id)).not.toBe(row)
})

/* --------------------------------------------------------------------------- *
 * User bubble: no copy affordance (operator call, 2026-08-02) — deviates from
 * the prototype's UserBubble hover chip (Messages.jsx:2094); the assistant
 * twin below keeps it.
 * --------------------------------------------------------------------------- */

function userRow(content: string): NestedTranscriptRow {
  return {
    ...blockSource,
    id: 's:m:0:user-text',
    kind: 'user-text',
    role: 'user',
    content,
    isReplay: false,
  }
}

test('a user turn carries no copy control', () => {
  const html = render(userRow('restart the sidecar please'))
  expect(html).not.toContain('aria-label="Copy message"')
  expect(html).not.toContain('Copy message')
})

/* --------------------------------------------------------------------------- *
 * P4-38 — the hover-reveal copy chip on the assistant body (Messages.jsx:2064-2091).
 *
 * SSR-ONLY LIMIT: `renderToStaticMarkup` produces no document, so the hover
 * reveal and the clipboard round-trip are structurally untestable here. What
 * these tests pin is everything that IS decidable from the markup — the gates,
 * the host contract the absolute chip depends on, the assistant wording — plus
 * a source pin on the payload, which never reaches the DOM at all.
 * --------------------------------------------------------------------------- */

function assistantRow(
  content: string,
  streaming?: true,
): NestedTranscriptRow {
  return {
    ...blockSource,
    id: 's:m:0:assistant-text',
    kind: 'assistant-text',
    role: 'assistant',
    content,
    ...(streaming ? { isStreaming: streaming } : {}),
  }
}

test('P4-38 — a settled assistant reply carries a copy control, worded for a response', () => {
  const html = render(assistantRow('Here is the answer.'))
  expect(html).toContain('aria-label="Copy response"')
  expect(html).toContain('title="Copy response"')
})

test('P4-38 — the assistant body is the positioned hover group the chip needs', () => {
  // The chip is `absolute` + `opacity-0`; without `group relative` on the host it
  // anchors to a distant ancestor and never reveals. No reserved right gutter:
  // the revealed glyph overlays the last line, matching the prototype.
  const html = render(assistantRow('Here is the answer.'))
  expect(html).toContain('group relative')
  expect(html).not.toContain('pr-8')
  expect(html).toContain('opacity-0')
  expect(html).toContain('group-hover:opacity-100')
  // Real-added keyboard reach; the prototype reveals on hover only.
  expect(html).toContain('group-focus-within:opacity-100')
})

test('P4-38 — no copy chip while the reply is still streaming', () => {
  const html = render(assistantRow('partial ans', true))
  expect(html).toContain('animate-pulse') // still streaming: the caret is up
  expect(html).not.toContain('Copy response')
})

test('P4-38 — an empty assistant turn gets no copy chip', () => {
  expect(render(assistantRow('   \n  '))).not.toContain('Copy response')
})

/* --------------------------------------------------------------------------- *
 * P4-36 — inline truncation reveal band (prototype Messages.jsx:438-457,546-556).
 *
 * The defect: `NumberedBody` (file read) and `AdditionsBody` (file write) sliced
 * the content and rendered NOTHING about the slice, so a 900-line read showed 400
 * lines that simply stopped and the last visible line read as the end of the file.
 *
 * SSR-ONLY LIMIT: `renderToStaticMarkup` cannot click "Show N more", so what these
 * tests pin is the first paint of each state. The reveal itself is proven against
 * the pure window in `inlineOutputWindow.test.ts`.
 *
 * Cards collapse by default, so these rows are `status: 'error'` — the one status
 * that expands a read/write card (`ToolCard` `defaultExpanded`).
 * --------------------------------------------------------------------------- */

function longToolRow(family: ToolFamily, lineCount: number): NestedTranscriptRow {
  return toolRow({
    toolName: family === 'read' ? 'Read' : 'Write',
    toolFamily: family,
    input: { file_path: '/w/big.ts' },
    status: 'error',
    result: {
      content: Array.from({ length: lineCount }, (_, i) => `src line ${i + 1}`).join('\n'),
      isError: true,
      diff: null,
    },
  })
}

test('P4-36 — a long file READ no longer stops silently: it states the gap', () => {
  const html = render(longToolRow('read', 900))

  // 900 lines, head 30, tail 6 → 864 in the gap.
  expect(html).toContain('864 lines hidden')
  expect(html).toContain('Show 100 more')
})

test('P4-36 — a long file WRITE states the gap too (the second silent body)', () => {
  const html = render(longToolRow('write', 900))

  expect(html).toContain('864 lines hidden')
  expect(html).toContain('Show 100 more')
})

test('P4-36 — the tail of a truncated read stays visible, with its real line numbers', () => {
  const html = render(longToolRow('read', 900))

  expect(html).toContain('src line 1') // head
  expect(html).toContain('src line 900') // tail: the file's true last line
  expect(html).not.toContain('src line 500') // the gap really is hidden
  // The tail is numbered 895..900, not 1..6.
  expect(html).toContain('>895<')
  expect(html).toContain('>900<')
})

test('P4-36 — the band offers the route to the complete text, and it is the only one', () => {
  const html = render(longToolRow('read', 900))
  expect(html).toContain('Open full output')
  // The band is now the ONLY route in: the card footer that also opened the
  // drawer was removed 2026-08-13. This count was the P4-45 guard against two
  // same-label buttons; it now also pins that nothing else offers the drawer.
  expect(html.split('Open full output').length - 1).toBe(1)
  expect(html).not.toContain('Inspector')
})

test('P4-36 — output under the window renders whole, with no band', () => {
  const html = render(longToolRow('read', 30))

  expect(html).toContain('src line 30')
  expect(html).not.toContain('lines hidden')
  expect(html).not.toContain('Show ')
})

test('P4-36 — one line over the window bands, and offers exactly that line', () => {
  const html = render(longToolRow('read', 37))

  expect(html).toContain('1 line hidden') // singular, not "1 lines"
  expect(html).toContain('Show 1 more') // never offers more than exists
  expect(html).toContain('src line 37') // the tail is still the real last line
})

test('P4-36 — a body shorter than the tail renders whole', () => {
  const html = render(longToolRow('write', 3))

  expect(html).toContain('src line 1')
  expect(html).toContain('src line 3')
  expect(html).not.toContain('lines hidden')
})

test('P4-36 — an empty result keeps its own message and never bands', () => {
  const html = render(
    toolRow({
      toolName: 'Read',
      toolFamily: 'read',
      input: { file_path: '/w/empty.ts' },
      status: 'error',
      result: { content: '', isError: true, diff: null },
    }),
  )

  expect(html).toContain('Failed with no output.')
  expect(html).not.toContain('lines hidden')
})

test('P4-36 — bash keeps its band too, so the four bodies share one grammar', () => {
  const html = render(longToolRow('bash', 900))

  expect(html).toContain('864 lines hidden')
  // The old one-line note is gone from every body.
  expect(html).not.toContain('Open the full-output inspector to view all')
})

/* --------------------------------------------------------------------------- *
 * The file-READ body over the payload the engine actually sends.
 *
 * The fixtures above are plain strings, which is why two defects survived them:
 * a real read arrives in `cat -n` form (`FileReadTool.ts:721` →
 * `addLineNumbers`, `src/utils/file.ts:290-318`), so the card drew its own
 * 1..N gutter on top of the engine's numbers and fed the prefixed lines to
 * nothing that could color them. These rows use the real shape.
 * --------------------------------------------------------------------------- */

function readRow(content: string, filePath: string): NestedTranscriptRow {
  return toolRow({
    toolName: 'Read',
    toolFamily: 'read',
    input: { file_path: filePath },
    // `error` is the one status that expands a read card by default.
    status: 'error',
    result: { content, isError: true, diff: null },
  })
}

/**
 * The read gutter is a CELL of its row, not a column beside the source, since
 * the rows were virtualized (CC-62). Matching on its own class is what keeps
 * these assertions off a `1` that happens to be a syntax-colored literal.
 */
function readGutter(number: number): string {
  return `text-text-subtle/60">${number}</span>`
}

test('a real read paints ONE gutter, not the engine numbers plus its own', () => {
  const html = render(
    readRow('1\timport os\n2\t\n3\tdef f():\n4\t    return 1', '/w/a.py'),
  )

  // The prefix is gone from the source column (the keyword is tokenized, so
  // the rest of the line is what survives as plain text beside it)…
  expect(html).not.toContain('1\timport os')
  expect(html).toContain('>import</span> os')
  // …and each number appears once, in the gutter.
  expect(occurrences(html, readGutter(1))).toBe(1)
  expect(occurrences(html, readGutter(4))).toBe(1)
})

test('an offset read is numbered with the file lines it really is', () => {
  const html = render(readRow('812\tconst x = 1\n813\tconst y = 2', '/w/a.ts'))

  expect(html).toContain(readGutter(812))
  expect(html).toContain(readGutter(813))
  expect(html).not.toContain(readGutter(1)) // the old gutter restarted at 1 here
})

test('read source is syntax-colored by the theme the transcript already uses', () => {
  const html = render(readRow('1\tdef f():\n2\t    return 1', '/w/a.py'))

  // `hljs-*` classes, not a private palette: `theme.css` colors these under the
  // operator's chosen code theme (`codeTheme.ts`).
  expect(html).toContain('class="hljs-keyword"')
  expect(html).toContain('hljs')
})

test('a file we cannot name a language for stays uncolored rather than guessed', () => {
  const html = render(readRow('1\tsome notes\n2\tmore notes', '/w/notes.wat'))

  expect(html).not.toContain('hljs')
  expect(html).toContain('some notes')
  expect(html).toContain(readGutter(1)) // still numbered from the payload
})

test('a read result that is not a numbered file keeps the plain rendering', () => {
  const html = render(readRow('EISDIR: illegal operation', '/w/a.ts'))

  expect(html).not.toContain('hljs')
  expect(html).toContain('EISDIR: illegal operation')
  expect(html).toContain(readGutter(1)) // counted, since the payload carried none
})

test('a truncated real read numbers its tail with the file lines, not 1..6', () => {
  const content = Array.from(
    { length: 900 },
    (_, index) => `${index + 1}\tconst v${index + 1} = ${index + 1}`,
  ).join('\n')
  const html = render(readRow(content, '/w/big.ts'))

  expect(html).toContain('864 lines hidden')
  expect(html).toContain(readGutter(895))
  expect(html).toContain(readGutter(900))
  expect(html).not.toContain(readGutter(500)) // the gap really is hidden
})

/* --------------------------------------------------------------------------- *
 * The file-WRITE body over the payload the engine actually sends.
 *
 * `FileWriteTool` returns one of exactly two sentences and never the file
 * (`src/tools/FileWriteTool/FileWriteTool.ts:418-433`), so an additions view fed
 * `result.content` painted an English sentence, or a failure, as green `+` added
 * lines. The file is the tool's INPUT (`content`, `FileWriteTool.ts:63`).
 *
 * SSR-ONLY LIMIT: a card opens by default only on `status: 'error'`, and these
 * rows need an OPEN card whose result is not an error. The two are independent
 * inputs to different decisions — `status` drives `defaultExpanded`, the body
 * path reads `result.isError` — so the successful-write rows below set them
 * apart purely to get the body into the markup. The genuinely-failed row keeps
 * both.
 * --------------------------------------------------------------------------- */

const WRITE_ACK = 'File created successfully at: /w/hello.ts'

function writeRow(
  input: Record<string, unknown>,
  result: { content: string; isError: boolean },
): NestedTranscriptRow {
  return toolRow({
    toolName: 'Write',
    toolFamily: 'write',
    input,
    status: 'error',
    result: { ...result, diff: null },
  })
}

test('a write shows the file it wrote, not the engine sentence about it', () => {
  const html = render(
    writeRow(
      { file_path: '/w/hello.ts', content: 'const greeting = "hi"\nexport default greeting' },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(visibleText(html)).toContain('const greeting = &quot;hi&quot;')
  expect(visibleText(html)).toContain('export default greeting')
  // Painted as additions, which is now true of what it is painting.
  expect(html).toContain('text-[#86efac]')
  // The ack never reaches the body; the card's own status already reports it.
  expect(html).not.toContain('File created successfully at')
})

test('a failed write reports the failure instead of claiming additions', () => {
  const html = render(
    writeRow(
      { file_path: '/w/hello.ts', content: 'const greeting = "hi"' },
      { content: 'EACCES: permission denied', isError: true },
    ),
  )

  expect(html).toContain('EACCES: permission denied')
  expect(html).toContain('text-tone-danger')
  // Nothing was written, so nothing is painted as an addition.
  expect(html).not.toContain('const greeting')
  expect(html).not.toContain('text-[#86efac]')
})

test('a write whose input carries no content falls back to the result text', () => {
  const html = render(
    writeRow({ file_path: '/w/hello.ts' }, { content: WRITE_ACK, isError: false }),
  )

  expect(html).toContain('File created successfully at')
  // …as plain text, never as a green added line.
  expect(html).not.toContain('text-[#86efac]')
})

test('a long written file still bands, and the band counts the FILE', () => {
  const written = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n')
  const html = render(
    writeRow(
      { file_path: '/w/big.ts', content: written },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(html).toContain('864 lines hidden') // 900 - 30 head - 6 tail
  expect(visibleText(html)).toContain('line 1')
  expect(visibleText(html)).toContain('line 900')
  expect(visibleText(html)).not.toContain('line 500')
})

// ─── grouped tool runs (prototype GroupedToolGroup: FileReadCard + GrepCard) ──

/** Render a row list, optionally with tool cards opened by default so a run's
 * member rows are on screen (a successful run is collapsed, like every card). */
function renderMany(rows: NestedTranscriptRow[], expanded = false): string {
  return renderToStaticMarkup(
    <ToolsExpandedContext.Provider value={{ expanded, setExpanded: () => {} }}>
      <TranscriptRowsView rows={rows} />
    </ToolsExpandedContext.Provider>,
  )
}

function runReadRow(
  id: string,
  filePath: string,
  over: { content?: string; status?: ToolCardStatus; isError?: boolean } = {},
): NestedTranscriptRow {
  const content = over.content ?? '1\tconst a = 1\n2\tconst b = 2'
  return toolRow({
    id,
    toolName: 'Read',
    toolFamily: 'read',
    input: { file_path: filePath },
    status: over.status ?? 'success',
    result: { content, isError: over.isError ?? false, diff: null },
  })
}

test('adjacent reads collapse into ONE card that counts the files', () => {
  const html = renderMany([
    runReadRow('r1', '/repo/app/renderer/src/TranscriptView.tsx'),
    runReadRow('r2', '/repo/app/shared/protocol.ts'),
    runReadRow('r3', '/repo/app/sidecar/sidecarServer.ts'),
  ])

  expect(html).toContain('3 files')
  // One shell, not three: the family word is drawn once, by the group head.
  expect(occurrences(html, '>Read</span>')).toBe(1)
})

test('an expanded run member carries no inspector footer either', () => {
  // The removed footer rendered once per OPEN MEMBER, not once per card, so a
  // three-file run with every member open used to draw three of them
  // (`docs/reports/2026-08-12-tool-inspector-ux-review.md` finding 1). Opened
  // via `toolsExpanded`, which reaches the members, so the bodies are on screen.
  const html = renderMany(
    [
      runReadRow('r1', '/repo/app/shared/protocol.ts'),
      runReadRow('r2', '/repo/app/sidecar/sidecarServer.ts'),
      runReadRow('r3', '/repo/app/renderer/src/TranscriptView.tsx'),
    ],
    true,
  )

  expect(occurrences(visibleText(html), 'const a = 1')).toBe(3) // all three open
  expect(html).not.toContain('Inspector')
})

test('the run hoists the shared directory onto the head and shortens its rows', () => {
  const html = renderMany(
    [
      runReadRow('r1', '/repo/app/shared/protocol.ts'),
      runReadRow('r2', '/repo/app/sidecar/protocol.ts'),
    ],
    true,
  )
  const text = visibleText(html)

  // Stated once on the head, not repeated down every row.
  expect(text).toContain('/repo/app/')
  expect(occurrences(text, '/repo/app/')).toBe(1)
  // The whole point of the run: two files that share a basename stay distinct.
  expect(text).toContain('shared/protocol.ts')
  expect(text).toContain('sidecar/protocol.ts')
  expect(occurrences(text, 'protocol.ts')).toBe(2)
})

test('a run whose files share no directory keeps whole paths on its rows', () => {
  const html = renderMany(
    [runReadRow('r1', '/etc/hosts'), runReadRow('r2', '/var/log/app.log')],
    true,
  )
  const text = visibleText(html)

  // Sharing only the root is not worth a badge, and hoisting '/' would make both
  // rows read as relative when they are absolute.
  expect(text).toContain('/etc/hosts')
  expect(text).toContain('/var/log/app.log')
})

test('a ranged read states its range, a whole-file read says nothing', () => {
  const ranged = toolRow({
    id: 'r1',
    toolName: 'Read',
    toolFamily: 'read',
    input: { file_path: '/w/big.ts', offset: 811, limit: 50 },
    status: 'success',
    result: { content: '811\tconst x = 1', isError: false, diff: null },
  })
  const html = renderMany([ranged, runReadRow('r2', '/w/small.ts')], true)
  const text = visibleText(html)

  // `offset` is ONE-based and becomes the engine's `startLine`, so the label must
  // read the same number the body's gutter prints right below it. An earlier
  // version added one and contradicted its own gutter.
  expect(text).toContain('lines 811 to 860')
  expect(text).not.toContain('lines 812')
  // The neighbouring whole-file read claims no range at all.
  expect(occurrences(text, 'lines 811 to 860')).toBe(1)
})

test('a successful read that returned no file reports NO line count', () => {
  // An empty file, an offset past EOF and an unchanged file all succeed while
  // carrying no numbered body. Counting the raw split would claim `Read 1 line`.
  const html = renderMany(
    [
      runReadRow('r1', '/w/empty.ts', {
        content:
          '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
      }),
      runReadRow('r2', '/w/real.ts', { content: '1\tone\n2\ttwo' }),
    ],
    true,
  )
  const text = visibleText(html)

  expect(text).toContain('Read 2 lines') // the real one still counts
  expect(text).not.toContain('Read 1 line') // the empty one says nothing
})

test('each member reports its own line count from the real numbered payload', () => {
  const html = renderMany(
    [
      runReadRow('r1', '/w/a.ts', { content: '1\tone\n2\ttwo\n3\tthree' }),
      runReadRow('r2', '/w/b.ts', { content: '1\tonly' }),
    ],
    true,
  )
  const text = visibleText(html)

  expect(text).toContain('Read 3 lines')
  expect(text).toContain('Read 1 line') // singular, not '1 lines'
})

test('a lone read is NOT grouped — it keeps the single-card basename framing', () => {
  const html = renderMany([runReadRow('r1', '/repo/app/shared/protocol.ts')])

  expect(html).not.toContain('1 files')
  expect(visibleText(html)).toContain('protocol.ts')
  expect(visibleText(html)).not.toContain('/repo/app/shared/')
})

test('one failed member fails the whole run and says so on the member too', () => {
  const html = renderMany([
    runReadRow('r1', '/w/a.ts'),
    runReadRow('r2', '/w/b.ts'),
    runReadRow('r3', '/w/gone.ts', {
      status: 'error',
      isError: true,
      content: 'File does not exist: /w/gone.ts',
    }),
  ])

  // Head reports the worst outcome, and the failed member opens itself so the
  // reason is on screen without a click.
  expect(occurrences(html, 'failed')).toBe(2)
  expect(html).not.toContain('>done<')
  expect(visibleText(html)).toContain('File does not exist: /w/gone.ts')
})

test('a still-running member holds the run at running, not done', () => {
  const html = renderMany([
    runReadRow('r1', '/w/a.ts'),
    toolRow({
      id: 'r2',
      toolName: 'Read',
      toolFamily: 'read',
      input: { file_path: '/w/b.ts' },
      status: 'pending',
    }),
  ])

  expect(html).toContain('running')
  expect(html).not.toContain('>done<')
})

test('a non-read row between reads splits them into two runs', () => {
  const html = renderMany([
    runReadRow('r1', '/w/a.ts'),
    runReadRow('r2', '/w/b.ts'),
    toolRow({
      id: 'cmd',
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'rg foo' },
      status: 'success',
      result: { content: 'ok', isError: false, diff: null },
    }),
    runReadRow('r3', '/w/c.ts'),
    runReadRow('r4', '/w/d.ts'),
  ])

  // Two group heads, each counting its own side of the break.
  expect(occurrences(html, '2 files')).toBe(2)
})

test('the run survives the blocks reasoning mode — it is not a reasoning setting', () => {
  const rows = [runReadRow('r1', '/w/a.ts'), runReadRow('r2', '/w/b.ts')]

  expect(renderRows(rows, 'blocks')).toContain('2 files')
  expect(renderRows(rows, 'trail')).toContain('2 files')
})

function grepRow(
  id: string,
  pattern: string,
  content: string,
  over: { status?: ToolCardStatus; isError?: boolean } = {},
): NestedTranscriptRow {
  return toolRow({
    id,
    toolName: 'Grep',
    toolFamily: 'grep',
    input: { pattern },
    status: over.status ?? 'success',
    result: { content, isError: over.isError ?? false, diff: null },
  })
}

test('adjacent searches collapse into ONE card that counts the patterns', () => {
  const html = renderMany([
    grepRow('g1', 'ToolCardShell', 'Found 2 files\na.ts\nb.ts'),
    grepRow('g2', 'FrameEShell', 'Found 1 file\nc.ts'),
  ])

  expect(html).toContain('2 patterns')
  expect(occurrences(html, '>Search</span>')).toBe(1)
})

test('the search run lists each pattern with what its own mode reported', () => {
  const html = renderMany(
    [
      grepRow('g1', 'ToolCardShell', 'Found 2 files\na.ts\nb.ts'),
      grepRow('g2', 'FrameEShell', 'app/a.ts:12:hit\napp/b.ts:9:hit'),
    ],
    true,
  )
  const text = visibleText(html)

  expect(text).toContain('ToolCardShell')
  expect(text).toContain('FrameEShell')
  expect(text).toContain('2 files') // mode reported files
  expect(text).toContain('2 matches') // mode reported matches
})

test('a search run sums its members only when they agree on the unit', () => {
  // The sub line lives in the card BODY, so both need the card open.
  const agreeing = renderMany(
    [
      grepRow('g1', 'alpha', 'app/a.ts:1:x\napp/a.ts:2:x'),
      grepRow('g2', 'beta', 'app/b.ts:3:x'),
    ],
    true,
  )
  const mixed = renderMany(
    [
      grepRow('g1', 'alpha', 'Found 2 files\na.ts\nb.ts'),
      grepRow('g2', 'beta', 'app/b.ts:3:x'),
    ],
    true,
  )

  // Agreeing: the prototype's own `M matches · N patterns`.
  expect(agreeing).toContain('3 matches · 2 patterns')
  // Mixed: no invented total, just the pattern count.
  expect(mixed).toContain('>2 patterns<')
  expect(mixed).not.toContain('·')
})

test('a lone search is NOT grouped', () => {
  const html = renderMany([grepRow('g1', 'alpha', 'Found 2 files\na.ts\nb.ts')])

  expect(html).not.toContain('1 patterns')
  expect(visibleText(html)).toContain('alpha')
})

test('reads and searches do not merge under one head', () => {
  const html = renderMany([
    runReadRow('r1', '/w/a.ts'),
    runReadRow('r2', '/w/b.ts'),
    grepRow('g1', 'alpha', 'Found 1 file\na.ts'),
    grepRow('g2', 'beta', 'Found 1 file\nb.ts'),
  ])

  expect(html).toContain('2 files')
  expect(html).toContain('2 patterns')
  expect(occurrences(html, '>Read</span>')).toBe(1)
  expect(occurrences(html, '>Search</span>')).toBe(1)
})

test('a search member expands to its own results, unlike the inert prototype row', () => {
  const html = renderMany(
    [
      grepRow('g1', 'alpha', 'app/a.ts:12:const found = 1'),
      grepRow('g2', 'beta', 'Found 1 file\nb.ts'),
    ],
    true,
  )

  // Grouping must never become a way to lose every search result.
  expect(visibleText(html)).toContain('const found = 1')
})

test('a failed search fails the run and reports no count for that member', () => {
  const html = renderMany([
    grepRow('g1', 'alpha', 'Found 1 file\na.ts'),
    grepRow('g2', 'bad(', 'rg: unclosed group', { status: 'error', isError: true }),
  ])

  expect(occurrences(html, 'failed')).toBe(2)
  expect(html).not.toContain('>done<')
})

// ─── expansion survives a regroup (the deferred CC-27 review finding) ─────────

function renderWithStore(
  rows: NestedTranscriptRow[],
  store: ToolCardExpansionStore,
): string {
  return renderToStaticMarkup(
    <ToolCardExpansionContext.Provider value={store}>
      <TranscriptRowsView rows={rows} />
    </ToolCardExpansionContext.Provider>,
  )
}

test('a read the user opened stays open when the next read folds it into a run', () => {
  // The regression: a lone read is a ToolCard keyed by its row id; the moment a
  // second adjacent read arrives it becomes a ToolRunRow inside a run keyed
  // `read-run:<row id>`. Key AND component type change, so React remounts and
  // local state would die — mid-turn that reads as the file snapping shut.
  const store = createToolCardExpansionStore()
  const first = runReadRow('r1', '/w/a.ts', { content: '1\tDISTINCTIVE_BODY_A' })
  const second = runReadRow('r2', '/w/b.ts', { content: '1\tbody b' })

  const lone = renderWithStore([first], store)
  expect(lone).toContain('aria-expanded="false"')

  // The user opens it.
  store.set(first.kind === 'tool-use' ? first.toolUseId : '', true)
  expect(renderWithStore([first], store)).toContain('aria-expanded="true"')

  // The next read arrives and the pair regroups. The same call is now a run
  // MEMBER, drawn by a different component under a different key.
  const grouped = renderWithStore([first, second], store)
  expect(grouped).toContain('2 files') // it really did regroup
  // And the file the user opened is STILL ON SCREEN: the run opened to hold it.
  expect(visibleText(grouped)).toContain('DISTINCTIVE_BODY_A')
})

test('expansion is keyed by the engine tool_use id, not by row or display key', () => {
  const store = createToolCardExpansionStore()
  const row = runReadRow('r1', '/w/a.ts', { content: '1\tKEYED_BY_TOOL_USE_ID' })
  const toolUseId = row.kind === 'tool-use' ? row.toolUseId : ''

  store.set(toolUseId, true)

  // Same call, two different display shapes, one remembered answer.
  expect(visibleText(renderWithStore([row], store))).toContain('KEYED_BY_TOOL_USE_ID')
  expect(
    visibleText(renderWithStore([row, runReadRow('r2', '/w/b.ts')], store)),
  ).toContain('KEYED_BY_TOOL_USE_ID')
})

test('inline output reveal depth uses the same tool_use-keyed store across regrouping', () => {
  const store = createToolCardExpansionStore()
  const row = runReadRow('r1', '/w/a.ts', { content: '1\tONE' })
  const toolUseId = row.kind === 'tool-use' ? row.toolUseId : ''

  store.setInlineOutputHead(toolUseId, 230)

  expect(store.getInlineOutputHead(toolUseId)).toBe(230)
  expect(
    readFileSync(new URL('./TranscriptView.tsx', import.meta.url), 'utf8'),
  ).toContain('useInlineOutputWindow(\n    source.lines,\n    toolUseId,\n  )')
})

test('a run head keeps its own expansion as the run grows', () => {
  const store = createToolCardExpansionStore()
  const a = runReadRow('r1', '/w/a.ts')
  const b = runReadRow('r2', '/w/b.ts')
  const c = runReadRow('r3', '/w/c.ts')

  const two = renderWithStore([a, b], store)
  expect(two).toContain('2 files')
  expect(two).not.toContain('2 files read') // collapsed: no sub line

  // The user opens the run head, then a third read lands.
  store.set(`run:${a.kind === 'tool-use' ? a.toolUseId : ''}`, true)
  const three = renderWithStore([a, b, c], store)

  expect(three).toContain('3 files read') // still open, now counting three
})

test('a pinned run stays open when a member is closed, siblings intact', () => {
  // The regression this nearly shipped with: the head opened ONLY because a member
  // was open, and that was re-derived every render — so shutting that one file
  // folded the whole group a frame later, siblings and all. The same visible
  // snap-shut the store exists to remove, one level up.
  //
  // The guard is that touching any member pins its run (`ToolRunRow`'s toggle
  // writes `run:<first member id>`), which is what this asserts. The CLICK that
  // does the pinning is an event handler, so it belongs to operator GUI
  // acceptance; what is provable here is that a pinned run survives a closed
  // member, which is the property the user actually feels.
  const store = createToolCardExpansionStore()
  const a = runReadRow('r1', '/w/a.ts', { content: '1\tHELD_OPEN_BODY' })
  const b = runReadRow('r2', '/w/b.ts')
  const idA = a.kind === 'tool-use' ? a.toolUseId : ''

  store.set(idA, true)
  expect(visibleText(renderWithStore([a, b], store))).toContain('HELD_OPEN_BODY')

  // The user shuts that one file; their click pinned the run on the way through.
  store.set(idA, false)
  store.set(`run:${idA}`, true)
  const after = renderWithStore([a, b], store)

  expect(after).toContain('2 files read') // sub line present: head still open
  expect(visibleText(after)).toContain('b.ts') // the sibling did not vanish
  expect(visibleText(after)).not.toContain('HELD_OPEN_BODY') // that file did close
})

test('without the pin, a closed member WOULD have collapsed the run', () => {
  // Pins the reason the pin exists. If `defaultExpanded` ever goes back to being
  // derived from member state alone, the test above would still pass while the
  // user-visible bug returned; this one fails the moment the pin stops mattering.
  const store = createToolCardExpansionStore()
  const a = runReadRow('r1', '/w/a.ts', { content: '1\tHELD_OPEN_BODY' })
  const b = runReadRow('r2', '/w/b.ts')
  const idA = a.kind === 'tool-use' ? a.toolUseId : ''

  store.set(idA, false) // closed, and nothing pinned the run

  expect(renderWithStore([a, b], store)).not.toContain('2 files read')
})

test('a member the user CLOSED does not drag the run head open', () => {
  // The head opens for an explicit `true` only. Storing a `false` (the user shut
  // that member) must not read as "there is something open in here".
  const store = createToolCardExpansionStore()
  const a = runReadRow('r1', '/w/a.ts', { content: '1\tSHUT_BODY' })
  const b = runReadRow('r2', '/w/b.ts')

  store.set(a.kind === 'tool-use' ? a.toolUseId : '', false)
  const html = renderWithStore([a, b], store)

  expect(html).toContain('2 files')
  expect(html).not.toContain('2 files read') // sub line absent: head collapsed
  expect(visibleText(html)).not.toContain('SHUT_BODY')
})

test('the reasoning ceiling renders the newest steps and the head says so', () => {
  // The user asked for "unlimit (max 1000)". Past the ceiling the head must not
  // keep asserting the raw total over a list that no longer contains it.
  const rows = Array.from({ length: 1010 }, (_, index) =>
    thinkingRow(`s:m:${index}:thinking`, `Step number ${index}`),
  )
  const html = renderRows(rows, 'trail')

  expect(html).toContain('1000 of 1010 steps')
  expect(html).not.toContain('>1010 steps<')
  expect(html).toContain('Step number 1009') // newest kept
  expect(html).toContain('Step number 10') // the oldest kept
  expect(html).not.toContain('Step number 9<') // the oldest dropped
})

test('a run under the ceiling states its plain count', () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    thinkingRow(`s:m:${index}:thinking`, `Step ${index}`),
  )

  expect(renderRows(rows, 'trail')).toContain('5 steps')
  expect(renderRows(rows, 'trail')).not.toContain('of 5 steps')
})

// ---------------------------------------------------------------------------
// CC-59: bounded composite containers, at FIRST PAINT.
//
// The window that tracks the pane viewport needs geometry and therefore a real
// browser (`TranscriptView.dom.test.ts`). What this suite covers is the other
// half: the first commit, before any geometry exists, which is also the only
// thing a server render ever produces. It must already be bounded — otherwise a
// pane full of large containers mounts everything once, on the frame that
// matters most.
//
// Every case pairs the mounted bound with the count the chrome prints, because
// the two are meant to disagree: the DOM is windowed, the model is complete.
// ---------------------------------------------------------------------------

/** Children the container actually mounted, counted from the markup. */
function mountedChildCount(html: string): number {
  return occurrences(html, 'data-transcript-child=')
}

test('CC-59: a grouped run of thousands mounts a bounded number and counts them all', () => {
  const store = createToolCardExpansionStore()
  store.set('run:toolu_r0', true) // the head the user opened
  const html = renderWithStore(
    Array.from({ length: 5_000 }, (_, index) =>
      runReadRow(`r${index}`, `/repo/pkg/file${index}.ts`),
    ),
    store,
  )

  expect(html).toContain('5000 files')
  expect(mountedChildCount(html)).toBeGreaterThan(0)
  expect(mountedChildCount(html)).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
  expect(visibleText(html)).toContain('file0.ts')
  expect(visibleText(html)).not.toContain('file4999.ts')
})

test('CC-59: an expanded nested transcript mounts a bounded number and counts them all', () => {
  const store = createToolCardExpansionStore()
  store.set('toolu_agent_solo', true)
  const children = Array.from({ length: 5_000 }, (_, index) =>
    toolRow({
      id: `bash-${index}`,
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: `echo ${index}` },
      status: 'success',
      result: { content: `out ${index}`, isError: false, diff: null },
    }),
  )
  const html = renderWithStore(
    [agentRow('solo', { subagent_type: 'Explore' }, 'success', children)],
    store,
  )

  expect(html).toContain('5000 tool calls')
  expect(mountedChildCount(html)).toBeGreaterThan(0)
  expect(mountedChildCount(html)).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
})

test('CC-59: a delegate group of thousands mounts a bounded number and counts them all', () => {
  const html = renderWithStore(
    Array.from({ length: 5_000 }, (_, index) =>
      agentRow(`d${index}`, { subagent_type: 'Explore' }, 'success'),
    ),
    createToolCardExpansionStore(),
  )

  // The label counts every member; the face stack is a glance, not a census, so
  // a group of thousands must not put thousands of stamps in its own header.
  expect(html).toContain('5000 explore workers')
  expect(html.match(/shape-rendering/g) ?? []).not.toHaveLength(5_000)
  expect(mountedChildCount(html)).toBeGreaterThan(0)
  expect(mountedChildCount(html)).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
})

test('CC-59: a container under the ceiling still mounts every child', () => {
  // The bound must not become a truncation the reader can hit in ordinary use.
  const store = createToolCardExpansionStore()
  store.set('run:toolu_r0', true)
  const html = renderWithStore(
    Array.from({ length: 6 }, (_, index) =>
      runReadRow(`r${index}`, `/repo/pkg/file${index}.ts`),
    ),
    store,
  )

  expect(html).toContain('6 files')
  expect(mountedChildCount(html)).toBe(6)
  expect(visibleText(html)).toContain('file5.ts')
})

test('CC-59: a folded reasoning run stays folded through a remount', () => {
  // The run unmounts whenever it leaves a container's mounted range, so its
  // fold cannot live in component state.
  const store = createToolCardExpansionStore()
  const rows = [
    thinkingRow('s:m:0:thinking', 'Reading the seam'),
    thinkingRow('s:m:1:thinking', 'Checking the projector'),
  ]

  expect(
    renderToStaticMarkup(
      <ToolCardExpansionContext.Provider value={store}>
        <TranscriptRowsView rows={rows} />
      </ToolCardExpansionContext.Provider>,
    ),
  ).toContain('aria-expanded="true"')

  // The RUN's id, not the first visible step's. See the streaming case below.
  store.set('reasoning-run:s:m:0:thinking', false)

  const folded = renderToStaticMarkup(
    <ToolCardExpansionContext.Provider value={store}>
      <TranscriptRowsView rows={rows} />
    </ToolCardExpansionContext.Provider>,
  )
  expect(folded).toContain('aria-expanded="false"')
  expect(folded).toContain('2 steps') // the head still counts the whole run
  expect(folded).not.toContain('Checking the projector')
})

/**
 * Review finding: the fold key was minted from the first VISIBLE step. A first
 * member still streaming has no visible step, so the key pointed at the second
 * member and flipped the moment the first member's content arrived, springing
 * the run the user had folded back open.
 */
test('CC-59: a folded reasoning run stays folded when its first member fills in', () => {
  const store = createToolCardExpansionStore()
  // Three members so the run is still collapsible while the first is empty.
  const streaming = [
    thinkingRow('s:m:0:thinking', ''),
    thinkingRow('s:m:1:thinking', 'Checking the projector'),
    thinkingRow('s:m:2:thinking', 'Reading the seam'),
  ]
  const settled = [
    thinkingRow('s:m:0:thinking', 'Planning the change'),
    thinkingRow('s:m:1:thinking', 'Checking the projector'),
    thinkingRow('s:m:2:thinking', 'Reading the seam'),
  ]
  const render = (rows: typeof streaming) =>
    renderToStaticMarkup(
      <ToolCardExpansionContext.Provider value={store}>
        <TranscriptRowsView rows={rows} />
      </ToolCardExpansionContext.Provider>,
    )

  render(streaming)
  store.set('reasoning-run:s:m:0:thinking', false)

  expect(render(streaming)).toContain('aria-expanded="false"')
  expect(render(settled)).toContain('aria-expanded="false"')
})

test('a restored Agent card whose steps did not survive says so, and quietly', () => {
  // Built from the REAL projection, like the orphan guard above: the discriminator
  // lives in the nesting selector, so hand-made rows would prove nothing.
  let state = createTranscriptState()
  state = projectServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 's',
    engineSessionId: 'engine-s',
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
  state = projectServerFrame(state, {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 's',
    requestId: 'catcode.history-truncated',
    code: 'internal_error',
    message: 'Only the most recent messages are shown.',
    retryable: false,
  })
  const restored: SDKMessage[] = [
    {
      type: 'assistant',
      message: {
        id: 'msg_spawn',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent_restored',
            name: 'Agent',
            input: { subagent_type: 'Explore', description: 'Find the owner files' },
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 's',
      uuid: '00000000-0000-4000-8000-0000000037c1',
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_agent_restored',
            content: 'the owner files are app/renderer/src/TranscriptView.tsx',
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: 's',
      uuid: '00000000-0000-4000-8000-0000000037c2',
    },
  ]
  for (const message of restored) {
    state = projectServerFrame(state, {
      kind: 'event',
      protocolVersion: 1,
      sessionId: 's',
      event: { type: 'message', message },
    })
  }

  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={selectNestedTranscriptRows(state, 's')} />,
  )

  expect(html).toContain("This agent&#x27;s steps aren&#x27;t loaded.")
  // Not an error: no danger tone, and the card keeps its ordinary chrome.
  expect(html).not.toContain('tone-danger')
})

/* ---------------------------------------------------------------------------
 * The top of an incomplete transcript, and the way out of it
 * (decisions/HISTORY-LOAD-EARLIER.md).
 *
 * WHAT THESE CANNOT PROVE. This suite renders to static markup, so no click is
 * ever delivered: what a press does is App's wiring and the sidecar's answer,
 * and only a live window shows it. What is proven here is the whole of the
 * decision that lives in this component — which panes get the control, what it
 * says, and that a refusal is readable without taking the control away.
 * --------------------------------------------------------------------------- */

const historyBoundaryRow: NestedTranscriptRow = {
  ...frameSource,
  id: 's:history-boundary',
  kind: 'history-boundary',
}

test('an incomplete transcript offers the way out of itself', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[historyBoundaryRow]} onLoadEarlier={() => {}} />,
  )
  expect(html).toContain('Earlier messages from this session aren')
  expect(html).toContain('Load earlier messages')
})

test('a whole transcript has no boundary row, so it has no control', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[userRow('carry on')]}
      onLoadEarlier={() => {}}
    />,
  )
  expect(html).not.toContain('Load earlier messages')
  expect(html).not.toContain('Earlier messages from this session aren')
})

test('a pane with nothing to ask keeps the row and drops the control', () => {
  // The preview case: a cached transcript with no engine behind it. The row is
  // a fact about the transcript and stays; the control would have nowhere to
  // send the ask. Engaging with the session is what gains it.
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[historyBoundaryRow]} restorePhase="preview" />,
  )
  expect(html).toContain('Earlier messages from this session aren')
  expect(html).not.toContain('Load earlier messages')
})

test('a read in flight says so and cannot be pressed again', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[historyBoundaryRow]}
      loadEarlierPending
      onLoadEarlier={() => {}}
    />,
  )
  expect(html).toContain('Loading')
  expect(html).not.toContain('Load earlier messages')
  expect(html).toContain('disabled=""')
  expect(html).toContain('aria-busy="true"')
})

test('a read that did not work says so, and the control stays usable', () => {
  // The refusal's own sentence, which is written for a reader. Not a toast: the
  // row is what was pressed, and it is where it will be pressed again.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[historyBoundaryRow]}
      loadEarlierFailure="Already loading earlier messages."
      onLoadEarlier={() => {}}
    />,
  )
  expect(html).toContain('Already loading earlier messages.')
  expect(html).toContain('Load earlier messages')
  expect(html).not.toContain('disabled=""')
})

test('a pane with no control has nothing to report about a read', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[historyBoundaryRow]}
      loadEarlierFailure="Already loading earlier messages."
    />,
  )
  expect(html).not.toContain('Already loading earlier messages.')
})

test('every row publishes its identity, which is what the reading position holds', () => {
  // `transcriptScrollMemory` reads this attribute back off the DOM. Rows
  // recovered above the reader renumber the list, and an anchor that named a
  // position would be discarded at exactly that moment (B5).
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[historyBoundaryRow, userRow('carry on')]} />,
  )
  expect(html).toContain(`${TRANSCRIPT_ROW_KEY_ATTRIBUTE}="s:history-boundary"`)
  expect(html).toContain(`${TRANSCRIPT_ROW_KEY_ATTRIBUTE}="s:m:0:user-text"`)
})

test('assistant prose renders markdown links and inline paths as file action buttons', () => {
  const markdownRow = assistantRow(
    'Check out [foo.ts](src/foo.ts) and also `src/utils/bar.ts` for details.',
  )
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[markdownRow]} cwd="/Users/test/cat-code" />,
  )
  expect(html).toContain('aria-label="Open src/foo.ts"')
  expect(html).toContain('aria-label="Open src/utils/bar.ts"')
  expect(html).toContain('<svg')
})

/* ── compaction (2026-08-22) ───────────────────────────────────────────────
 * Two rows for one event, one of them advertising a shortcut this app does not
 * have, and a trigger word nobody reads. What is left is one seam, plus a live
 * element while the compaction actually runs. */

const compactBoundaryRow: NestedTranscriptRow = {
  ...frameSource,
  id: 'compact-1',
  kind: 'compact-boundary',
  trigger: 'manual',
  preTokens: 147150,
}

test('the compaction seam names the event and nothing else', () => {
  const html = render(compactBoundaryRow)
  expect(html).toContain('Conversation compacted')
  // Both still ride the row, and the inspector reads them off the raw frame
  // (`messageMetadata.ts` `readCompaction`); the seam just stopped printing them.
  expect(html).not.toContain('manual')
  expect(html).not.toContain('147,150')
})

test('the live seam mounts only while a compaction runs, and never doubles up', () => {
  const idle = renderToStaticMarkup(
    <TranscriptRowsView rows={[compactBoundaryRow]} />,
  )
  expect(idle).not.toContain('Compacting conversation')

  const live = renderToStaticMarkup(
    <TranscriptRowsView rows={[compactBoundaryRow]} compacting />,
  )
  expect(live).toContain('Compacting conversation')
  // Same geometry as the settled seam it hands off to, so the swap reads as one
  // element resolving rather than a second row appearing.
  expect(live).toContain('animate-compact-sweep-left')
  expect(live).toContain('animate-compact-sweep-right')

  // An empty pane has no transcript column to hang it on, and a compaction
  // cannot happen there anyway.
  expect(
    renderToStaticMarkup(<TranscriptRowsView rows={[]} compacting />),
  ).not.toContain('Compacting conversation')
})

// ─── bash card hover label (operator call, 2026-08-23) ───────────────────────

function bashRow(input: Record<string, unknown>) {
  return toolRow({
    toolName: 'Bash',
    toolFamily: 'bash',
    input,
    status: 'success',
    result: { isError: false, content: 'src/auth.ts:12', diff: null },
  })
}

test('a bash card keeps the command and hides the description behind hover', () => {
  const html = render(
    bashRow({
      command: 'rg -n auth src/ | head -20',
      description: 'Check auth handling',
    }),
  )

  // The header still reads as a command, which is the whole point of the call.
  expect(html).toContain('rg -n auth src/ | head -20')
  expect(html).toContain('Check auth handling')
  // Reachable without a pointer, since the header is a button.
  expect(html).toContain('group-hover:inline')
  expect(html).toContain('group-focus-visible:inline')
})

test('a bash card with no description renders no swap at all', () => {
  const html = render(bashRow({ command: 'git status' }))

  expect(html).toContain('git status')
  expect(html).not.toContain('group-hover:inline')
})

test('a bash card reveals a first-line comment when no description was sent', () => {
  const html = render(
    bashRow({ command: '# Inspect auth handling\nrg -n auth src/' }),
  )

  // Header keeps the command verbatim, comment included.
  expect(html).toContain('# Inspect auth handling')
  // The stripped label is what the hover shows.
  expect(html).toContain('>Inspect auth handling<')
  expect(html).toContain('group-hover:inline')
})

test('a bash card whose description repeats the command reveals nothing', () => {
  const html = render(
    bashRow({ command: 'git status', description: 'git status' }),
  )

  expect(html).not.toContain('group-hover:inline')
})
