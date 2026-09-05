import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentModeWorkerItem } from '../../shared/protocol.js'
import {
  PermissionPrompt,
} from './PermissionPrompt.js'
import {
  buildChangeLines,
  buildPermissionOptions,
  formatPermissionInput,
  permissionKeyIntent,
  permissionKeysAreLive,
  permissionKickerForTool,
  permissionTitleIsInlineCommand,
  PERMISSION_KEY_HOST_ATTR,
  PERMISSION_TITLE_COMMAND_MAX,
  selectPermissionPreview,
  summariseCommandForTitle,
} from './permissionPromptModel.js'
import type { PermissionRequest } from './permissionState.js'
import {
  AgentFaceRegistryContext,
  createAgentFaceRegistry,
  faceHash,
  FACE_FILL_COUNT,
} from './agentFace.js'
import { AGENT_FACE_IDENTITY_FILL } from './agentChromeModel.js'

const REQUEST: PermissionRequest = {
  requestId: 'perm-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'date' },
    tool_use_id: 'toolu-1',
  },
}

function worker(
  over: Partial<AgentModeWorkerItem> = {},
): AgentModeWorkerItem {
  return {
    agentId: 'worker-42',
    handle: 'Vale',
    role: 'coding-worker',
    status: 'running',
    description: 'Check the failing test',
    ...over,
  }
}

test('the command is the headline, and the answer is a numbered select list', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      keyboardTarget
      onAllow={() => {}}
      onDeny={() => {}}
      request={REQUEST}
    />,
  )

  // The prototype's headline IS the command (`Permissions.jsx:465-471`). The
  // dead `request.title` binding used to print a constant instead: the engine's
  // own producer never sets that field (`appRuntimeCanUseTool.ts:64-73`), so
  // every card read "Permission required" and named no command anywhere.
  expect(html).not.toContain('Permission required')
  expect(html).toContain('>date<')
  expect(html).toContain('Allow')
  // Kicker row.
  expect(html).toContain('Permission')
  // The rows, in the prototype's order and words.
  expect(html).toContain('>Yes<')
  expect(html).toContain('No, and tell Cat Code what to do differently')
  expect(html).toContain('>esc<')
  expect(html).toContain('>1<')
  expect(html).toContain('>2<')
  // The old discrete buttons are gone: the refusal is a row, not a Deny button
  // sitting left of Allow.
  expect(html).not.toContain('>Deny<')
  // The free-text deny field the prototype never had is gone with it.
  expect(html).not.toContain('Deny feedback')
  // The command is the title, so it is not repeated in a body block.
  expect(html).not.toContain('COMMAND')
  expect(html).not.toContain('&quot;command&quot;: &quot;date&quot;')
  // …and the exact input is still one click away, collapsed, in the footer.
  expect(html).toContain('Show input')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('↑↓ · 1–9 · ↵ · esc')
  // No engine-minted suggestions on this request → no rule row.
  expect(html).not.toContain("don't ask again")
})

test('a long or multi-line command is summarised in the title AND kept in full', () => {
  const command = `for f in *.ts; do\n  echo "$f"\ndone`
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        ...REQUEST,
        request: { ...REQUEST.request, input: { command } },
      }}
    />,
  )
  // The headline carries the first line with an ellipsis…
  expect(html).toContain('for f in *.ts; do …')
  // …and the body block still shows every line, so shortening hides nothing.
  expect(html).toContain('Command')
  expect(html).toContain('echo &quot;$f&quot;')
  expect(html).toContain('done')
})

