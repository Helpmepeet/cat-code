import ts from 'typescript'

export const executionTargets: Record<string, string[]> = {
  'App.tsx': ['App'], 'SessionPane.tsx': ['SessionPane'], 'Sidebar.tsx': ['Sidebar'],
  'TabBar.tsx': ['TabBar'], 'TranscriptView.tsx': ['TranscriptRowsView'],
  'FocusedTranscript.tsx': ['FocusedTranscript'], 'focusedTranscriptLayout.ts': ['deriveFocusedTranscript'],
}

/** Parse bodies rather than matching parameter text, but fail closed on missing/duplicate names. */
export function instrumentExecutions(source: string, filename: string): string {
  const names = executionTargets[filename]
  if (!names) return source
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const positions: Array<{ position: number; name: string }> = []
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && names.includes(node.name.text) && node.body) {
      positions.push({ position: node.body.getStart(file) + 1, name: node.name.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const name of names) if (positions.filter(item => item.name === name).length !== 1) throw new Error(`benchmark execution anchor drifted: ${filename}:${name}`)
  for (const { position, name } of positions.sort((a, b) => b.position - a.position)) {
    source = source.slice(0, position) + `\nbenchmarkCountExecution('${name}');\n` + source.slice(position)
  }
  return `import { benchmarkCountExecution } from '../../scripts/streaming-benchmark-observer.js'\n` + source
}

export function transcriptMode(value: string | undefined): 'full' | 'focused' {
  if (value === undefined) return 'full'
  if (value !== 'full' && value !== 'focused') throw new Error('transcript mode must be full or focused')
  return value
}
export const performanceMetricNames = ['ScriptDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount'] as const
export function performanceMetricDeltas(before: Array<{ name: string; value: number }>, after: Array<{ name: string; value: number }>) {
  return Object.fromEntries(performanceMetricNames.map(name => {
    const start = before.find(item => item.name === name)?.value
    const end = after.find(item => item.name === name)?.value
    if (start === undefined || end === undefined || end < start) throw new Error(`invalid CDP metric: ${name}`)
    return [name, end - start]
  }))
}
