import { expect, test } from 'bun:test'
import { BrowserPaneControl, browserSubmitOptions } from './browserPaneControl.js'

test('only accepted submit and question replies hand browser control back', () => {
  const handedBack: string[] = []
  const host = { handBack: (id: string) => { handedBack.push(id) } }
  const control = new BrowserPaneControl(host)
  for (const kind of ['submit.result', 'question.result']) {
    control.receive({ kind, sessionId: 'session', accepted: false })
    expect(handedBack).toHaveLength(0)
  }
  control.receive({ kind: 'event', sessionId: 'session', accepted: true })
  control.receive({ kind: 'question.result', sessionId: 'session', requestId: 'dismiss', accepted: true })
  control.questionReply('session', 'refused')
  control.receive({ kind: 'question.result', sessionId: 'session', requestId: 'refused', accepted: false })
  expect(handedBack).toHaveLength(0)
  control.receive({ kind: 'submit.result', sessionId: 'session', accepted: true })
  control.questionReply('session', 'reply')
  control.receive({ kind: 'question.result', sessionId: 'session', requestId: 'reply', accepted: true })
  expect(handedBack).toEqual(['session', 'session'])
})

test('main gives every renderer submit an id without replacing an existing one', () => {
  expect(browserSubmitOptions(undefined, () => 'minted')).toEqual({ submitId: 'minted' })
  expect(browserSubmitOptions({ submitId: 'renderer', isMeta: true }, () => { throw new Error('Do not mint') })).toEqual({ submitId: 'renderer', isMeta: true })
})
