export type WorktreeExitCopyInput = {
  changedFiles: number
  commits: number
  hasTmuxSession: boolean
}

export type WorktreeExitOptionCopy = {
  label: string
  description: string
}

type WorktreeResultCopy = {
  title: string
  detail: string
}

type WorktreeExitDialogCopy = {
  title: string
  subtitle: string
  options: WorktreeExitOptionCopy[]
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function changedWorkDescription({
  changedFiles,
  commits,
}: Pick<WorktreeExitCopyInput, 'changedFiles' | 'commits'>): string {
  const parts: string[] = []

  if (changedFiles > 0) {
    parts.push(pluralize(changedFiles, 'changed file'))
  }

  if (commits > 0) {
    parts.push(pluralize(commits, 'commit'))
  }

  if (parts.length === 0) {
    return 'This isolated attempt has no pending changes.'
  }

  return `This isolated attempt has ${parts.join(' and ')}.`
}

export function getEnterWorktreeResultCopy(): WorktreeResultCopy {
  return {
    title: 'Started isolated attempt',
    detail: 'The main workspace is untouched.',
  }
}

export function getExitWorktreeActionCopy(
  action: 'keep' | 'remove',
): WorktreeResultCopy {
  if (action === 'keep') {
    return {
      title: 'Kept isolated result',
      detail: 'You can return to it later if needed.',
    }
  }

  return {
    title: 'Discarded isolated result',
    detail: 'The session returned to the main workspace.',
  }
}

export function getWorktreeExitDialogCopy(
  input: WorktreeExitCopyInput,
): WorktreeExitDialogCopy {
  const { changedFiles, commits, hasTmuxSession } = input
  const hasChanges = changedFiles > 0 || commits > 0
  const pendingWork = changedWorkDescription({ changedFiles, commits })

  const subtitle = hasChanges
    ? `${pendingWork} Choose whether to keep or discard it.`
    : 'This isolated attempt has no pending changes and can be cleaned up safely.'

  const discardDescription = hasChanges
    ? 'Discard the isolated result. This cannot be undone.'
    : 'Clean up the isolated attempt.'

  const options = hasTmuxSession
    ? [
        {
          label: 'Keep isolated result and tmux session',
          description: 'Preserve the isolated result and leave its tmux session running.',
        },
        {
          label: 'Keep isolated result',
          description: 'Preserve the isolated result and stop its tmux session.',
        },
        {
          label: 'Discard isolated result',
          description: discardDescription,
        },
      ]
    : [
        {
          label: 'Keep isolated result',
          description: 'Preserve the isolated result for later.',
        },
        {
          label: 'Discard isolated result',
          description: discardDescription,
        },
      ]

  return {
    title: 'Finish isolated attempt',
    subtitle,
    options,
  }
}
