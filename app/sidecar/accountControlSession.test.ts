import { expect, test } from 'bun:test'
import { serveAccountControl } from './accountControlSession.js'
import { MAX_ACCOUNT_CONTROL_RECORD_BYTES, type AccountControlVerb } from '../shared/accountControlWorker.js'
import { MAX_TEXT_FIELD_CHARS } from '../shared/limits.js'

async function* input(line: string) { yield Buffer.from(line) }

test('accepts account commands split across input chunks and correlates each result', async () => {
  const verbs: AccountControlVerb[] = [
    { type: 'account.login', requestId: 'login', provider: 'anthropic' },
    { type: 'account.oauthPasteCode', requestId: 'code', code: 'synthetic-code' },
    { type: 'account.oauthAlias', requestId: 'alias', alias: '' },
    { type: 'account.switch', requestId: 'switch', accountId: 'synthetic-account', provider: 'openai' },
    { type: 'account.rename', requestId: 'rename', accountId: 'synthetic-account', alias: 'work' },
    { type: 'account.touchAll', requestId: 'touch' },
    { type: 'account.oauthCancel', requestId: 'cancel' },
  ]
  const payload = verbs.map(verb => JSON.stringify(verb) + '\n').join('')
  async function* chunks() {
    yield Buffer.from(payload.slice(0, 13))
    yield Buffer.from(payload.slice(13))
  }
  const executed: string[] = []
  const results: string[] = []
  await serveAccountControl(chunks(), {
    setOAuthProgressSink: () => {},
    runVerb: async verb => {
      executed.push(verb.type)
      return { verb: verb.type, result: { ok: true, message: 'Done' }, poolChanged: false }
    },
  }, async event => {
    if (event.type === 'result') results.push(`${event.requestId}:${event.verb}`)
  })
  expect(results).toEqual([
    'login:account.login', 'code:account.oauthPasteCode', 'alias:account.oauthAlias',
    'switch:account.switch', 'rename:account.rename', 'touch:account.touchAll', 'cancel:account.oauthCancel',
  ])
  expect(executed).toEqual([...verbs.map(verb => verb.type), 'account.oauthCancel'])
})

test.each([
  { type: 'account.login', requestId: 'r', cwd: '/arbitrary' },
  { type: 'account.login', requestId: 'r', provider: 'unknown' },
  { type: 'account.login', requestId: '' },
  { type: 'account.oauthPasteCode', requestId: 'r', code: 'x'.repeat(MAX_TEXT_FIELD_CHARS + 1) },
  { type: 'account.delete', requestId: 'r', accountId: 'a', confirm: true },
])('rejects malformed account control input before the engine action', async verb => {
  const executed: string[] = []
  await expect(serveAccountControl(input(JSON.stringify(verb) + '\n'), {
    setOAuthProgressSink: () => {},
    runVerb: async request => { executed.push(request.type); return { verb: request.type, result: { ok: true, message: 'Done' }, poolChanged: false } },
  }, async () => {})).rejects.toThrow('invalid account control request')
  expect(executed.filter(type => type !== 'account.oauthCancel')).toEqual([])
})

test('caps an unterminated account control request before parsing', async () => {
  await expect(serveAccountControl(input('x'.repeat(MAX_ACCOUNT_CONTROL_RECORD_BYTES + 1)), {
    setOAuthProgressSink: () => {},
    runVerb: async verb => ({ verb: verb.type, result: { ok: true, message: 'Done' }, poolChanged: false }),
  }, async () => {})).rejects.toThrow('request too large')
})
