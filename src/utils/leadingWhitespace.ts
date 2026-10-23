export type LeadingWhitespaceAdjustment = { from: string; to: string }
export const MAX_LEADING_WHITESPACE_PREFIX_CHARS = 256

export function isBlankIndentationLine(line: string): boolean {
  return /^[\t ]*$/.test(line)
}

export function leadingWhitespace(line: string): string {
  return /^[\t ]*/.exec(line)![0]
}

/** Derive from old lines only, never shorten the prefix to accommodate additions. */
export function commonLeadingWhitespace(
  lines: readonly string[],
  charge: () => void = () => {},
): string | undefined {
  const anchor = lines.find(line => !isBlankIndentationLine(line))
  if (anchor === undefined) return undefined
  let from = leadingWhitespace(anchor)
  for (const line of lines) {
    charge()
    if (isBlankIndentationLine(line)) continue
    while (!line.startsWith(from)) {
      charge()
      from = from.slice(0, -1)
    }
  }
  return from
}

export function leadingWhitespaceAdjustment(
  anchor: string,
  actual: string,
  from: string,
): LeadingWhitespaceAdjustment | undefined {
  const retained = leadingWhitespace(anchor.slice(from.length))
  const actualLeading = leadingWhitespace(actual)
  if (!actualLeading.endsWith(retained)) return undefined
  const to = actualLeading.slice(0, actualLeading.length - retained.length)
  if (from === to || to + anchor.slice(from.length) !== actual) return undefined
  return { from, to }
}

/** Blank additions retain their bytes; nonblank additions must support the old prefix. */
export function replaceLeadingWhitespace(
  line: string,
  { from, to }: LeadingWhitespaceAdjustment,
): string | undefined {
  if (isBlankIndentationLine(line)) return line
  return line.startsWith(from) ? to + line.slice(from.length) : undefined
}

export function matchesAdjustedIndentationLine(expected: string, actual: string): boolean {
  return isBlankIndentationLine(expected)
    ? isBlankIndentationLine(actual)
    : expected === actual
}