test('summariseCommandForTitle cuts only what a headline cannot hold', () => {
  expect(summariseCommandForTitle('ls -la')).toEqual({
    text: 'ls -la',
    truncated: false,
  })
  expect(summariseCommandForTitle('a\nb')).toEqual({
    text: 'a …',
    truncated: true,
  })
  // A trailing newline is not a second line. Measuring against the raw string
  // reported every one of these as truncated, which put a misleading ellipsis in
  // the headline and re-rendered the body block for a command that fitted.
  expect(summariseCommandForTitle('ls -la\n')).toEqual({
    text: 'ls -la',
    truncated: false,
  })
  expect(summariseCommandForTitle('ls -la\n\n  \n')).toEqual({
    text: 'ls -la',
    truncated: false,
  })
  // A command that OPENS with a newline used to yield an empty headline chip
  // reading "Allow  …?", naming nothing: the defect the headline exists to fix.
  // Surrounding whitespace is stripped at BOTH ends, so this is not truncation
  // either — reporting it as such put an ellipsis on a command that fitted.
  expect(summariseCommandForTitle('\ngit status')).toEqual({
    text: 'git status',
    truncated: false,
  })
  expect(summariseCommandForTitle('\n\n  git status  \n\n')).toEqual({
    text: 'git status',
    truncated: false,
  })
  // A leading blank line before a genuinely multi-line command still truncates.
  expect(summariseCommandForTitle('\ngit status\ngit log')).toEqual({
    text: 'git status …',
    truncated: true,
  })
  // CRLF must not leave a stray carriage return in the chip.
  expect(summariseCommandForTitle('ls -la\r\necho hi')).toEqual({
    text: 'ls -la …',
    truncated: true,
  })
  // Nothing but whitespace has no headline to offer at all.
  expect(summariseCommandForTitle('  \n\t\n')).toEqual({
    text: '',
    truncated: false,
  })
  const long = 'x'.repeat(PERMISSION_TITLE_COMMAND_MAX + 5)
  const summary = summariseCommandForTitle(long)
  expect(summary.truncated).toBe(true)
  expect(summary.text).toBe(`${'x'.repeat(PERMISSION_TITLE_COMMAND_MAX)} …`)
  // A command exactly at the cap is still whole.
  const exact = 'y'.repeat(PERMISSION_TITLE_COMMAND_MAX)
  expect(summariseCommandForTitle(exact)).toEqual({
    text: exact,
    truncated: false,
  })
})

test('a non-command family keeps a plain headline and a labelled body block', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        requestId: 'perm-read',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Read',
          input: { file_path: '/repo/a.ts' },
          tool_use_id: 'toolu-read',
        },
      }}
    />,
  )
  expect(html).toContain('Allow Read?')
  expect(html).toContain('Filesystem')
  expect(html).toContain('Path')
  expect(html).toContain('/repo/a.ts')
})

test('an engine-supplied title still wins over the derived one', () => {
  // `title`/`display_name` are optional on the wire and the desktop producer
  // sets neither, but another producer may; the derived headline is a fallback,
  // not a replacement.
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        requestId: 'perm-titled',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Read',
          input: { file_path: '/repo/a.ts' },
          tool_use_id: 'toolu-titled',
          title: 'Read a protected file',
        },
      }}
    />,
  )
  expect(html).toContain('Read a protected file')
  expect(html).not.toContain('Allow Read?')
})

test('an engine title outranks the inline command headline too', () => {
  // The previous shape read `title` only in the NON-command branch, so "a
  // supplied title wins" was true for every family except the two the card is
  // mostly about.
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        ...REQUEST,
        request: { ...REQUEST.request, title: 'Run a release script' },
      }}
    />,
  )
  expect(html).toContain('Run a release script')
  // The command is still shown, in the body block, so nothing is lost.
  expect(html).toContain('Command')
  expect(html).toContain('>date<')
})

test('a relayed request reads as running another agent command', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        ...REQUEST,
        request: { ...REQUEST.request, agent_id: 'worker-42' },
      }}
      workers={[worker()]}
    />,
  )
  // The prototype's own verb and kicker for a relayed ask
  // (`Permissions.jsx:467`, `PV.worker`).
  expect(html).toContain('Run')
  expect(html).not.toContain('>Allow<')
  expect(html).toContain('Worker request')
  // Bare name: the at-sign is engine mention syntax and never reaches the screen
  // (operator ruling, 2026-08-21).
  expect(html).toContain(
    '<span class="font-mono text-violet-300">Vale</span>, a coding worker. You decide.',
  )
  expect(html).toContain('Relayed from ')
  expect(html).not.toContain('@Vale')
  // The relaying worker's own stamp rides beside the name.
  expect(html).toContain('shape-rendering="crispEdges"')
})

