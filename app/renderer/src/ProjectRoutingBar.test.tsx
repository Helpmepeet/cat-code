import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ProjectRoutingBar } from './ProjectRoutingBar.js'

const route = {
  appSessionId: '93ad8a93-bc68-4954-8c3e-92115798fcce',
  submitId: '5b48eb57-5dc5-45ed-af3a-248863d962f2',
  text: 'Fix the route',
  projectName: 'cat-code',
  message: null,
} as const

test.each(['checking', 'recovery'] as const)('ordinary submission has no project status bar during %s', phase => {
  const html = renderToStaticMarkup(
    <ProjectRoutingBar route={{ ...route, phase, projectName: null }} onChoice={() => {}} />,
  )
  expect(html).toBe('')
})

test('asks before moving an inferred project target', () => {
  const html = renderToStaticMarkup(
    <ProjectRoutingBar route={{ ...route, phase: 'ask' }} onChoice={() => {}} />,
  )

  expect(html).toContain('Work in <b>cat-code</b>?')
  expect(html).toContain('Stay in chat')
  expect(html).toContain('Move')
})

test('does not offer a second send while acceptance is pending', () => {
  const html = renderToStaticMarkup(
    <ProjectRoutingBar route={{ ...route, phase: 'recovery' }} onChoice={() => {}} />,
  )

  expect(html).toContain('Sending message…')
  expect(html).not.toContain('Send</button>')
  expect(html).not.toContain('Cancel</button>')
})


test('recovery distinguishes unsent input from an unknown outcome', () => {
  const unsent = renderToStaticMarkup(<ProjectRoutingBar route={{ ...route, phase: 'unsent' }} onChoice={() => {}} />)
  const unknown = renderToStaticMarkup(<ProjectRoutingBar route={{ ...route, phase: 'uncertain' }} onChoice={() => {}} />)
  expect(unsent).toContain('This message has not been sent.')
  expect(unsent).toContain('Send</button>')
  expect(unknown).toContain('may already have been sent')
  expect(unknown).toContain('Send again</button>')
  expect(unknown).toContain('Dismiss</button>')
})
