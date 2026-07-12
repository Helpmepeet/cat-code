import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  App,
  ConnectionRecovery,
  SessionPane,
  buildDebugExport,
  deriveActivity,
  fmtElapsed,
  fmtTok,
  reducePromptDrafts,
  selectLiveTokenEstimate,
  selectPromptDraft,
  sendPermissionResponse,
} from './App.js'
import { createTranscriptState } from './transcriptProjector.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

test('renders the shell frame (TabBar + empty state) before any session exists', () => {
  // SSR runs no effects, so the host list never resolves — the shell mounts
  // with an empty roster. The frame is still whole: the TabBar chrome and a
  // new-session affordance are present, and the empty state is the P4-17
  // WelcomeScreen launcher inviting the first session (HC1 — created only via
  // the picker, never a typed path).
  const html = renderToStaticMarkup(<App />)

  expect(html).toContain('role="tablist"')
  expect(html).toContain('aria-label="Sessions"')
  expect(html).toContain('aria-label="New session"')
  expect(html).toContain('Welcome back')
  expect(html).toContain('Open a project')
  // No active-session pane chrome without a session.
  expect(html).not.toContain('aria-label="Prompt"')
  expect(html).not.toContain('Transcript (projected)')
})

test('P4-24: the active session pane renders the multi-line composer + transcript spine', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        status: 'ready',
        restorable: false,
        createdAt: 0,
        lastAttachedAt: 0,
      }}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeSessionId="session-1"
      allowPermission={() => {}}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={[]}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      prompt=""
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('aria-label="Prompt"')
  // P4-24: the composer is a multi-line auto-resizing <textarea>, not the old
  // single-line <input>.
  expect(html).toContain('<textarea')
  // P4-24 reflow: "Copy for LLM" is a developer affordance, now DEV-gated
  // (mirrors the raw-events panel) — absent from a default/production pane.
  expect(html).not.toContain('Copy for LLM')
  // P4-24: permission mode is now a compact chip in the composer actions row
  // (Chat.jsx:302 `PermChip`), not a "Permissions" <details> box.
  expect(html).toContain('Permission mode:')
  // P4-24 reflow: the transcript is the primary surface, ABOVE the docked
  // composer (Chat.jsx grammar: read above, type below) — the composer is no
  // longer pinned to the top of the pane.
  expect(html.indexOf('<section')).toBeLessThan(
    html.indexOf('aria-label="Composer"'),
  )
  // P4-24: the scaffold <h1>Transcript</h1> heading is dropped (full-bleed).
  expect(html).not.toContain('Transcript</h1>')
  // Idle (inputEnabled) session shows no activity indicator / Stop control.
  expect(html).not.toContain('■ Stop')
  // P4-24: the raw-SDKMessage inspector is hidden by default (opt-in dev flag),
  // absent under `bun test`. With the Permissions <details> box now a chip, a
  // clean idle pane has NO disclosure box at all.
  expect(html).not.toContain('Raw SDKMessage events')
  expect(html).not.toContain('<details')
  expect(html).not.toContain('<pre')
  // P4-24 reflow: the pane has NO debug header — the cwd is not surfaced here
  // (it lives in the TabBar; the prototype ChatView has no header row, and the
  // "Copy for LLM" dev button is gone from the surface).
  expect(html).not.toContain('/tmp/project')
  // P4-24: the composer is borderless (Chat.jsx:1407) with a pink send-ARROW
  // icon button, not a bordered box with a labelled "Send" button.
  expect(html).toContain('bg-transparent')
  expect(html).toContain('aria-label="Send prompt"')
})

test('P4-18c: a generating session (ready + input disabled) shows the activity indicator + Stop', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      activeConnection={{ status: 'ready', inputEnabled: false }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        status: 'ready',
        restorable: false,
        createdAt: 0,
        lastAttachedAt: 0,
      }}
      activeLog={{
        inputEnabled: false,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeSessionId="session-1"
      allowPermission={() => {}}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={[]}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      prompt=""
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('■ Stop') // interrupt control wired to app.abort
  expect(html).toContain('Working') // derived verb (empty transcript tail)
})

// ── P4-18c activity helpers ─────────────────────────────────────────────────

function blockRow(
  extra: Partial<NestedTranscriptRow> & { kind: NestedTranscriptRow['kind'] },
): NestedTranscriptRow {
  return {
    id: 's:m:0:x',
    sessionId: 's',
    messageId: 'm',
    frameId: 'f',
    blockIndex: 0,
    parentToolUseId: null,
    children: [],
    ...extra,
  } as NestedTranscriptRow
}

test('P4-18c deriveActivity: pending tool → Running <tool>, thinking → Thinking, streaming → Responding', () => {
  expect(deriveActivity([])).toEqual({ verb: 'Working', target: null })
  expect(
    deriveActivity([
      blockRow({
        kind: 'tool-use',
        toolUseId: 'u',
        toolName: 'Bash',
        toolFamily: 'bash',
        input: {},
        status: 'pending',
        result: null,
      }),
    ]),
  ).toEqual({ verb: 'Running', target: 'Bash' })
  expect(
    deriveActivity([blockRow({ kind: 'thinking', content: 'hmm' })]),
  ).toEqual({ verb: 'Thinking', target: null })
  expect(
    deriveActivity([
      blockRow({
        kind: 'assistant-text',
        role: 'assistant',
        content: 'partial',
        isStreaming: true,
      }),
    ]),
  ).toEqual({ verb: 'Responding', target: null })
})

