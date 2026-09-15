import { describe, expect, test } from 'bun:test'
import { peekForStdinData, stdinPeekBudgetMs } from './process.js'
import { EventEmitter } from 'node:events'

describe('stdinPeekBudgetMs', () => {
  // The regression this fixes: every `cat-code -p "<prompt>"` spawned as a
  // subprocess inherits an idle stdin pipe, so `getInputPrompt` (src/main.tsx)
  // burned the full timeout and printed a warning before running a prompt it
  // already had.
  test('spends only a short budget when a positional prompt was supplied', () => {
    expect(stdinPeekBudgetMs('summarize this repo')).toBe(150)
  })

  // Without a positional prompt stdin is the ONLY source of one, so a slow
  // producer must be waited out in full.
  test('spends the full budget when stdin is the only input', () => {
    expect(stdinPeekBudgetMs('')).toBe(3000)
  })

  // The load-bearing one. Returning 0 here would make `getInputPrompt` skip the
  // read entirely, and `cat notes.txt | cat-code -p "summarize"` would silently
  // drop the file — the two are joined, stdin is supplementary, not redundant.
  test('never skips the read outright, even with a prompt in hand', () => {
    expect(stdinPeekBudgetMs('summarize this repo')).toBeGreaterThan(0)
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
