import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PermissionPrompt,
  describeSuggestion,
  permissionActionForKey,
} from './PermissionPrompt.js'
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