test('P4-18c fmtElapsed formats seconds and minutes', () => {
  expect(fmtElapsed(0)).toBe('0s')
  expect(fmtElapsed(5200)).toBe('5s')
  expect(fmtElapsed(65_000)).toBe('1m 05s')
})

test('P4-18 fmtTok: raw below 1k, N.Nk to 100k, Nk above (matches Chat.jsx:134)', () => {
  expect(fmtTok(0)).toBe('0')
  expect(fmtTok(999)).toBe('999')
  expect(fmtTok(1000)).toBe('1k')
  expect(fmtTok(1200)).toBe('1.2k')
  expect(fmtTok(120_000)).toBe('120k')
})

test('P4-18 selectLiveTokenEstimate: current-turn output ÷ 4; prior turns excluded; no boundary → 0', () => {
  // No user boundary present → 0, so a retained transcript never leaks as a
  // huge count (fail to "no estimate", never to a wrong large number).
  expect(
    selectLiveTokenEstimate([
      blockRow({ kind: 'assistant-text', role: 'assistant', content: 'x'.repeat(80) }),
    ]),
  ).toBe(0)

  const rows: NestedTranscriptRow[] = [
    blockRow({ kind: 'user-text' }),
    // Prior turn's reply — MUST be excluded (it precedes the last boundary).
    blockRow({ kind: 'assistant-text', role: 'assistant', content: 'p'.repeat(400) }),
    blockRow({ kind: 'user-text' }), // ← current turn starts here
    blockRow({
      kind: 'assistant-text',
      role: 'assistant',
      content: 'a'.repeat(38),
      isStreaming: true,
    }),
    blockRow({
      kind: 'tool-use',
      toolUseId: 'u',
      toolName: 'Bash',
      toolFamily: 'bash',
      input: {}, // JSON.stringify({}) → "{}" = 2 chars
      status: 'pending',
      result: null,
    }),
  ]
  // (38 + 2) / 4 = 10; the 400-char prior reply does not count.
  expect(selectLiveTokenEstimate(rows)).toBe(10)
})

test('composer form owns the ↑/↓ history key scope', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        status: 'ready',
        restorable: false,
        createdAt: 0,
        lastAttachedAt: 0,
      }}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeSessionId="session-1"
      allowPermission={() => {}}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={['first prompt', 'second prompt']}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      prompt=""
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('aria-label="Composer"')
  expect(html).toContain('aria-keyshortcuts="ArrowUp ArrowDown"')
})

test('P4-24: collapsed-paste pills render with token label, remove control, and preview body', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        status: 'ready',
        restorable: false,
        createdAt: 0,
        lastAttachedAt: 0,
      }}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeSessionId="session-1"
      allowPermission={() => {}}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      history={[]}
      mentionItems={[]}
      onApprovePlan={() => {}}
      onPaste={() => {}}
      onRemovePaste={() => {}}
      onRevisePlan={() => {}}
      partialCount={0}
      pastes={[{ id: 1, content: 'line A\nline B\nline C', numLines: 2 }]}
      permissionContext={null}
      permissionQueue={[]}
      planReview={null}
      prompt="see [Pasted text #1 +2 lines]"
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  // The re-skinned pill strip (replaces the old <details>-beside adaptation).
  expect(html).toContain('aria-label="Collapsed pastes"')
  // Pill label = the exact [Pasted text #N +M lines] token.
  expect(html).toContain('[Pasted text #1 +2 lines]')
  // Per-pill × remove control, and a hover/keyboard-focus full-text preview.
  expect(html).toContain('aria-label="Remove paste"')
  expect(html).toContain('role="tooltip"')
  expect(html).toContain('line A') // preview body is in the DOM (revealed on hover/focus)
  expect(html).toContain('line C')
  // Honest attach affordance: a labelled control, not a silent dead button and
  // not an invented file picker (no engine attachment capability on the wire).
  expect(html).toContain('aria-label="Add attachment"')
})

test('debug export explicitly marks lossy raw-message retention', () => {
  const text = buildDebugExport([], {
    inputEnabled: true,
    messages: [{ type: 'result', subtype: 'success' }],
    retainedBytes: 42,
    truncated: true,
    error: null,
    messageBytes: [42],
  })

  expect(text).toContain('Raw retention: TRUNCATED')
  expect(text).toContain('"type": "result"')
})

test('renders a restart control only for a terminal session state', () => {
  const terminal = renderToStaticMarkup(
    <ConnectionRecovery
      connection={{ status: 'disconnected', inputEnabled: false }}
      sessionId="session-1"
    />,
  )
  const ready = renderToStaticMarkup(
    <ConnectionRecovery
      connection={{ status: 'ready', inputEnabled: true }}
      sessionId="session-1"
    />,
  )

  expect(terminal).toContain('Restart')
  expect(ready).not.toContain('Restart')
})

test('permission bridge failures are returned to the caller for reducer recovery', () => {
  const error = sendPermissionResponse(
    {
      respondPermission() {
        throw new Error('renderer IPC rate limit exceeded')
      },
    },
    'session-1',
    'perm-1',
    { behavior: 'allow', updatedInput: {} },
  )

  expect(error).toBe('renderer IPC rate limit exceeded')
})

test('prompt drafts are isolated by active session id', () => {
  let drafts = reducePromptDrafts({}, 'session-a', 'draft for A')
  drafts = reducePromptDrafts(drafts, 'session-b', 'draft for B')

  expect(selectPromptDraft(drafts, 'session-a')).toBe('draft for A')
  expect(selectPromptDraft(drafts, 'session-b')).toBe('draft for B')
  expect(selectPromptDraft(drafts, null)).toBe('')
})
