import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PermissionPrompt,
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
  expect(html).toContain('Esc dismiss')
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