test('the relayed card draws from the session registry, not the raw hash', () => {
  // The test above proves a stamp is THERE, which it would be even if this card
  // minted its own face and disagreed with the roster and the transcript about
  // who this worker is. Colour is the discriminator: squat the worker's hashed
  // fill so a shared registry has to move it off, and a card that never reads
  // one cannot know to.
  const registry = createAgentFaceRegistry()
  const hashedFill = faceHash('worker-42', 8) % FACE_FILL_COUNT
  for (let index = 0; index < FACE_FILL_COUNT; index += 1) {
    if (registry.faceFor(`squatter-${index}`).fill === hashedFill) break
  }
  const shared = registry.faceFor('worker-42', 'Vale')
  expect(shared.fill).not.toBe(hashedFill)

  const html = renderToStaticMarkup(
    <AgentFaceRegistryContext.Provider value={registry}>
      <PermissionPrompt
        onAllow={() => {}}
        onDeny={() => {}}
        request={{
          ...REQUEST,
          request: { ...REQUEST.request, agent_id: 'worker-42' },
        }}
        workers={[worker()]}
      />
    </AgentFaceRegistryContext.Provider>,
  )

  expect(html).toContain(AGENT_FACE_IDENTITY_FILL[shared.fill])
  expect(html).not.toContain(AGENT_FACE_IDENTITY_FILL[hashedFill])

  // And the discriminator really discriminates: with no session above it, the
  // card falls back to the unscoped hash and draws the squatted colour. Without
  // this line the asserts above could hold for a card that reads no registry.
  expect(
    renderToStaticMarkup(
      <PermissionPrompt
        onAllow={() => {}}
        onDeny={() => {}}
        request={{
          ...REQUEST,
          request: { ...REQUEST.request, agent_id: 'worker-42' },
        }}
        workers={[worker()]}
      />,
    ),
  ).toContain(AGENT_FACE_IDENTITY_FILL[hashedFill])
})

test('a relayed request with an unnamed worker names the engine role only', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        ...REQUEST,
        request: { ...REQUEST.request, agent_id: 'worker-42' },
      }}
      workers={[worker({ handle: null })]}
    />,
  )

  expect(html).toContain('Relayed from a coding worker. You decide.')
  expect(html).not.toContain('worker-42')
  expect(html).not.toContain('@Vale')
})

test('an unmatched relay id degrades to the role-only fallback', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        ...REQUEST,
        request: { ...REQUEST.request, agent_id: 'worker-missing' },
      }}
      workers={[worker()]}
    />,
  )

  expect(html).toContain('Relayed from a coding worker. You decide.')
  expect(html).not.toContain('worker-missing')
  expect(html).not.toContain('@Vale')
})

test('a rule row never prints a raw engine behavior word', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        ...REQUEST,
        request: {
          ...REQUEST.request,
          permission_suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
              behavior: 'deny',
              destination: 'userSettings',
            },
          ],
        },
      }}
    />,
  )
  // It used to read "Yes, and deny `Bash(rm:*)`".
  expect(html).toContain('Yes, and always block ')
  expect(html).not.toContain('Yes, and deny ')
})

test('an empty title or agent_id is treated as absent, not as present', () => {
  // Both are optional on the wire and may arrive empty. `??` is nullish, not
  // falsy, so `title: ''` used to beat the derived headline and render a blank
  // <h2>; `agent_id: ''` used to make the kicker say relayed while the badge,
  // the verb and the relay line all said otherwise.
  const emptyTitle = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{ ...REQUEST, request: { ...REQUEST.request, title: '' } }}
    />,
  )
  expect(emptyTitle).toContain('>date<')
  expect(emptyTitle).not.toContain('<h2 class="mt-2 text-sm font-semibold leading-snug text-text-primary" id="permission-title-perm-1"></h2>')

  const emptyAgent = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{ ...REQUEST, request: { ...REQUEST.request, agent_id: '' } }}
    />,
  )
  // Every relayed surface agrees: not relayed.
  expect(emptyAgent).not.toContain('Worker request')
  expect(emptyAgent).not.toContain('>worker<')
  expect(emptyAgent).not.toContain('Relayed from worker')
  expect(emptyAgent).toContain('Allow')
})

