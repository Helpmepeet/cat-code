import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Modern ICNS files may store PNG payloads directly in size-specific chunks.
 * This is the fallback for macOS versions whose `iconutil -c icns` rejects
 * iconsets that its own `-c iconset` command produced.
 */
export function buildPngIcns(
  layers: ReadonlyArray<{ type: string; png: Uint8Array }>,
): Buffer {
  const chunks = layers.map(({ type, png }) => {
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      throw new Error(`ICNS chunk type must contain exactly four ASCII characters: ${type}`)
    }
    const payload = Buffer.from(png)
    if (!payload.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`ICNS ${type} payload is not a PNG`)
    }

    const chunk = Buffer.allocUnsafe(8 + payload.length)
    chunk.write(type, 0, 4, 'ascii')
    chunk.writeUInt32BE(chunk.length, 4)
    payload.copy(chunk, 8)
    return chunk
  })

  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const header = Buffer.allocUnsafe(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(totalLength, 4)
  return Buffer.concat([header, ...chunks], totalLength)
}

export function buildPngIcnsFromIconset(iconset: string): Buffer {
  return buildPngIcns([
    { type: 'icp4', png: readFileSync(join(iconset, 'icon_16x16.png')) },
    { type: 'icp5', png: readFileSync(join(iconset, 'icon_32x32.png')) },
    { type: 'icp6', png: readFileSync(join(iconset, 'icon_32x32@2x.png')) },
    { type: 'ic07', png: readFileSync(join(iconset, 'icon_128x128.png')) },
    { type: 'ic08', png: readFileSync(join(iconset, 'icon_256x256.png')) },
    { type: 'ic09', png: readFileSync(join(iconset, 'icon_512x512.png')) },
    { type: 'ic10', png: readFileSync(join(iconset, 'icon_512x512@2x.png')) },
  ])
}
