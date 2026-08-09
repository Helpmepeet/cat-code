/* Slash-command breadcrumb identity (bug, 2026-08-08).
 *
 * A desktop client mints ONE uuid per submission and uses it for both the live
 * prompt echo it broadcasts and the engine call
 * (app/sidecar/sidecarServer.ts:1257,1292). The persisted `/command` breadcrumb
 * must carry that same uuid, because the renderer's replay dedupe is uuid-keyed
 * (app/renderer/src/transcriptProjector.ts:1044). When the breadcrumb minted a
 * fresh uuid instead, a sidecar restart replayed it as a SECOND `/compact` row.
 *
 * The prompt-command branch already preserved it; `local` and `local-jsx` did
 * not. These pin the carry at the producer, which is the only layer that can
 * fix it — no consumer can recover a link that was never persisted.
 */

import { describe, expect, test } from 'bun:test'
import type { Command } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { processSlashCommand } from './processSlashCommand.js'

const SUBMIT_UUID = '9bf72620-2fb3-41f4-b1d7-1a888b8a024e'

function localCommand(name: string, value: string): Command {
  return {
    type: 'local',
    name,
    description: `test ${name}`,
    supportsNonInteractive: true,
    load: async () => ({ call: async () => ({ type: 'text', value }) }),
  } as Command
}

/** The narrow slice of ProcessUserInputContext this path actually reads. */
function contextWith(commands: Command[]): Parameters<
  typeof processSlashCommand
>[4] {
  return {
    options: { commands, isNonInteractiveSession: false },
    getAppState: () => ({}),
  } as unknown as Parameters<typeof processSlashCommand>[4]
}

/** The breadcrumb is the user-authored row: the `/command` echo, not stdout. */
function breadcrumb(messages: Message[]): Message | undefined {
  return messages.find(
    message =>
      message.type === 'user' &&
      typeof message.message.content === 'string' &&
      message.message.content.includes('<command-name>'),
  )
}

const noJSX = () => {}

describe('slash-command breadcrumb uuid', () => {
  test('a local command persists its breadcrumb under the submitted uuid', async () => {
    const { messages } = await processSlashCommand(
      '/probe',
      [],
      [],
      [],
      contextWith([localCommand('probe', 'ok')]),
      noJSX as never,
      SUBMIT_UUID,
    )

    const row = breadcrumb(messages)
    expect(row).toBeDefined()
    // The assertion that fails before the fix: createUserMessage minted its own.
    expect(row?.uuid).toBe(SUBMIT_UUID)
  })

  test('an omitted uuid still yields a breadcrumb with some identity', async () => {
    const { messages } = await processSlashCommand(
      '/probe',
      [],
      [],
      [],
      contextWith([localCommand('probe', 'ok')]),
      noJSX as never,
    )

    // The carry must not make identity conditional on the caller supplying one:
    // the terminal REPL passes nothing here and still needs a keyed row.
    const row = breadcrumb(messages)
    expect(row).toBeDefined()
    expect(typeof row?.uuid).toBe('string')
    expect(row?.uuid).not.toBe(SUBMIT_UUID)
  })

  test('the breadcrumb uuid is not shared with the stdout row it precedes', async () => {
    const { messages } = await processSlashCommand(
      '/probe',
      [],
      [],
      [],
      contextWith([localCommand('probe', 'ok')]),
      noJSX as never,
      SUBMIT_UUID,
    )

    // Carrying one uuid onto TWO persisted rows would trade a duplicate row for
    // a collision, and the replay dedupe would then swallow the output row.
    const others = messages.filter(message => message.uuid === SUBMIT_UUID)
    expect(others.length).toBe(1)
  })
})