test('a relayed card agrees with itself across all four surfaces', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        requestId: 'perm-relay-web',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'WebFetch',
          input: { url: 'https://a.dev' },
          tool_use_id: 'toolu-relay',
          agent_id: 'worker-7',
        },
      }}
    />,
  )
  // Kicker, badge, verb and relay line all say relayed…
  expect(html).toContain('Worker request')
  expect(html).toContain('>worker<')
  expect(html).toContain('Run WebFetch?')
  expect(html).toContain('Relayed from a coding worker. You decide.')
  expect(html).not.toContain('worker-7')
  // …and so does the GLYPH. Fed only the tool name it drew the globe under a
  // "Worker request" caption.
  expect(html).toContain('<circle cx="18" cy="6" r="3">')
  expect(html).not.toContain('<line x1="2" y1="12" x2="22" y2="12">')
})

test('kickers key on the same families as the preview switch', () => {
  expect(permissionKickerForTool('Bash')).toBe('Permission')
  expect(permissionKickerForTool('Edit')).toBe('Permission')
  expect(permissionKickerForTool('Read')).toBe('Filesystem')
  expect(permissionKickerForTool('Glob')).toBe('Filesystem')
  expect(permissionKickerForTool('Grep')).toBe('Filesystem')
  expect(permissionKickerForTool('WebFetch')).toBe('Web access')
  expect(permissionKickerForTool('Skill')).toBe('Skill')
  expect(permissionKickerForTool('mcp__x__y')).toBe('Permission')
  // A relayed request takes the prototype's worker kicker whatever the tool is.
  expect(permissionKickerForTool('Bash', true)).toBe('Worker request')
  expect(permissionKickerForTool('WebFetch', true)).toBe('Worker request')
})

test('the inline-command headline is derived from the preview table', () => {
  // These two used to be hand-kept parallel lists, so adding a command family to
  // `previewShapeForTool` silently regressed its headline with no test failing.
  for (const tool of ['Bash', 'PowerShell']) {
    expect(permissionTitleIsInlineCommand(tool)).toBe(true)
    expect(selectPermissionPreview(tool, { command: 'x' })).toEqual({
      kind: 'field',
      label: 'Command',
      value: 'x',
    })
  }
  for (const tool of ['Read', 'Grep', 'WebFetch', 'Skill', 'mcp__x__y']) {
    expect(permissionTitleIsInlineCommand(tool)).toBe(false)
  }
})

test('a tool with no recognised family shows its input, opened', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        requestId: 'perm-mcp',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'mcp__notion__search',
          input: { query: 'roadmap' },
          tool_use_id: 'toolu-mcp',
        },
      }}
    />,
  )
  // Nothing can be promoted honestly, so nothing is hidden either.
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('Hide input')
  expect(html).toContain('&quot;query&quot;: &quot;roadmap&quot;')
})

test('an edit shows its file and the change, with no line numbers anywhere', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        requestId: 'perm-edit',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Edit',
          input: {
            file_path: '/repo/src/server.ts',
            old_string: 'const port = 3000\nstart(port)',
            new_string: 'const port = 8080\nstart(port)',
          },
          tool_use_id: 'toolu-edit',
        },
      }}
    />,
  )
  expect(html).toContain('/repo/src/server.ts')
  expect(html).toContain('const port = 3000')
  expect(html).toContain('const port = 8080')
  expect(html).toContain('+ ')
  expect(html).toContain('− ')
  // A patch over two snippets numbers the SNIPPET, not the file. The gutter the
  // transcript diff carries must not appear here at all.
  expect(html).not.toContain('tabular-nums')
})

test('a write shows the file and the content it would write', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        requestId: 'perm-write',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          input: { file_path: '/repo/notes.md', content: '# Notes\nfirst' },
          tool_use_id: 'toolu-write',
        },
      }}
    />,
  )
  expect(html).toContain('/repo/notes.md')
  expect(html).toContain('# Notes')
  expect(html).toContain('first')
})

