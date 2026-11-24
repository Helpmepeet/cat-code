import { parse, tokTypes } from 'acorn'

const MIN_WHOLE_LINES = 8

export type CodeModeSourceFold = {
  from: number
  to: number
  startColumn: number
  endColumn: number
}

/** Acorn's template tokens cover only literal text, not delimiters or interpolated code. */
export function codeModeSourceFolds(lines: readonly string[]): CodeModeSourceFold[] {
  if (lines.length < MIN_WHOLE_LINES + 2) return []
  const source = lines.join('\n')
  const offsets = [0]
  for (let index = 0; index < lines.length - 1; index++) offsets.push(offsets[index]! + lines[index]!.length + 1)
  let line = 0
  const lineAt = (offset: number) => {
    while (line + 1 < offsets.length && offsets[line + 1]! <= offset) line++
    return line
  }
  const folds: CodeModeSourceFold[] = []
  try {
    parse(source, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, onToken(token) {
      if (token.type !== tokTypes.template && token.type !== tokTypes.invalidTemplate) return
      const from = lineAt(token.start)
      const to = lineAt(token.end)
      if (to - from - 1 >= MIN_WHOLE_LINES) folds.push({
        from, to, startColumn: token.start - offsets[from]!, endColumn: token.end - offsets[to]!,
      })
    } })
  } catch {
    return []
  }
  return folds
}

export function codeModeSourceRows(lines: readonly string[], folds: readonly CodeModeSourceFold[], revealed: ReadonlySet<number>, selectedFold?: CodeModeSourceFold) {
  const rows: { from: number; to: number; folds: CodeModeSourceFold[]; text: string }[] = []
  const closed = folds.filter(fold => !revealed.has(fold.from) && fold !== selectedFold)
  let nextFold = 0
  for (let from = 0; from < lines.length; from++) {
    let to = from
    let column = 0
    let text = ''
    const inRow: CodeModeSourceFold[] = []
    // Two templates can end and start on the same source line.
    while (closed[nextFold]?.from === to) {
      const fold = closed[nextFold++]!
      text += lines[to]!.slice(column, fold.startColumn) + '…'
      to = fold.to
      column = fold.endColumn
      inRow.push(fold)
    }
    rows.push({ from, to, folds: inRow, text: text + lines[to]!.slice(column) })
    from = to
  }
  return rows
}
