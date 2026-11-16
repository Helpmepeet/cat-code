import { useMemo, useState } from 'react'
import { BoundedChildList } from './BoundedChildList.js'
import type { CodeModeEnvelope } from './codeMode.js'

/** A stopped script's write receipt stays visible even when its work is folded. */
export function CodeModePartialChanges({ files }: { files: CodeModeEnvelope['changedFiles'] }) {
  const [all, setAll] = useState(false)
  const shown = all ? files : files.slice(0, 3)
  const keys = useMemo(() => shown.map((file, index) => `${index}:${file.path}`), [files, all])
  const file = (index: number) => {
      const file = shown[index]!
      return <span className="code-mode-file" title={file.path}>{index ? ', ' : ''}{file.path.length > 256 ? `${file.path.slice(0, 256)}…` : file.path}{file.additions !== undefined ? ` +${file.additions}` : ''}{file.deletions !== undefined ? ` −${file.deletions}` : ''}</span>
  }
  return <div className="code-mode-partial" role="note">
    <strong>Changed before it stopped: </strong>
    {all ? <BoundedChildList keys={keys} estimatedChildHeight={28} renderChild={file} /> : shown.map((_, index) => <span key={keys[index]}>{file(index)}</span>)}
    {files.length > 3 ? <button aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? 'Show fewer files' : `Show all ${files.length} changed files`}</button> : null}
  </div>
}
