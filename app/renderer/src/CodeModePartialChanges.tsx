import { useMemo } from 'react'
import { BoundedChildList } from './BoundedChildList.js'
import type { CodeModeEnvelope } from './codeMode.js'
import { useToolCardExpanded } from './toolCardExpansion.js'
import { displayFilePath } from './transcriptToolTarget.js'

/** A stopped script's write receipt stays visible even when its work is folded. */
export function CodeModePartialChanges({ files, cwd, id }: { files: CodeModeEnvelope['changedFiles']; cwd: string | null; id: string }) {
  const [all, setAll] = useToolCardExpanded(`code-mode-partial:${id}`, false)
  const shown = useMemo(() => all ? files : files.slice(0, 3), [files, all])
  const keys = useMemo(() => shown.map((file, index) => `${index}:${file.path}`), [shown])
  const file = (index: number) => {
    const file = shown[index]!
    const path = displayFilePath(file.path, cwd)
    return <span className="code-mode-file" title={file.path}>{path}
      {file.additions !== undefined ? <span className="code-mode-add"> +{file.additions}</span> : null}
      {file.deletions !== undefined ? <span className="code-mode-del"> −{file.deletions}</span> : null}
    </span>
  }
  return <div className="code-mode-partial" role="note">
    <strong>Changed before it stopped</strong>
    {all ? <BoundedChildList className="code-mode-partial-list" keys={keys} estimatedChildHeight={22} renderChild={file} /> : shown.map((_, index) => <span key={keys[index]}>{file(index)}</span>)}
    {files.length > 3 ? <button type="button" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show fewer files' : `Show all ${files.length} changed files`}</button> : null}
  </div>
}
