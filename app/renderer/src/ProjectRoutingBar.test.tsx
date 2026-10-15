import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ProjectRoutingBar } from './ProjectRoutingBar.js'

const route = {
  appSessionId: '93ad8a93-bc68-4954-8c3e-92115798fcce',
  submitId: '5b48eb57-5dc5-45ed-af3a-248863d962f2',
  text: 'Fix the route',
  message: null,
} as const

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


test('failed context recovery describes the held message and offers resend or cancellation', () => {
  const html = renderToStaticMarkup(<ProjectRoutingBar route={{ ...route, phase: 'failed', message: 'Project folder changed before sending.' }} onChoice={() => {}} />)
  expect(html).toContain('Could not send the message in this project folder.')
  expect(html).toContain('Project folder changed before sending.')
  expect(html).toContain('Try again</button>')
  expect(html).toContain('Cancel</button>')
})
