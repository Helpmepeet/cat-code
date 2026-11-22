import { memo, useMemo } from 'react'
import { SourceTextView } from './SourceTextView.js'
import { VirtualLineList } from './VirtualLineList.js'
import { useSourceWrap } from './sourceWrap.js'

export const CodeModeOutput = memo(function CodeModeOutput({ output, lineCount }: {
  output: string | undefined
  lineCount: number
}) {
  const [wrap, setWrap] = useSourceWrap()
  const lines = useMemo(() => output?.split('\n') ?? [], [output])
  if (output === undefined) return <div className="code-mode-output">Waiting for output</div>
  if (lineCount <= 16 && output.length <= 1024) return <VirtualLineList
    lines={lines} className="code-mode-output code-mode-script-body" activeIndex={null} widthAffectsRowHeight={false}
    renderLine={(line, index) => <div className="code-mode-script-row">
      <span className="code-mode-script-gutter" aria-hidden>{index + 1}</span>
      <span>{line}</span>
    </div>}
  />
  return <div className="code-mode-output code-mode-inline-output"><SourceTextView
    lines={lines} body={output} copy={output} gutter={index => index + 1}
    language={/^\s*(?:\{|\[)/.test(output) ? 'json' : null} diffRows={null} wrap={wrap} onWrap={setWrap}
  /></div>
})
