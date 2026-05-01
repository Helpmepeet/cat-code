import { describe, expect, test } from 'bun:test'

import {
  getEnterWorktreeResultCopy,
  getExitWorktreeActionCopy,
  getWorktreeExitDialogCopy,
} from './worktreeUxCopy.js'

describe('worktree UX copy', () => {
  test('frames worktree entry as an isolated attempt', () => {
    expect(getEnterWorktreeResultCopy()).toEqual({
      title: 'Started isolated attempt',
      detail: 'The main workspace is untouched.',
    })
  })

  test('frames exit actions around isolated results', () => {
    expect(getExitWorktreeActionCopy('keep')).toEqual({
      title: 'Kept isolated result',
      detail: 'You can return to it later if needed.',
    })

    expect(getExitWorktreeActionCopy('remove')).toEqual({
      title: 'Discarded isolated result',
      detail: 'The session returned to the main workspace.',
    })
  })

  test('uses semantic exit dialog labels and subtitle content', () => {
    const copy = getWorktreeExitDialogCopy({
      changedFiles: 2,
      commits: 1,
      hasTmuxSession: false,
    })

    expect(copy).toEqual({
      title: 'Finish isolated attempt',
      subtitle:
        'This isolated attempt has 2 changed files and 1 commit. Choose whether to keep or discard it.',
      options: [
        {
          label: 'Keep isolated result',
          description: 'Preserve the isolated result for later.',
        },
        {
          label: 'Discard isolated result',
          description: 'Discard the isolated result. This cannot be undone.',
        },
      ],
    })
  })

  test('uses safe cleanup copy when nothing changed', () => {
    const copy = getWorktreeExitDialogCopy({
      changedFiles: 0,
      commits: 0,
      hasTmuxSession: false,
    })

    expect(copy).toEqual({
      title: 'Finish isolated attempt',
      subtitle:
        'This isolated attempt has no pending changes and can be cleaned up safely.',
      options: [
        {
          label: 'Keep isolated result',
          description: 'Preserve the isolated result for later.',
        },
        {
          label: 'Discard isolated result',
          description: 'Clean up the isolated attempt.',
        },
      ],
    })
  })

  test('includes tmux-specific keep options', () => {
    const copy = getWorktreeExitDialogCopy({
      changedFiles: 1,
      commits: 0,
      hasTmuxSession: true,
    })

    expect(copy).toEqual({
      title: 'Finish isolated attempt',
      subtitle:
        'This isolated attempt has 1 changed file. Choose whether to keep or discard it.',
      options: [
        {
          label: 'Keep isolated result and tmux session',
          description:
            'Preserve the isolated result and leave its tmux session running.',
        },
        {
          label: 'Keep isolated result',
          description: 'Preserve the isolated result and stop its tmux session.',
        },
        {
          label: 'Discard isolated result',
          description: 'Discard the isolated result. This cannot be undone.',
        },
      ],
    })
  })

  test('uses the same full-sentence contract for commit-only work', () => {
    const copy = getWorktreeExitDialogCopy({
      changedFiles: 0,
      commits: 2,
      hasTmuxSession: false,
    })

    expect(copy.subtitle).toBe(
      'This isolated attempt has 2 commits. Choose whether to keep or discard it.',
    )
  })
})