test('a fetched URL is promoted as text, never as a link', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        requestId: 'perm-web',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'WebFetch',
          input: { url: 'https://example.com/docs', prompt: 'summarise' },
          tool_use_id: 'toolu-web',
        },
      }}
    />,
  )
  expect(html).toContain('URL')
  expect(html).toContain('https://example.com/docs')
  // Model-authored input never becomes a live control.
  expect(html).not.toContain('<a ')
})

test('a deny-only card offers no allow path at all', () => {
  const request: PermissionRequest = {
    requestId: 'perm-ask',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: { questions: 'not an array' },
      tool_use_id: 'toolu-ask',
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'AskUserQuestion' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    },
  }
  const html = renderToStaticMarkup(
    <PermissionPrompt
      denyOnly
      onAllow={() => {}}
      onDeny={() => {}}
      request={request}
    />,
  )
  // A bare allow here would run the tool with no answers, so no allow row may
  // exist at all — neither the plain "Yes" nor the engine's own suggestion.
  expect(html).not.toContain('>Yes<')
  expect(html).not.toContain("don't ask again")
  // The generic shortcuts skip this request, so the hint would be dead too.
  expect(html).not.toContain('↑↓ · 1–9')
  expect(html).toContain('No, and tell Cat Code what to do differently')
  expect(html).toContain('it can only be denied')
  // The card no longer carries a note field, so it must not tell the user to
  // write in one.
  expect(html).not.toContain('Add a note below')
  expect(html).toContain('Say what you wanted in the composer')
})

test('buildPermissionOptions is the one list both mouse and keyboard read', () => {
  // No suggestions: allow-once, then refuse. Escape belongs to the refuse row.
  expect(buildPermissionOptions(REQUEST.request)).toEqual([
    { id: 'allow', pre: 'Yes', effect: 'allow' },
    {
      id: 'deny',
      pre: 'No, and tell Cat Code what to do differently',
      effect: 'deny',
      esc: true,
    },
  ])

  // One row per ENGINE-minted suggestion, selected by INDEX (C1) — never a
  // client-synthesised scope.
  const withSuggestions = buildPermissionOptions({
    ...REQUEST.request,
    permission_suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'date:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ],
  })
  expect(withSuggestions.map(option => option.id)).toEqual([
    'allow',
    'rule-0',
    'rule-1',
    'deny',
  ])
  expect(withSuggestions[1]).toEqual({
    id: 'rule-0',
    pre: "Yes, and don't ask again for ",
    code: 'Bash(date:*)',
    post: ' · Project settings (local)',
    effect: 'rule',
    suggestionIndex: 0,
  })
  expect(withSuggestions[2]?.suggestionIndex).toBe(1)
  expect(withSuggestions[2]?.code).toBe('Accept edits')

  // denyOnly drops every allow path, so row 1 is the refusal itself.
  const denyOnly = buildPermissionOptions(REQUEST.request, true)
  expect(denyOnly).toHaveLength(1)
  expect(denyOnly[0]?.effect).toBe('deny')
})

test('renders worker-relay chrome from the engine request agent_id', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={{
        ...REQUEST,
        request: { ...REQUEST.request, agent_id: 'worker-42' },
      }}
      workers={[worker()]}
    />,
  )
  expect(html).toContain('>worker<')
  expect(html).toContain('Relayed from ')
  expect(html).toContain('>Vale<')
  expect(html).not.toContain('@Vale')
  expect(html).toContain('a coding worker. You decide.')
  expect(html).not.toContain('worker-42')
})

test('renders a rule row per ENGINE-minted suggestion, verbatim', () => {
  const request: PermissionRequest = {
    requestId: 'perm-2',
    request: {
      ...REQUEST.request,
      decision_reason: 'rule requires confirmation',
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'date:*' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    },
  }

  const html = renderToStaticMarkup(
    <PermissionPrompt onAllow={() => {}} onDeny={() => {}} request={request} />,
  )

  // The prototype's own words for this row, with the engine's own rule
  // serialization in the chip — never a client-side ruleImplication.
  expect(html).toContain("Yes, and don&#x27;t ask again for ")
  expect(html).toContain('Bash(date:*)')
  expect(html).toContain('Project settings (local)')
  expect(html).toContain('Why: rule requires confirmation')
  // The rule is a ROW in the list, numbered between Yes and the refusal.
  expect(html).toContain('>3<')
})

