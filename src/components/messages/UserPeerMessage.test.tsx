import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToString } from '../../utils/staticRender.js'
import { UserTextMessage } from './UserTextMessage.js'
import { getPeerDisplay } from './UserPeerMessage.js'

const WRAPPED =
  '<cross-session-message from="Stope">\nran the migration, all green\n</cross-session-message>'

function renderUserText(
  text: string,
  origin?: React.ComponentProps<typeof UserTextMessage>['origin'],
): Promise<string> {
  return renderToString(
    <UserTextMessage
      addMargin={false}
      verbose={false}
      param={{ type: 'text', text }}
      origin={origin}
    />,
    80,
  )
}

describe('getPeerDisplay', () => {
  test('reads the sender and the body off a peer origin', () => {
    expect(
      getPeerDisplay(WRAPPED, {
        kind: 'peer',
        name: 'Stope',
        appSessionId: 'app-1',
      }),
    ).toEqual({
      name: 'Stope',
      body: 'ran the migration, all green',
      creationPrompt: false,
    })
  })

  test('marks the creation prompt, which arrives with no envelope', () => {
    expect(
      getPeerDisplay('port the parser to the new schema', {
        kind: 'peer',
        name: 'Stope',
        appSessionId: 'app-1',
        creationPrompt: true,
      }),
    ).toEqual({
      name: 'Stope',
      body: 'port the parser to the new schema',
      creationPrompt: true,
    })
  })

  test('falls back to the envelope when no origin was recorded', () => {
    // Peer provenance reached the engine as a typed origin only from the
    // sidecar. A transcript written by an older build carries the envelope
    // and nothing else, and it is still a peer message.
    expect(getPeerDisplay(WRAPPED, undefined)).toEqual({
      name: 'Stope',
      body: 'ran the migration, all green',
      creationPrompt: false,
    })
  })

  test('keeps a body that merely quotes the envelope out of the peer row', () => {
    // The match is anchored at both ends, so only a body that IS the envelope
    // is unwrapped. Anything else renders verbatim rather than half-parsed.
    expect(
      getPeerDisplay(
        'the shape is <cross-session-message from="a">b</cross-session-message>, roughly',
        undefined,
      ),
    ).toBeNull()
    expect(
      getPeerDisplay('<cross-session-message from="Stope">\nno closing tag', undefined),
    ).toBeNull()
  })

  test('degrades to an unnamed peer row rather than dropping the message', () => {
    expect(
      getPeerDisplay('something happened', {
        kind: 'peer',
        name: '',
        appSessionId: 'app-1',
      }),
    ).toEqual({ name: null, body: 'something happened', creationPrompt: false })
  })

  test('leaves every other origin alone', () => {
    expect(getPeerDisplay('hello', { kind: 'human' })).toBeNull()
    expect(getPeerDisplay('hello', undefined)).toBeNull()
    expect(
      getPeerDisplay('hello', { kind: 'channel', server: 'slack' }),
    ).toBeNull()
  })
})

describe('UserTextMessage peer routing', () => {
  test('attributes a delivered peer message to its sender and drops the envelope', async () => {
    // Before this branch existed the wrapper was recognised only behind
    // feature('UDS_INBOX'), which is in neither build list in scripts/build.ts,
    // so a peer message rendered through UserPromptMessage: an exported
    // transcript showed it as the operator's own prompt, XML and all.
    const out = await renderUserText(WRAPPED, {
      kind: 'peer',
      name: 'Stope',
      appSessionId: 'app-1',
    })

    expect(out).toContain('Stope')
    expect(out).toContain('ran the migration, all green')
    expect(out).not.toContain('cross-session-message')
    expect(out).not.toContain('❯')
  })

  test('attributes the creation prompt to the session that wrote it', async () => {
    const out = await renderUserText('port the parser to the new schema', {
      kind: 'peer',
      name: 'Stope',
      appSessionId: 'app-1',
      creationPrompt: true,
    })

    expect(out).toContain('Stope')
    expect(out).toContain('created this session')
    expect(out).toContain('port the parser to the new schema')
    expect(out).not.toContain('❯')
  })

  test('never prints the sender app-side address', async () => {
    const out = await renderUserText(WRAPPED, {
      kind: 'peer',
      name: 'Stope',
      appSessionId: 'app-session-1',
    })

    expect(out).not.toContain('app-session-1')
  })

  test('keeps an unnamed peer row quiet rather than emphasising a placeholder', async () => {
    const out = await renderUserText('something happened', {
      kind: 'peer',
      name: '',
      appSessionId: 'app-1',
    })

    expect(out).toContain('Peer message')
    expect(out).toContain('something happened')
  })

  test('routes a peer body that quotes another envelope tag by provenance', async () => {
    // Origin is authoritative: the body-shape branches below the peer check
    // would otherwise claim a peer message that happens to quote one of them.
    const out = await renderUserText(
      '<cross-session-message from="Stope">\nlook at the <bash-input> handling\n</cross-session-message>',
      { kind: 'peer', name: 'Stope', appSessionId: 'app-1' },
    )

    expect(out).toContain('Stope')
    expect(out).toContain('bash-input')
  })

  test('still renders a human turn as the operator prompt', async () => {
    const out = await renderUserText('count the files', { kind: 'human' })
    expect(out).toContain('count the files')
    expect(out).toContain('❯')
  })
})
