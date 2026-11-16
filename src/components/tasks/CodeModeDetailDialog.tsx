import React, { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { readArchivedCodeModeOutput, type CodeModeTaskState } from '../../tasks/CodeModeTask.js'
import { Dialog } from '../design-system/Dialog.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  task: Readonly<Omit<CodeModeTaskState, 'receipt'> & {
    receipt?: Readonly<Pick<NonNullable<CodeModeTaskState['receipt']>, 'status' | 'output'>>
  }>
  onDone: () => void
  onBack?: () => void
  onStop: () => Promise<void>
}
const MAX_VISIBLE_OUTPUT = 8000

export function CodeModeDetailDialog({ task, onDone, onBack, onStop }: Props): React.ReactNode {
  const [archiveResult, setArchiveResult] = useState<{ id: string; integrity: CodeModeTaskState['archiveIntegrity']; output?: string }>()
  const [stopError, setStopError] = useState<string>()
  const [requestingStop, setRequestingStop] = useState(false)
  useKeybindings({ 'confirm:yes': onDone }, { context: 'Confirmation' })
  useEffect(() => {
    if (!task.outputArchived) return
    let active = true
    // Only the verified selected projection crosses this boundary, never child audit.
    void readArchivedCodeModeOutput({ ...task, receipt: undefined }).then(output => {
      let selected: string | undefined
      try {
        const projection: unknown = output === undefined ? undefined : JSON.parse(output)
        if (projection && typeof projection === 'object' && 'output' in projection && typeof projection.output === 'string') selected = projection.output
      } catch { /* Invalid artifacts are unavailable, not raw display text. */ }
      if (active) setArchiveResult({ id: task.id, integrity: task.archiveIntegrity, output: selected })
    })
    return () => { active = false }
  }, [task.id, task.outputArchived, task.outputFile, task.archiveIntegrity])
  const canStop = !task.settled && !task.cancellationRequested && !requestingStop
  const requestStop = () => {
    if (!canStop) return
    setRequestingStop(true)
    setStopError(undefined)
    void onStop().catch(error => {
      setStopError(String(error))
      setRequestingStop(false)
    })
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'left' && onBack) { event.preventDefault(); onBack() }
    else if (event.key === 'x' && canStop) { event.preventDefault(); requestStop() }
  }
  const loadingArchive = task.outputArchived && (!archiveResult || archiveResult.id !== task.id || archiveResult.integrity !== task.archiveIntegrity)
  const output = task.outputArchived ? loadingArchive ? undefined : archiveResult?.output : task.receipt?.output
  const status = !task.settled && (task.cancellationRequested || requestingStop)
    ? 'Cancellation requested. Waiting for execution to settle.'
    : task.receipt?.status ?? task.status
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
    <Dialog title="Code Mode task" onCancel={onDone} inputGuide={() => <Byline>
      {onBack && <KeyboardShortcutHint shortcut="←" action="back" />}
      {canStop && <KeyboardShortcutHint shortcut="x" action="stop" />}
      <KeyboardShortcutHint shortcut="Esc" action="close" />
    </Byline>}>
      <Text bold>{task.description}</Text>
      <Text>{status}</Text>
      {task.delivery === 'failed' && <Text color="error">Result delivery failed. The result is retained for retry.</Text>}
      {stopError && <Text color="error">Could not request cancellation: {stopError}</Text>}
      {!task.settled && <Text dimColor>Partial output</Text>}
      {output === undefined ? <Text dimColor>{loadingArchive ? 'Loading selected output…' : task.outputArchived ? 'Archived Code Mode output is unavailable.' : 'No selected output yet.'}</Text>
        : output === '' ? <Text dimColor>No selected output.</Text>
          : <Text>{output.slice(0, MAX_VISIBLE_OUTPUT)}</Text>}
      {output !== undefined && output.length > MAX_VISIBLE_OUTPUT && <Text dimColor>More selected output is available through TaskOutput.</Text>}
    </Dialog>
  </Box>
}
