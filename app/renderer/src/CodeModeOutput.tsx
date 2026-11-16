import { useMemo, useState } from 'react'
import { SourceTextView } from './SourceTextView.js'
import { useSourceWrap } from './sourceWrap.js'

export function CodeModeOutput({ output }: { output: string | undefined }) {
  const [expanded, setExpanded] = useState(false)
  const count = useMemo(() => {
    if (!output) return 0
    let lines = 1
    for (let index = 0; index < output.length; index++) if (output[index] === '\n') lines++
    return lines
  }, [output])
  return <div className="code-mode-output">
    <details open={expanded}>
      <summary onClick={event => { event.preventDefault(); setExpanded(value => !value) }}><span className={`code-mode-caret${expanded ? ' is-open' : ''}`} aria-hidden>▸</span><span className="code-mode-output-mark" aria-hidden>↩</span> Output <span className="code-mode-output-count">{output === undefined ? 'Waiting for output' : output ? `${count} ${count === 1 ? 'line' : 'lines'}` : 'empty'}</span></summary>
      {expanded ? output ? <OutputBody output={output} /> : <span>{output === undefined ? 'Waiting for output' : 'Nothing was returned.'}</span> : null}
    </details>
  </div>
}
function OutputBody({ output }: { output: string }) {
  const [wrap, setWrap] = useSourceWrap()
  const lines = useMemo(() => output.split('\n'), [output])
  return <div className="code-mode-inline-output"><SourceTextView lines={lines} body={output} copy={output} gutter={index => index + 1} language={/^\s*(?:\{|\[)/.test(output) ? 'json' : null} diffRows={null} wrap={wrap} onWrap={setWrap} /></div>
}
