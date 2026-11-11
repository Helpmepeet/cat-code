import { expect, test } from 'bun:test'
import { placeSubagentTooltip } from './subagentDockLayout.js'

const pane = { left: 0, top: 0, right: 480, bottom: 520, width: 480, height: 520 } as DOMRect

test('chip tooltips use the specimen gap and right-edge offset without rounding their width', () => {
  const anchor = { left: 280, top: 20, right: 303, bottom: 41, width: 23, height: 21 } as DOMRect
  expect(placeSubagentTooltip(pane, anchor, 204.34375, 44, false)).toEqual({
    left: 102.65625, top: 50, width: 204.34375, height: 44, attached: false,
  })
})

test('chip tooltips still stay inside a narrow pane', () => {
  const anchor = { left: 5, top: 490, right: 28, bottom: 511, width: 23, height: 21 } as DOMRect
  const box = placeSubagentTooltip(pane, anchor, 260, 44, false)
  expect(box.left).toBe(8)
  expect(box.top + box.height).toBe(512)
})
