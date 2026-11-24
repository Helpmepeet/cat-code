import { memo, useMemo } from 'react'
import { codeModeOutputLines, QUIET_OUTPUT_LINE_LIMIT } from './codeModeDisplayOutput.js'
import { SourceTextView } from './SourceTextView.js'
import { VirtualLineList } from './VirtualLineList.js'
import { useSourceWrap } from './sourceWrap.js'

export const CodeModeOutput = memo(function CodeModeOutput({ output }: {
  output: string | undefined
}) {
  const formatted = useMemo(() => output === undefined ? null : codeModeOutputLines(output), [output])
  if (!formatted) return <div className="code-mode-output">Waiting for output</div>
  const { lines, gutters } = formatted
  if (lines.length <= QUIET_OUTPUT_LINE_LIMIT) return <VirtualLineList
    lines={lines} label="Output" className="code-mode-output code-mode-script-body" activeIndex={null} widthAffectsRowHeight={false}
    renderLine={(line, index) => <div className="code-mode-script-row">
      <span className="code-mode-script-gutter" aria-hidden>{gutters[index]}</span>
      <span>{line}</span>
    </div>}
  />
  return <LongOutput lines={lines} gutters={gutters} />
})

function LongOutput({ lines, gutters }: ReturnType<typeof codeModeOutputLines>) {
  const [wrap, setWrap] = useSourceWrap()
  const body = useMemo(() => lines.join('\n'), [lines])
  return <div className="code-mode-output code-mode-inline-output"><SourceTextView
    lines={lines} body={body} gutter={index => gutters[index]}
    language={/^\s*(?:\{|\[)/.test(body) ? 'json' : null} diffRows={null} wrap={wrap} onWrap={setWrap}
  /></div>
}
