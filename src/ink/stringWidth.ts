const BUN_STRING_WIDTH_OPTS = { ambiguousIsNarrow: true } as const

export const stringWidth = (str: string): number =>
  Bun.stringWidth(str, BUN_STRING_WIDTH_OPTS)
