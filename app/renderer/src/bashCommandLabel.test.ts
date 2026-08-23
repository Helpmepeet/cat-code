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
  test('keeps the command on the header and the description on hover', () => {
    expect(
      selectBashCardText('rg -n auth src/', 'Check auth handling'),
    ).toEqual({
      target: 'rg -n auth src/',
      hover: 'Check auth handling',
    })
  })

  test('falls back to the comment when there is no description', () => {
    expect(
      selectBashCardText('# Inspect auth\nrg -n auth src/', null),
    ).toEqual({
      target: '# Inspect auth\nrg -n auth src/',
      hover: 'Inspect auth',
    })
  })

  test('prefers the description over the comment', () => {
    expect(
      selectBashCardText('# Inspect auth\nrg -n auth', 'Check auth handling')
        .hover,
    ).toBe('Check auth handling')
  })

  test('reveals nothing when the model sent neither', () => {
    expect(selectBashCardText('git status', null)).toEqual({
      target: 'git status',
      hover: null,
    })
  })

  test('reveals nothing when the label would repeat the command', () => {
    expect(selectBashCardText('git status', 'git status').hover).toBeNull()
  })

  test('survives a row with no command', () => {
    expect(selectBashCardText(null, 'Check auth')).toEqual({
      target: 'Check auth',
      hover: null,
    })
  })

  test('survives a row with neither field', () => {
    expect(selectBashCardText(null, null)).toEqual({
      target: null,
      hover: null,
    })
  })
})
