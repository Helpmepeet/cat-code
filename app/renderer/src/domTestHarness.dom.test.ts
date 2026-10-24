import { expect, test } from 'bun:test'
import { createDomTestHarness } from './domTestHarness.js'

for (const hasPrevious of [false, true]) {
  test(`image File fixture restores ${hasPrevious ? 'the prior descriptor' : 'an absent global'} on teardown`, async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
    const prior = async () => { throw new Error('prior decoder must not handle fixture files') }
    try {
      if (hasPrevious) {
        Object.defineProperty(globalThis, 'createImageBitmap', {
          configurable: true,
          enumerable: false,
          writable: false,
          value: prior,
        })
      } else {
        Reflect.deleteProperty(globalThis, 'createImageBitmap')
      }
      const expected = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
      const harness = await createDomTestHarness()
      try {
        const bitmap = await createImageBitmap(new File(['fixture'], 'shot.png', { type: 'image/png' }))
        expect([bitmap.width, bitmap.height]).toEqual([1, 1])
        bitmap.close()
        expect([bitmap.width, bitmap.height]).toEqual([0, 0])
        // Non-File blobs still expose Happy DOM's actual unsupported decoder.
        await expect(createImageBitmap(new Blob(['fixture'], { type: 'image/png' }))).rejects.toThrow()
        const canvas = document.createElement('canvas')
        canvas.width = 3
        canvas.height = 2
        const canvasBitmap = await createImageBitmap(canvas)
        expect([canvasBitmap.width, canvasBitmap.height]).toEqual([3, 2])
        canvasBitmap.close()
      } finally {
        await harness.teardown()
      }
      expect(Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')).toEqual(expected)
    } finally {
      if (original) Object.defineProperty(globalThis, 'createImageBitmap', original)
      else Reflect.deleteProperty(globalThis, 'createImageBitmap')
    }
  })
}
