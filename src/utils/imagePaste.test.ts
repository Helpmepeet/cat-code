import { describe, expect, test } from 'bun:test'
import { shouldLogNativeClipboardFallbackError } from './imagePaste.js'

describe('imagePaste native clipboard fallback', () => {
  test('does not report missing optional native clipboard module as an error', () => {
    expect(
      shouldLogNativeClipboardFallbackError(
        new Error("Cannot find package 'image-processor-napi' from '/$bunfs/root/cli.js'"),
      ),
    ).toBe(false)

    expect(
      shouldLogNativeClipboardFallbackError(
        new Error('native clipboard reader unavailable'),
      ),
    ).toBe(false)
  })

  test('reports unexpected native clipboard failures before falling back', () => {
    expect(
      shouldLogNativeClipboardFallbackError(new Error('native clipboard crashed')),
    ).toBe(true)
  })
})
