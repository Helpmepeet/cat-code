import { describe, expect, test } from 'bun:test'

import {
  composerNodeLength,
  composerOffsetOf,
  PASTE_TOKEN_ATTR,
  readComposerText,
  splitComposerText,
  type ComposerNode,
} from './composerDom.js'
import { formatPasteRef } from './composerState.js'

// The renderer suite has no DOM, so the string↔DOM contract is exercised
// against the structural subset `ComposerNode` declares. These literals are the
// exact node shapes `renderComposerDom` produces and the browser mutates.

function text(value: string): ComposerNode {
  return { nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] }
}

function pill(token: string): ComposerNode {
  return {
    nodeType: 1,
    nodeName: 'SPAN',
    childNodes: [],
    getAttribute: name => (name === PASTE_TOKEN_ATTR ? token : null),
  }
}

function br(): ComposerNode {
  return { nodeType: 1, nodeName: 'BR', childNodes: [] }
}

function root(...childNodes: ComposerNode[]): ComposerNode {
  return { nodeType: 1, nodeName: 'DIV', childNodes, getAttribute: () => null }
}

describe('splitComposerText', () => {
  test('cuts a draft into literal runs and one pill per token', () => {
    const token = formatPasteRef(3, 12)
    expect(splitComposerText(`see ${token} now`)).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'pill', token, id: 3, numLines: 12 },
      { kind: 'text', text: ' now' },
    ])
  })

  test('a single-line token carries numLines 0', () => {
    const token = formatPasteRef(7, 0)
    expect(splitComposerText(token)).toEqual([
      { kind: 'pill', token, id: 7, numLines: 0 },
    ])
  })

  test('adjacent tokens produce adjacent pills with no empty run between', () => {
    const first = formatPasteRef(1, 4)
    const second = formatPasteRef(2, 0)
    expect(splitComposerText(`${first}${second}`)).toEqual([
      { kind: 'pill', token: first, id: 1, numLines: 4 },
      { kind: 'pill', token: second, id: 2, numLines: 0 },
    ])
  })

  test('a draft with no token is one run, and an empty draft is none', () => {
    expect(splitComposerText('plain')).toEqual([{ kind: 'text', text: 'plain' }])
    expect(splitComposerText('')).toEqual([])
  })

  test('successive calls are independent (the shared regex lastIndex cannot leak)', () => {
    const draft = `a ${formatPasteRef(1, 1)} b`
    expect(splitComposerText(draft)).toEqual(splitComposerText(draft))
  })
})

describe('readComposerText', () => {
  test('a pill serializes back to exactly its token', () => {
    const token = formatPasteRef(2, 5)
    expect(readComposerText(root(text('see '), pill(token), text(' now')))).toBe(
      `see ${token} now`,
    )
  })

  test('a <br> reads as a newline', () => {
    expect(readComposerText(root(text('a'), br(), text('b')))).toBe('a\nb')
  })

  test('the trailing filler <br> browsers keep is not a newline in the draft', () => {
    // Chrome leaves a bogus final <br> so the last line stays reachable. Only a
    // FINAL one is filler: an interior <br> is a line the user typed.
    expect(readComposerText(root(text('a'), br()))).toBe('a')
    expect(readComposerText(root(text('a'), br(), br()))).toBe('a\n')
    expect(readComposerText(root(text('a'), br(), text('b')))).toBe('a\nb')
  })

  test('nested nodes the browser may introduce are flattened', () => {
    const nested: ComposerNode = {
      nodeType: 1,
      nodeName: 'DIV',
      childNodes: [text('b'), pill(formatPasteRef(1, 0))],
      getAttribute: () => null,
    }
    expect(readComposerText(root(text('a'), nested))).toBe(
      `ab${formatPasteRef(1, 0)}`,
    )
  })

  test('an empty field reads as an empty draft', () => {
    expect(readComposerText(root())).toBe('')
  })
})

describe('composerNodeLength', () => {
  test('a pill measures its token, not its rendered label', () => {
    const token = formatPasteRef(9, 30)
    expect(composerNodeLength(pill(token))).toBe(token.length)
    expect(composerNodeLength(text('abc'))).toBe(3)
    expect(composerNodeLength(br())).toBe(1)
  })
})

describe('composerOffsetOf', () => {
  const token = formatPasteRef(1, 2)

  test('a caret inside a text node counts every preceding node in full', () => {
    const after = text(' now')
    const tree = root(text('see '), pill(token), after)
    expect(composerOffsetOf(tree, after, 2)).toBe(4 + token.length + 2)
  })

  test('an element container offset is a CHILD index, not a character index', () => {
    const tree = root(text('see '), pill(token), text(' now'))
    // Caret placed between the pill and the text after it.
    expect(composerOffsetOf(tree, tree, 2)).toBe(4 + token.length)
    expect(composerOffsetOf(tree, tree, 1)).toBe(4)
    expect(composerOffsetOf(tree, tree, 0)).toBe(0)
  })

  test('newline nodes count as one character', () => {
    const last = text('b')
    const tree = root(text('a'), br(), last)
    expect(composerOffsetOf(tree, last, 1)).toBe(3)
  })
})
