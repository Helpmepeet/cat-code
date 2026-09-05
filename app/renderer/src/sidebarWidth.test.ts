import { expect, test } from 'bun:test'
import {
  clampSidebarWidth,
  readSidebarWidthFromStorage,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  writeSidebarWidthToStorage,
} from './sidebarWidth.js'
import {
  memoryStorage,
  throwingStorage,
} from './viewPreferenceStorageFixture.js'

const WIDE = 2560

test('a width inside the range is returned unchanged', () => {
  expect(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, WIDE)).toBe(
    SIDEBAR_DEFAULT_WIDTH,
  )
})

test('the fixed floor and ceiling hold on a wide window', () => {
  expect(clampSidebarWidth(0, WIDE)).toBe(SIDEBAR_MIN_WIDTH)
  expect(clampSidebarWidth(-500, WIDE)).toBe(SIDEBAR_MIN_WIDTH)
  expect(clampSidebarWidth(9000, WIDE)).toBe(SIDEBAR_MAX_WIDTH)
})

test('a narrow window lowers the ceiling to a third of it', () => {
  // 1200/3 = 400, below the fixed 420.
  expect(clampSidebarWidth(9000, 1200)).toBe(400)
  // 1500/3 = 500, so the fixed ceiling is the binding one again.
  expect(clampSidebarWidth(9000, 1500)).toBe(SIDEBAR_MAX_WIDTH)
})

test('the window ceiling never falls below the floor', () => {
  // The window's own minWidth is 852 (main.ts), but even far below it the
  // ceiling must not invert the range.
  expect(clampSidebarWidth(9000, 852)).toBe(284)
  expect(clampSidebarWidth(9000, 300)).toBe(SIDEBAR_MIN_WIDTH)
  expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH, 300)).toBe(SIDEBAR_MIN_WIDTH)
})

test('no window to measure means fixed bounds only', () => {
  expect(clampSidebarWidth(9000, 0)).toBe(SIDEBAR_MAX_WIDTH)
  expect(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, 0)).toBe(
    SIDEBAR_DEFAULT_WIDTH,
  )
})

test('a non-finite width falls back to the default', () => {
  expect(clampSidebarWidth(Number.NaN, WIDE)).toBe(SIDEBAR_DEFAULT_WIDTH)
})

test('a written width reads back', () => {
  const storage = memoryStorage()
  writeSidebarWidthToStorage(storage, 320)
  expect(readSidebarWidthFromStorage(storage)).toBe(320)
})

test('a fractional width is stored rounded', () => {
  const storage = memoryStorage()
  writeSidebarWidthToStorage(storage, 287.6)
  expect(readSidebarWidthFromStorage(storage)).toBe(288)
})

test('an out-of-range stored width is clamped on read', () => {
  expect(
    readSidebarWidthFromStorage(
      memoryStorage({
        [SIDEBAR_WIDTH_STORAGE_KEY]: JSON.stringify({
          version: 1,
          width: 9000,
        }),
      }),
    ),
  ).toBe(SIDEBAR_MAX_WIDTH)
})

test('nothing stored, a wrong version, or a junk shape reads as null', () => {
  expect(readSidebarWidthFromStorage(memoryStorage())).toBe(null)
  expect(
    readSidebarWidthFromStorage(
      memoryStorage({
        [SIDEBAR_WIDTH_STORAGE_KEY]: JSON.stringify({ version: 2, width: 320 }),
      }),
    ),
  ).toBe(null)
  expect(
    readSidebarWidthFromStorage(
      memoryStorage({
        [SIDEBAR_WIDTH_STORAGE_KEY]: JSON.stringify({
          version: 1,
          width: 'wide',
        }),
      }),
    ),
  ).toBe(null)
  expect(
    readSidebarWidthFromStorage(
      memoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: 'not json' }),
    ),
  ).toBe(null)
})

test('a null storage disables persistence without throwing', () => {
  expect(readSidebarWidthFromStorage(null)).toBe(null)
  expect(() => writeSidebarWidthToStorage(null, 320)).not.toThrow()
})

test('a throwing storage is survived on both sides', () => {
  const hostile = throwingStorage('blocked')
  expect(readSidebarWidthFromStorage(hostile)).toBe(null)
  expect(() => writeSidebarWidthToStorage(hostile, 320)).not.toThrow()
})
