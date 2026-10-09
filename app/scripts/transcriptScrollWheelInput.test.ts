import { expect, test } from 'bun:test'
import { readSyntheticWheelRequest } from './transcriptScrollWheelInput.js'

test('isolated wheel input admits only finite in-window two-pixel wheel steps', () => {
  for (const deltaY of [-2, 2] as const) {
    const input = { id: 1, x: 100, y: 400, deltaY }
    expect(readSyntheticWheelRequest(input)).toEqual(input)
  }
})

for (const input of [
  null, [], {}, { id: 1, x: 100, y: 400, deltaY: 2, type: 'keyDown' },
  { id: 0, x: 100, y: 400, deltaY: 2 }, { id: 1_001, x: 100, y: 400, deltaY: 2 },
  { id: 1.5, x: 100, y: 400, deltaY: 2 }, { id: 1, x: -1, y: 400, deltaY: 2 },
  { id: 1, x: 1_100, y: 400, deltaY: 2 }, { id: 1, x: NaN, y: 400, deltaY: 2 },
  { id: 1, x: 100, y: Infinity, deltaY: 2 }, { id: 1, x: 100, y: 950, deltaY: 2 },
  { id: 1, x: 100, y: 400, deltaY: 20 }, { id: 1, x: 100, y: 400, deltaY: '2' },
]) {
  test(`reject invalid wheel input ${JSON.stringify(input)}`, () => {
    expect(readSyntheticWheelRequest(input)).toBeNull()
  })
}
