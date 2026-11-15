import { useMemo, useState } from 'react'
import { SourceTextView } from './SourceTextView.js'
import { useSourceWrap } from './sourceWrap.js'

export function CodeModeOutput({ output }: { output: string | undefined }) {
  const [expanded, setExpanded] = useState(false)
  return <div className="code-mode-output">
    <details open={expanded}>
      <summary onClick={event => { event.preventDefault(); setExpanded(value => !value) }}>Output</summary>
      {expanded && output !== undefined ? <OutputBody output={output} /> : null}
    </details>
    {!expanded ? output !== undefined ? <pre>{output ? output.slice(0, 1600) : 'Empty output'}</pre> : <span>Waiting for output</span> : null}
  </div>
}
function OutputBody({ output }: { output: string }) {
  const [wrap, setWrap] = useSourceWrap()
  const lines = useMemo(() => output.split('\n'), [output])
  return <div className="code-mode-inline-output"><SourceTextView lines={lines} body={output} copy={output} gutter={index => index + 1} language={/^\s*(?:\{|\[)/.test(output) ? 'json' : null} diffRows={null} wrap={wrap} onWrap={setWrap} /></div>
}
