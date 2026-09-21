import { describe, expect, test } from 'bun:test'

import { buildPngIcns } from './pngIcns.js'

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x74, 0x65, 0x73, 0x74,
])

describe('buildPngIcns', () => {
  test('writes a valid ICNS container with sized PNG chunks', () => {
    const result = buildPngIcns([
      { type: 'icp4', png },
      { type: 'ic10', png },
    ])

    expect(result.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(result.readUInt32BE(4)).toBe(result.length)
    expect(result.subarray(8, 12).toString('ascii')).toBe('icp4')
    expect(result.readUInt32BE(12)).toBe(8 + png.length)

    const secondChunk = 8 + 8 + png.length
    expect(result.subarray(secondChunk, secondChunk + 4).toString('ascii')).toBe('ic10')
    expect(result.readUInt32BE(secondChunk + 4)).toBe(8 + png.length)
  })

  test('rejects malformed chunk types and non-PNG payloads', () => {
    expect(() => buildPngIcns([{ type: 'wide!', png }])).toThrow('exactly four')
    expect(() => buildPngIcns([{ type: 'ic10', png: Buffer.from('not png') }])).toThrow(
      'is not a PNG',
    )
  })
})
