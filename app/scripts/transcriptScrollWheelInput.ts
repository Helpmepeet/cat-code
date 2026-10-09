export type SyntheticWheelRequest = { id: number; x: number; y: number; deltaY: 2 | -2 }

// This is only the isolated fixture's input contract, not a product bridge.
export function readSyntheticWheelRequest(value: unknown): SyntheticWheelRequest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 4 || keys.some(key => !['id', 'x', 'y', 'deltaY'].includes(key))) return null
  const { id, x, y, deltaY } = record
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 1_000) return null
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x >= 1_100) return null
  if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y >= 950) return null
  if (deltaY !== 2 && deltaY !== -2) return null
  return { id, x, y, deltaY }
}
