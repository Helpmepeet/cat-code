import { expect, test } from 'bun:test'
import type { TranscriptLayoutItem } from './toolRunLayout.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { groupUserImages } from './userImageLayout.js'

const image = (id: string, frameId: string, hidden = false): TranscriptLayoutItem => ({
  kind: 'single',
  row: {
    sessionId: 's',
    messageId: frameId,
    frameId,
    blockIndex: 0,
    parentToolUseId: null,
    children: [] as NestedTranscriptRow[],
    id,
    kind: 'user-image',
    source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' },
    isReplay: false,
    ...(hidden ? { isHidden: true as const } : {}),
  },
})

test('a lone image passes through, and so does the input array', () => {
  const items = [image('a', 'f1'), image('b', 'f2')]
  expect(groupUserImages(items)).toBe(items)
})

test('only visible images from the same frame join one item', () => {
  const grouped = groupUserImages([image('a', 'f1'), image('b', 'f1'), image('c', 'f1', true), image('d', 'f2'), image('e', 'f2')])
  expect(grouped.map(item => item.kind === 'user-images'
    ? item.members.map(member => member.id)
    : item.kind === 'single' ? item.row.id : item.kind)).toEqual([['a', 'b'], 'c', ['d', 'e']])
})
