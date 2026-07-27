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
  expect(html).toContain('allow Bash(date:*) · localSettings')
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
  ).toBe('allow Bash(npm test:*), Read · localSettings')
  expect(
    describeSuggestion({
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'session',
    }),
  ).toBe('mode → acceptEdits · session')
  expect(
    describeSuggestion({
      type: 'addDirectories',
      directories: ['/tmp/x'],
      destination: 'session',
    }),
  ).toBe('allow directory /tmp/x · session')
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
  ).toBe('allow Bash(date:*) · localSettings')

  // replaceRules — src/types/permissions.ts:106
  expect(
    describeSuggestion({
      type: 'replaceRules',
      destination: 'projectSettings',
      rules: [{ toolName: 'Read' }],
      behavior: 'ask',
    }),
  ).toBe('ask Read · projectSettings')

  // removeRules — src/types/permissions.ts:112
  expect(
    describeSuggestion({
      type: 'removeRules',
      destination: 'userSettings',
      rules: [{ toolName: 'Write', ruleContent: '/tmp/**' }],
      behavior: 'deny',
    }),
  ).toBe('deny Write(/tmp/**) · userSettings')

  // setMode — src/types/permissions.ts:118
  expect(
    describeSuggestion({
      type: 'setMode',
      destination: 'session',
      mode: 'acceptEdits',
    }),
  ).toBe('mode → acceptEdits · session')

  // addDirectories — src/types/permissions.ts:123
  expect(
    describeSuggestion({
      type: 'addDirectories',
      destination: 'session',
      directories: ['/tmp/x'],
    }),
  ).toBe('allow directory /tmp/x · session')

  // removeDirectories — src/types/permissions.ts:128
  expect(
    describeSuggestion({
      type: 'removeDirectories',
      destination: 'cliArg',
      directories: ['/tmp/y', '/tmp/z'],
    }),
  ).toBe('remove directory /tmp/y, /tmp/z · cliArg')
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
