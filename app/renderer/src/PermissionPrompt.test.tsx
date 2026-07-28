import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PermissionPrompt,
} from './PermissionPrompt.js'
import {
  describeSuggestion,
  permissionActionForKey,
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

test('renders the requested tool, exact input, controls, and inline key hints', () => {
  const html = renderToStaticMarkup(
    <PermissionPrompt
      onAllow={() => {}}
      onDeny={() => {}}
      request={REQUEST}
    />,
  )

  expect(html).toContain('Permission required')
  expect(html).toContain('Bash')
  expect(html).toContain('&quot;command&quot;: &quot;date&quot;')
  expect(html).toContain('Allow')
  expect(html).toContain('Deny')
  expect(html).toContain('Enter allow')
  expect(html).toContain('N / ⌫ deny')
  expect(html).toContain('Esc snooze')
  // No engine-minted suggestions on this request → no always-allow option.
  expect(html).not.toContain('Always allow')
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
