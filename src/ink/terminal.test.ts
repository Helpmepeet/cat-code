import { afterEach, expect, test } from 'bun:test'
import { progressClearSequence } from './terminal.js'
import { CLEAR_ITERM2_PROGRESS } from './termio/osc.js'

const originalTermProgram = process.env.TERM_PROGRAM
const originalTermVersion = process.env.TERM_PROGRAM_VERSION
const originalWtSession = process.env.WT_SESSION
const originalTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

afterEach(() => {
  if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM
  else process.env.TERM_PROGRAM = originalTermProgram
  if (originalTermVersion === undefined) delete process.env.TERM_PROGRAM_VERSION
  else process.env.TERM_PROGRAM_VERSION = originalTermVersion
  if (originalWtSession === undefined) delete process.env.WT_SESSION
  else process.env.WT_SESSION = originalWtSession
  if (originalTty) Object.defineProperty(process.stdout, 'isTTY', originalTty)
  else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY
})

test('does not emit progress clear as an alert on older iTerm2', () => {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  process.env.TERM_PROGRAM = 'iTerm.app'
  process.env.TERM_PROGRAM_VERSION = '3.5.14'
  delete process.env.WT_SESSION

  expect(progressClearSequence()).toBeUndefined()
})

test('clears progress on supported iTerm2', () => {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  process.env.TERM_PROGRAM = 'iTerm.app'
  process.env.TERM_PROGRAM_VERSION = '3.6.6'
  delete process.env.WT_SESSION

  expect(progressClearSequence()).toBe(CLEAR_ITERM2_PROGRESS)
})

test('does not clear progress when stdout is not a terminal', () => {
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  process.env.TERM_PROGRAM = 'iTerm.app'
  process.env.TERM_PROGRAM_VERSION = '3.6.6'
  delete process.env.WT_SESSION

  expect(progressClearSequence()).toBeUndefined()
})