test('promotes the field each tool own renderToolUseMessage promotes', () => {
  // Every name is the `*_TOOL_NAME` constant behind a `case` in the engine's
  // own per-family switch (PermissionRequest.tsx:47-82); every field is the one
  // that tool's renderToolUseMessage shows.
  expect(selectPermissionPreview('Bash', { command: 'ls -la' })).toEqual({
    kind: 'field',
    label: 'Command',
    value: 'ls -la',
  })
  expect(
    selectPermissionPreview('PowerShell', { command: 'Get-ChildItem' }),
  ).toEqual({ kind: 'field', label: 'Command', value: 'Get-ChildItem' })
  expect(selectPermissionPreview('Read', { file_path: '/a/b.ts' })).toEqual({
    kind: 'field',
    label: 'Path',
    value: '/a/b.ts',
  })
  expect(selectPermissionPreview('Glob', { pattern: '**/*.ts' })).toEqual({
    kind: 'field',
    label: 'Pattern',
    value: '**/*.ts',
  })
  expect(selectPermissionPreview('Grep', { pattern: 'TODO' })).toEqual({
    kind: 'field',
    label: 'Pattern',
    value: 'TODO',
  })
  expect(selectPermissionPreview('WebFetch', { url: 'https://a.dev' })).toEqual({
    kind: 'field',
    label: 'URL',
    value: 'https://a.dev',
  })
  expect(selectPermissionPreview('Skill', { skill: 'commit' })).toEqual({
    kind: 'field',
    label: 'Skill',
    value: 'commit',
  })
  expect(
    selectPermissionPreview('NotebookEdit', { notebook_path: '/a/n.ipynb' }),
  ).toEqual({ kind: 'field', label: 'Notebook', value: '/a/n.ipynb' })
  expect(
    selectPermissionPreview('Write', { file_path: '/a/b.md', content: 'hi' }),
  ).toEqual({ kind: 'content', path: '/a/b.md', body: 'hi' })
})

test('a tool outside the family map has no preview, like the engine fallback', () => {
  // The engine answers FallbackPermissionRequest here; this answers "show the
  // input", never a guessed field.
  expect(selectPermissionPreview('mcp__linear__create', { title: 'x' })).toBeNull()
  expect(selectPermissionPreview('SomeFutureTool', { anything: 1 })).toBeNull()
  // AskUserQuestion and the plan tools keep their own surfaces.
  expect(selectPermissionPreview('AskUserQuestion', { questions: [] })).toBeNull()
  expect(selectPermissionPreview('ExitPlanMode', { plan: 'x' })).toBeNull()
})

test('a recognised family whose input does not match falls back, never throws', () => {
  expect(selectPermissionPreview('Bash', null)).toBeNull()
  expect(selectPermissionPreview('Bash', 'not an object')).toBeNull()
  expect(selectPermissionPreview('Bash', [1, 2, 3])).toBeNull()
  expect(selectPermissionPreview('Bash', {})).toBeNull()
  expect(selectPermissionPreview('Bash', { command: 42 })).toBeNull()
  expect(selectPermissionPreview('Bash', { command: '' })).toBeNull()
  expect(selectPermissionPreview('Write', { file_path: '/a' })).toBeNull()
  expect(selectPermissionPreview('Edit', { file_path: '/a', old_string: 'x' })).toBeNull()
  // Writing an empty file is a real request, not a broken one.
  expect(
    selectPermissionPreview('Write', { file_path: '/a', content: '' }),
  ).toEqual({ kind: 'content', path: '/a', body: '' })
})

test('an edit preview is signed change lines and carries no numbering', () => {
  const preview = selectPermissionPreview('Edit', {
    file_path: '/a/b.ts',
    old_string: 'keep\ndrop me\ntail',
    new_string: 'keep\nadd me\ntail',
  })
  expect(preview).toEqual({
    kind: 'change',
    path: '/a/b.ts',
    lines: [
      { kind: 'ctx', text: 'keep' },
      { kind: 'del', text: 'drop me' },
      { kind: 'add', text: 'add me' },
      { kind: 'ctx', text: 'tail' },
    ],
  })
})

