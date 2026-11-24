import type { CodeModeEnvelope } from './codeMode.js'

export const QUIET_OUTPUT_LINE_LIMIT = 200

export function codeModeOutputLines(output: string) {
  const gutters: (string | undefined)[] = []
  const lines = output.split('\n').map((line, index) => {
    const numbered = /^ *([0-9]+)\t/.exec(line)
    if (numbered) {
      gutters[index] = numbered[1]
      return line.slice(numbered[0].length)
    }
    return line.replace(/^((?:Updated|Added|Deleted) .+) \(hunk \d+ at old source coordinates \[\d+, \d+\).*\)\r?$/, '$1')
  })
  return { lines, gutters }
}

/** Older Script rows store selected text and the model's receipt together. */
export function codeModeDisplayOutput(cell: CodeModeEnvelope, visibleReasons: ReadonlySet<string>): string {
  const { output, calls, changedFiles } = cell
  const heading = `[Code Mode] ${cell.status}; cell ${cell.cellId}; generation ${cell.generation}.`
  const separator = '\n\n'
  const last = output.lastIndexOf(separator + heading + '\n')
  if (last < 0 && !output.startsWith(heading + '\n')) return output

  const start = last < 0 ? 0 : last + separator.length
  const lines = output.slice(start + heading.length + 1).split('\n')
  const unsuccessful = calls.filter(call => call.status !== 'completed')
  const count = `${calls.length - unsuccessful.length} child calls completed; ${unsuccessful.length} failed, blocked, or cancelled.`
  const truncated = lines[0] === 'Selected output was truncated at the cell delivery limit.'
  if (lines[truncated ? 1 : 0] !== count) return output

  const details = lines.slice(truncated ? 2 : 1).join('\n')
  const changes = changedFiles.length
    ? `Structured file-change receipts: ${changedFiles.map(file => file.path).join(', ')}. Bash effects are not enumerated here.`
    : ''
  const failures = unsuccessful.length
    ? `Non-successful calls: ${unsuccessful.map(call => `${call.name} (${call.status})`).join(', ')}. Earlier effects were not rolled back.`
    : ''
  let notices = details
  for (const summary of [changes, failures]) {
    if (!summary) continue
    if (notices === summary) notices = ''
    else if (notices.endsWith('\n' + summary)) notices = notices.slice(0, -summary.length - 1)
  }
  // The host puts the Script error before permission-specific details. Drop a
  // copy only when that entire error is already rendered by the card.
  const reported = cell.error?.slice(0, 4096)
  if (reported && visibleReasons.has(cell.error!)) {
    if (notices === reported) notices = ''
    else if (notices.startsWith(reported + '\n')) notices = notices.slice(reported.length + 1)
  }
  // A permission detail can repeat the child error with the tool name in front.
  // A distinct reason (including a multiline reason) stays in the output.
  for (const call of unsuccessful) {
    if (!call.error || !visibleReasons.has(call.error)) continue
    notices = removeReceiptDetail(notices, `${call.name}: ${call.error}`)
  }
  const selected = last < 0 ? '' : output.slice(0, last)
  return [selected, truncated ? lines[0] : '', notices].filter(Boolean).join(separator)
}

function removeReceiptDetail(notices: string, detail: string): string {
  const withBoundaries = '\n' + notices + '\n'
  const match = withBoundaries.indexOf('\n' + detail + '\n')
  if (match < 0) return notices
  return (withBoundaries.slice(0, match) + withBoundaries.slice(match + detail.length + 1)).slice(1, -1)
}
