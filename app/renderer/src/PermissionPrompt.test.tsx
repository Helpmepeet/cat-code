import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PermissionPrompt,
} from './PermissionPrompt.js'
import {
  buildChangeLines,
  describeSuggestion,
  formatPermissionInput,
  permissionActionForKey,
  selectPermissionPreview,
} from './permissionPromptModel.js'
import type { PermissionRequest } from './permissionState.js'

const REQUEST: PermissionRequest = {
  requestId: 'perm-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'date' },
    tool_use_id: 'toolu-1',
  },
}

test('renders the requested tool, the command itself, controls, and inline key hints', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={REQUEST}
    />,
  )

  expect(html).toContain('Permission required')
  expect(html).toContain('Bash')
  // The command is the body now, under its own label — not a JSON payload.
  expect(html).toContain('Command')
  expect(html).toContain('>date<')
  expect(html).not.toContain('&quot;command&quot;: &quot;date&quot;')
  // …and the exact input is still one click away, collapsed.
  expect(html).toContain('Show input')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('Allow')
  expect(html).toContain('Deny')
  expect(html).toContain('Enter allow')
  expect(html).toContain('N / ⌫ deny')
  expect(html).toContain('Esc snooze')
  // No engine-minted suggestions on this request → no always-allow option.
  expect(html).not.toContain('Always allow')
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
  // A bare allow here would run the tool with no answers, so neither the Allow
  // button nor an always-allow suggestion may be clickable.
  expect(html).not.toContain('>Allow<')
  expect(html).not.toContain('Always allow')
  // The generic shortcuts skip this request, so the hint would be dead too.
  expect(html).not.toContain('Enter allow')
  expect(html).toContain('Deny')
  expect(html).toContain('it can only be denied')
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
    />,
  )
  expect(html).toContain('>worker<')
  expect(html).toContain('Relayed from worker')
  expect(html).toContain('worker-42')
})

test('renders an always-allow option per ENGINE-minted suggestion, verbatim', () => {
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

  expect(html).toContain('Always allow')
  // The engine's own rule serialization — never a client-side ruleImplication.
  expect(html).toContain('allow Bash(date:*) · Project settings (local)')
  expect(html).toContain('Why: rule requires confirmation')
})

test('describeSuggestion renders the engine rule idiom for every update type', () => {
  expect(
    describeSuggestion({
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }],
      behavior: 'allow',
      destination: 'localSettings',
    }),
  ).toBe('allow Bash(npm test:*), Read · Project settings (local)')
  expect(
    describeSuggestion({
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'session',
    }),
  ).toBe('mode → Accept edits · This session')
  expect(
    describeSuggestion({
      type: 'addDirectories',
      directories: ['/tmp/x'],
      destination: 'session',
    }),
  ).toBe('allow directory /tmp/x · This session')
})

test('describeSuggestion never puts a settings-file identifier in the button text', () => {
  // The button is user text: it used to end in the raw destination key
  // (`localSettings`), and its unreachable arm printed a JSON blob.
  const everyDestination = (
    ['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'] as const
  ).map(destination =>
    describeSuggestion({
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'date:*' }],
      behavior: 'allow',
      destination,
    }),
  )
  for (const text of everyDestination) {
    expect(text).not.toContain('Settings')
    expect(text).not.toContain('cliArg')
    expect(text).not.toContain('{')
  }
  expect(everyDestination).toEqual([
    'allow Bash(date:*) · User settings',
    'allow Bash(date:*) · Project settings',
    'allow Bash(date:*) · Project settings (local)',
    'allow Bash(date:*) · This session',
    'allow Bash(date:*) · This session',
  ])
  // Every engine mode reads as the name this app shows in its own mode picker.
  const modes = (
    ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const
  ).map(mode => describeSuggestion({ type: 'setMode', mode, destination: 'session' }))
  expect(modes).toEqual([
    'mode → Ask permissions · This session',
    'mode → Accept edits · This session',
    'mode → Plan mode · This session',
    'mode → Auto mode · This session',
    'mode → Bypass permissions · This session',
  ])
})

test('describeSuggestion covers every PermissionUpdate variant mirrored by the schema', () => {
  // PermissionUpdate: src/types/permissions.ts:98-131; schema mirror:
  // src/utils/permissions/PermissionUpdateSchema.ts:42-78.
  // addRules — src/types/permissions.ts:100
  expect(
    describeSuggestion({
      type: 'addRules',
      destination: 'localSettings',
      rules: [{ toolName: 'Bash', ruleContent: 'date:*' }],
      behavior: 'allow',
    }),
  ).toBe('allow Bash(date:*) · Project settings (local)')

  // replaceRules — src/types/permissions.ts:106
  expect(
    describeSuggestion({
      type: 'replaceRules',
      destination: 'projectSettings',
      rules: [{ toolName: 'Read' }],
      behavior: 'ask',
    }),
  ).toBe('ask Read · Project settings')

  // removeRules — src/types/permissions.ts:112
  expect(
    describeSuggestion({
      type: 'removeRules',
      destination: 'userSettings',
      rules: [{ toolName: 'Write', ruleContent: '/tmp/**' }],
      behavior: 'deny',
    }),
  ).toBe('deny Write(/tmp/**) · User settings')

  // setMode — src/types/permissions.ts:118
  expect(
    describeSuggestion({
      type: 'setMode',
      destination: 'session',
      mode: 'acceptEdits',
    }),
  ).toBe('mode → Accept edits · This session')

  // addDirectories — src/types/permissions.ts:123
  expect(
    describeSuggestion({
      type: 'addDirectories',
      destination: 'session',
      directories: ['/tmp/x'],
    }),
  ).toBe('allow directory /tmp/x · This session')

  // removeDirectories — src/types/permissions.ts:128
  expect(
    describeSuggestion({
      type: 'removeDirectories',
      destination: 'cliArg',
      directories: ['/tmp/y', '/tmp/z'],
    }),
  ).toBe('remove directory /tmp/y, /tmp/z · This session')
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

test('maps the permission keyboard contract and ignores unrelated keys', () => {
  expect(permissionActionForKey({ key: 'Enter' })).toBe('allow')
  expect(permissionActionForKey({ key: 'n' })).toBe('deny')
  expect(permissionActionForKey({ key: 'N' })).toBe('deny')
  expect(permissionActionForKey({ key: 'Backspace' })).toBe('deny')
  expect(permissionActionForKey({ key: 'Escape' })).toBe('dismiss')
  expect(permissionActionForKey({ key: 'x' })).toBeNull()
  expect(permissionActionForKey({ key: 'Enter', metaKey: true })).toBeNull()
  expect(permissionActionForKey({ key: 'n', ctrlKey: true })).toBeNull()
})