test('buildChangeLines keeps blank lines the user wrote and drops the split artifact', () => {
  expect(buildChangeLines('a\n', 'a\n\nb\n')).toEqual([
    { kind: 'ctx', text: 'a' },
    { kind: 'add', text: '' },
    { kind: 'add', text: 'b' },
  ])
  expect(buildChangeLines('', '')).toBeNull()
})

test('formatPermissionInput survives a value JSON.stringify refuses', () => {
  expect(formatPermissionInput({ a: 1 })).toBe('{\n  "a": 1\n}')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(() => formatPermissionInput(circular)).not.toThrow()
  expect(formatPermissionInput(undefined)).toBe('undefined')
})

test('maps the prototype select-list keyboard and ignores unrelated keys', () => {
  // Cursor movement — ↑/↓ · j/k · ⌃P/⌃N (`Permissions.jsx:397-398`).
  expect(permissionKeyIntent({ key: 'ArrowDown' })).toEqual({
    kind: 'move',
    delta: 1,
  })
  expect(permissionKeyIntent({ key: 'j' })).toEqual({ kind: 'move', delta: 1 })
  expect(permissionKeyIntent({ key: 'n', ctrlKey: true })).toEqual({
    kind: 'move',
    delta: 1,
  })
  expect(permissionKeyIntent({ key: 'ArrowUp' })).toEqual({
    kind: 'move',
    delta: -1,
  })
  expect(permissionKeyIntent({ key: 'k' })).toEqual({ kind: 'move', delta: -1 })
  expect(permissionKeyIntent({ key: 'p', ctrlKey: true })).toEqual({
    kind: 'move',
    delta: -1,
  })

  // Direct pick — the row number IS the key.
  expect(permissionKeyIntent({ key: '1' })).toEqual({ kind: 'pick', index: 0 })
  expect(permissionKeyIntent({ key: '9' })).toEqual({ kind: 'pick', index: 8 })
  // There is no row 0, so the digit is not a shortcut at all.
  expect(permissionKeyIntent({ key: '0' })).toBeNull()

  expect(permissionKeyIntent({ key: 'Enter' })).toEqual({ kind: 'confirm' })

  // Escape REFUSES here, matching the prototype (`Permissions.jsx:13`). The
  // hide-for-later lane is the card's "Keep pending" footer button.
  expect(permissionKeyIntent({ key: 'Escape' })).toEqual({ kind: 'deny' })
  expect(permissionKeyIntent({ key: 'n' })).toEqual({ kind: 'deny' })
  expect(permissionKeyIntent({ key: 'N' })).toEqual({ kind: 'deny' })
  expect(permissionKeyIntent({ key: 'Backspace' })).toEqual({ kind: 'deny' })

  expect(permissionKeyIntent({ key: 'x' })).toBeNull()
  // Cmd/Alt chords belong to the shell (⌘T/⌘W/⌘1-9), never to this list.
  expect(permissionKeyIntent({ key: 'Enter', metaKey: true })).toBeNull()
  expect(permissionKeyIntent({ key: '1', metaKey: true })).toBeNull()
  expect(permissionKeyIntent({ key: 'j', altKey: true })).toBeNull()
  // Ctrl is admitted for exactly the ⌃P/⌃N pair, and nothing else.
  expect(permissionKeyIntent({ key: 'Enter', ctrlKey: true })).toBeNull()
  expect(permissionKeyIntent({ key: '1', ctrlKey: true })).toBeNull()
})

/**
 * A focus target described the way `Element.closest` answers about it: the
 * nearest ancestor-or-self matching `FOCUSED_KEY_OWNER_SELECTOR`, or null when
 * there is none. `owner: 'host'` is that element carrying the marker the card
 * puts on itself.
 *
 * LAYER HONESTY: this stands in for the DOM, so it cannot prove that the
 * selector matches the card's `<section>` — the SSR assertions below pin the
 * attributes the real `closest` would read, and only the operator's GUI run can
 * prove a key press arrives.
 */
function focusTarget(owner: 'host' | 'control' | null) {
  return {
    closest: () =>
      owner === null
        ? null
        : { hasAttribute: (name: string) => owner === 'host' && name === PERMISSION_KEY_HOST_ATTR },
  }
}

