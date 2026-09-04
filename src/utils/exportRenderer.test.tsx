import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Messages } from '../components/Messages.js'
import { AppStateProvider } from '../state/AppState.js'
import type { Message, MessageOrigin } from '../types/message.js'
import { renderToString } from './staticRender.js'

/**
 * Export renders the operator's real `Message[]` through the engine's own
 * renderer (`streamRenderedMessages` → `Messages` → `Message` →
 * `UserTextMessage`), so what a peer message looks like in an exported
 * transcript is decided by that chain and nowhere else. It is also the chain a
 * desktop peer session is resumed through in the terminal.
 *
 * The element below is the one `streamRenderedMessages` builds, with one
 * deviation: `hideLogo`. `LogoHeader` renders for chunk 0 only and blocks a
 * headless render here (`await render(...)` never returns), which is why this
 * file exercises the tree directly instead of calling
 * `renderMessagesToPlainText`. Everything under test, message projection and
 * per-message routing, is identical either way.
 */
function renderExportTree(messages: Message[]): Promise<string> {
  return renderToString(
    <AppStateProvider>
      <Messages
        messages={messages}
        tools={[]}
        commands={[]}
        verbose={false}
        toolJSX={null}
        toolUseConfirmQueue={[]}
        inProgressToolUseIDs={new Set()}
        isMessageSelectorVisible={false}
        conversationId="export"
        screen="prompt"
        streamingToolUses={[]}
        showAllInTranscript={true}
        isLoading={false}
        renderRange={[0, 40]}
        hideLogo={true}
      />
    </AppStateProvider>,
    80,
  )
}

function userMessage(text: string, origin?: MessageOrigin): Message {
  return {
    type: 'user',
    uuid: '11111111-1111-4111-8111-111111111111',
    timestamp: '2026-09-04T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...(origin ? { origin } : {}),
  } as Message
}

describe('exported transcripts', () => {
  test('name the session a peer message came from instead of showing it as the operator prompt', async () => {
    const out = await renderExportTree([
      userMessage(
        '<cross-session-message from="Stope">\nran the migration, all green\n</cross-session-message>',
        { kind: 'peer', name: 'Stope', appSessionId: 'app-1' },
      ),
    ])

    expect(out).toContain('Stope')
    expect(out).toContain('ran the migration, all green')
    // The envelope is model-facing. An export is the artifact that leaves the
    // machine, and it used to carry this XML as if the operator had typed it.
    expect(out).not.toContain('cross-session-message')
    expect(out).not.toContain('app-1')
  })

  test('attribute a creation prompt to the session that wrote it', async () => {
    const out = await renderExportTree([
      userMessage('port the parser to the new schema', {
        kind: 'peer',
        name: 'Stope',
        appSessionId: 'app-1',
        creationPrompt: true,
      }),
    ])

    expect(out).toContain('Stope created this session')
    expect(out).toContain('port the parser to the new schema')
  })

  test('keep the operator own turn as the operator own turn', async () => {
    const out = await renderExportTree([
      userMessage('count the files', { kind: 'human' }),
    ])

    expect(out).toContain('count the files')
    expect(out).not.toContain('Peer message')
  })
})
