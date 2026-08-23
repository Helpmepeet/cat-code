import { describe, expect, test } from 'bun:test'
import {
  extractBashCommentLabel,
  selectBashCardText,
} from './bashCommandLabel.js'

describe('extractBashCommentLabel', () => {
  test('reads a first-line comment', () => {
    expect(extractBashCommentLabel('# Inspect auth\nrg -n "auth" src/')).toBe(
      'Inspect auth',
    )
  })

  test('trims before testing the first line', () => {
    expect(extractBashCommentLabel('   # Inspect auth\nrg -n "auth"')).toBe(
      'Inspect auth',
    )
  })

  test('strips repeated hashes and the space after them', () => {
    expect(extractBashCommentLabel('###   Inspect auth\nrg -n "auth"')).toBe(
      'Inspect auth',
    )
  })

  test('rejects a shebang', () => {
    expect(
      extractBashCommentLabel('#!/usr/bin/env bash\nrg -n "auth"'),
    ).toBeUndefined()
  })

  test('rejects a command with no comment', () => {
    expect(extractBashCommentLabel('git status')).toBeUndefined()
  })

  test('rejects a comment marker with nothing after it', () => {
    expect(extractBashCommentLabel('#\ngit status')).toBeUndefined()
  })

  test('accepts a single-line command that is only a comment', () => {
    expect(extractBashCommentLabel('# Inspect auth')).toBe('Inspect auth')
  })

  test('ignores a comment that is not on the first line', () => {
    expect(
      extractBashCommentLabel('git status\n# Inspect auth'),
    ).toBeUndefined()
  })
})

describe('selectBashCardText', () => {
  test('description wins over both the comment and the command', () => {
    expect(
      selectBashCardText('# Inspect auth\nrg -n "auth"', 'Check auth handling'),
    ).toEqual({
      label: 'Check auth handling',
      commandLead: '# Inspect auth\nrg -n "auth"',
    })
  })

  test('falls back to the comment when there is no description', () => {
    expect(selectBashCardText('# Inspect auth\nrg -n "auth"', null)).toEqual({
      label: 'Inspect auth',
      commandLead: '# Inspect auth\nrg -n "auth"',
    })
  })

  test('falls back to the raw command when there is neither', () => {
    expect(selectBashCardText('git status', null)).toEqual({
      label: 'git status',
      commandLead: null,
    })
  })

  test('keeps the comment in the command it hands the body', () => {
    const command = '# Inspect auth\nrg -n "auth" src/'
    expect(selectBashCardText(command, 'Check auth').commandLead).toBe(command)
  })

  test('never repeats the command when it is already the label', () => {
    expect(selectBashCardText('git status', 'git status').commandLead).toBeNull()
  })

  test('survives a row with no command', () => {
    expect(selectBashCardText(null, 'Check auth')).toEqual({
      label: 'Check auth',
      commandLead: null,
    })
  })

  test('survives a row with neither field', () => {
    expect(selectBashCardText(null, null)).toEqual({
      label: null,
      commandLead: null,
    })
  })
})