test('the four shortcuts are live only where no control owns the key', () => {
  // The defect: focus sits in the composer field after sending, so the guard
  // bailed and all four advertised keys did nothing.
  expect(permissionKeysAreLive(focusTarget('control'))).toBe(false)
  // The trap: the card's own <section> is role="alertdialog", which IS in the
  // selector, and closest() matches the element itself. Focusing the card
  // without the marker would leave the keys exactly as dead.
  expect(permissionKeysAreLive(focusTarget('host'))).toBe(true)
  // Focus on nothing, or on a plain element: the original "focus is on nothing"
  // case the shortcuts were always meant for.
  expect(permissionKeysAreLive(focusTarget(null))).toBe(true)
  expect(permissionKeysAreLive(null)).toBe(true)
  expect(permissionKeysAreLive(undefined)).toBe(true)
  // A keydown whose target is `document` or `window` has no `closest` at all.
  expect(permissionKeysAreLive({})).toBe(true)
})

test('the key listener follows the same keysLive state that paints the cursor and hint', () => {
  // SSR cannot move focus or dispatch the document listener. Pin the production
  // guard so a permissive document target cannot confirm an option while the
  // card still shows no keyboard affordance or highlighted row.
  const source = readFileSync(new URL('./PermissionPrompt.tsx', import.meta.url), 'utf8')
  const listenerStart = source.indexOf('function onKeyDown(event: KeyboardEvent)')
  const listener = source.slice(listenerStart, source.indexOf("document.addEventListener('keydown'", listenerStart))
  expect(listener).toContain('if (!permissionKeysAreLive(event.target)) return')
  expect(listener).toContain('if (!keysLive) return')
})

test('only the card the shortcuts act on hosts them, takes focus, and says so', () => {
  const target = renderToStaticMarkup(
    <PermissionPrompt
      keyboardTarget
      onAllow={() => {}}
      onDeny={() => {}}
      request={REQUEST}
    />,
  )
  // The marker `permissionKeysAreLive` looks for, and the tabIndex that lets the
  // card be focused at all.
  expect(target).toContain(`${PERMISSION_KEY_HOST_ATTR}=""`)
  expect(target).toContain('tabindex="-1"')
  expect(target).toContain('↑↓ · 1–9 · ↵ · esc')

  // Every other card in a stacked queue: the keys do not act on it, so it neither
  // claims them nor advertises them, and it shows no cursor — a highlighted row
  // on a card no key can reach is the same dead affordance in another form.
  // `selectVisiblePermission` picks exactly one.
  const other = renderToStaticMarkup(
    <PermissionPrompt onAllow={() => {}} onDeny={() => {}} request={REQUEST} />,
  )
  expect(other).not.toContain(PERMISSION_KEY_HOST_ATTR)
  expect(other).not.toContain('tabindex')
  expect(other).not.toContain('↑↓ · 1–9')
  expect(other).not.toContain('>↵<')
})

test('the cursor marks the row the keyboard would confirm, and only that row', () => {
  const request: PermissionRequest = {
    requestId: 'perm-cursor',
    request: {
      ...REQUEST.request,
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'date:*' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    },
  }
  const html = renderToStaticMarkup(
    <PermissionPrompt
      keyboardTarget
      onAllow={() => {}}
      onDeny={() => {}}
      request={request}
    />,
  )
  // The cursor starts on row 1 and the ↵ chip rides it, so it appears once.
  expect(html.split('>↵<').length - 1).toBe(1)
  // The refuse row keeps its own esc chip regardless of where the cursor is,
  // and never shows ↵ as well.
  expect(html).toContain('>esc<')
  // The cursor is exposed to assistive tech, not conveyed by colour alone.
  expect(html.split('aria-current="true"').length - 1).toBe(1)

  // LAYER HONESTY: the cursor is now card-local state moved only by this card's
  // own keydown listener, so no prop can drive it here and this SSR suite can
  // only ever observe its initial position. Cursor MOVEMENT, the clamp on a
  // shrunk list, and every key binding are unreachable without a DOM harness;
  // `permissionKeyIntent` is unit-tested above, and the rest is operator-GUI.
})
