import { describe, expect, test } from 'bun:test'
import { peekForStdinData, shouldPeekForStdinPrompt } from './process.js'
import { EventEmitter } from 'node:events'

describe('shouldPeekForStdinPrompt', () => {
  // The regression: every `cat-code -p "<prompt>"` spawned as a subprocess
  // inherits an idle stdin pipe, so `getInputPrompt` (src/main.tsx) burned the
  // full `peekForStdinData` timeout and printed a warning before running a
  // prompt it already had.
  test('skips the stdin peek when a positional prompt was supplied', () => {
    expect(shouldPeekForStdinPrompt('summarize this repo')).toBe(false)
  })

  // Without a positional prompt stdin is the only source of one, so
  // `echo hi | cat-code -p` must still wait for it.
  test('still peeks when no positional prompt was supplied', () => {
    expect(shouldPeekForStdinPrompt('')).toBe(true)
  })
})

describe('peekForStdinData', () => {
  test('resolves false as soon as the stream ends', async () => {
    const stream = new EventEmitter()
    const pending = peekForStdinData(stream, 60_000)
    stream.emit('end')
    expect(await pending).toBe(false)
  })

  test('resolves true when nothing ever arrives', async () => {
    expect(await peekForStdinData(new EventEmitter(), 1)).toBe(true)
  })
})
