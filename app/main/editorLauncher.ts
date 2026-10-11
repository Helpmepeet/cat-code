import { spawn, type ChildProcess } from 'node:child_process'
import { lstat } from 'node:fs/promises'

import type { SourceLocation } from './openWorkspaceFile.js'

export type WorkspaceEditor = 'vscode' | 'cursor' | 'zed'
const CLI_ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000

/**
 * CLI candidates are host-owned deployment paths, never renderer input.
 * A source location must use the editor CLI: macOS `open -a --args` does not
 * deliver arguments to an already-running application.
 */
export async function launchEditorApp(
  editor: WorkspaceEditor,
  appName: string,
  cliBinaries: readonly string[],
  filePath: string,
  location?: SourceLocation,
): Promise<boolean> {
  // VS Code and Cursor's --goto parser splits every colon, including numeric
  // filename segments. Reject an unrepresentable selection rather than let
  // that parser change the already-validated canonical file.
  if (location && editor !== 'zed' && filePath.includes(':')) return false

  if (!location && process.platform === 'darwin' && await openMacApp(appName, filePath)) {
    return true
  }

  const pathWithLocation = location
    ? `${filePath}:${location.line}${location.column === undefined ? '' : `:${location.column}`}`
    : filePath
  if (location && editor === 'zed') {
    // Zed prefers an existing literal even when a position was supplied. A
    // normalized suffix must not select another file or follow its symlink.
    try {
      await lstat(pathWithLocation)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
  }
  const args = location && editor !== 'zed'
    ? ['--goto', pathWithLocation]
    : [pathWithLocation]
  for (const binary of cliBinaries) {
    const outcome = await launchCli(binary, args)
    if (outcome === 'accepted') return true
    // A live CLI might already have launched or contacted the editor. Starting
    // another candidate after an ambiguous timeout could duplicate the action.
    if (outcome === 'unresolved') return false
  }
  return false
}

/** A zero exit acknowledges the CLI request; it does not prove editor selection. */
function launchCli(binary: string, args: readonly string[]): Promise<'accepted' | 'failed' | 'unresolved'> {
  return new Promise(resolve => {
    let child: ChildProcess | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (outcome: 'accepted' | 'failed' | 'unresolved') => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      child?.removeListener('error', onError)
      child?.removeListener('exit', onExit)
      child?.unref()
      resolve(outcome)
    }
    const onError = () => finish('failed')
    const onExit = (code: number | null) => finish(code === 0 ? 'accepted' : 'failed')
    try {
      child = spawn(binary, args, { detached: true, stdio: 'ignore' })
      child.once('error', onError)
      child.once('exit', onExit)
      timer = setTimeout(() => finish('unresolved'), CLI_ACKNOWLEDGEMENT_TIMEOUT_MS)
    } catch {
      finish('failed')
    }
  })
}

function openMacApp(appName: string, filePath: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn('open', ['-a', appName, filePath], { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('exit', code => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}
