import { constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

export const DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL =
  'com.cat-code.deferred-continuation'
export const DEFERRED_CONTINUATION_WORKER_ARGUMENT =
  'deferred-continuation-worker'

const execFileAsync = promisify(execFile)

export function getDeferredContinuationLaunchAgentPath(
  home = homedir(),
): string {
  return join(
    home,
    'Library',
    'LaunchAgents',
    `${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}.plist`,
  )
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

export function renderDeferredContinuationLaunchAgent(
  executablePath: string,
): string {
  if (!isAbsolute(executablePath)) {
    throw new Error('Background continuation executable must be absolute')
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executablePath)}</string>
    <string>${DEFERRED_CONTINUATION_WORKER_ARGUMENT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`
}

export async function validateStableDeferredContinuationExecutable(
  candidate: string,
): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Background continuation is only supported on macOS')
  }
  if (!isAbsolute(candidate)) {
    throw new Error('Background continuation requires an absolute executable path')
  }
  const canonical = await realpath(candidate)
  const info = await lstat(canonical)
  await access(canonical, fsConstants.X_OK)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Background continuation executable is not a regular file')
  }
  const lower = canonical.toLowerCase()
  if (
    lower.endsWith('/bun') ||
    lower.endsWith('/node') ||
    lower.includes('/node_modules/') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx')
  ) {
    throw new Error(
      'Background continuation requires an installed Cat Code executable',
    )
  }
  return canonical
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeLaunchAgentAtomically(path: string, contents: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temp = join(parent, `.${DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL}.${randomUUID()}.tmp`)
  const handle = await open(
    temp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  )
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  await chmod(path, 0o600)
  await syncDirectory(parent)
}

export type DeferredContinuationBackgroundStatus =
  | { state: 'disabled' }
  | { state: 'enabled'; executablePath: string }
  | { state: 'needs_repair'; executablePath?: string }

export async function getDeferredContinuationBackgroundStatus(
  plistPath = getDeferredContinuationLaunchAgentPath(),
): Promise<DeferredContinuationBackgroundStatus> {
  let contents: string
  try {
    const info = await lstat(plistPath)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    ) {
      return { state: 'needs_repair' }
    }
    contents = await readFile(plistPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'disabled' }
    return { state: 'needs_repair' }
  }
  const match = contents.match(
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>\s*<string>deferred-continuation-worker<\/string>/,
  )
  const executablePath = match?.[1] ? unescapeXml(match[1]) : undefined
  if (
    !executablePath ||
    !isAbsolute(executablePath) ||
    executablePath.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(executablePath)
  ) {
    return { state: 'needs_repair' }
  }
  try {
    const canonical = await validateStableDeferredContinuationExecutable(executablePath)
    return { state: 'enabled', executablePath: canonical }
  } catch {
    return { state: 'needs_repair', executablePath }
  }
}

export async function installDeferredContinuationLaunchAgent(
  executablePath: string,
  plistPath = getDeferredContinuationLaunchAgentPath(),
): Promise<string> {
  const canonical = await validateStableDeferredContinuationExecutable(executablePath)
  await writeLaunchAgentAtomically(
    plistPath,
    renderDeferredContinuationLaunchAgent(canonical),
  )
  try {
    await execFileAsync('launchctl', [
      'bootout',
      `gui/${process.getuid!()}`,
      plistPath,
    ])
  } catch {
    // First install has no loaded job; bootstrap below is authoritative.
  }
  try {
    await execFileAsync('launchctl', [
      'bootstrap',
      `gui/${process.getuid!()}`,
      plistPath,
    ])
  } catch (error) {
    await unlink(plistPath).catch(() => {})
    await syncDirectory(dirname(plistPath)).catch(() => {})
    throw error
  }
  return canonical
}

export async function uninstallDeferredContinuationLaunchAgent(
  plistPath = getDeferredContinuationLaunchAgentPath(),
): Promise<boolean> {
  try {
    await lstat(plistPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    await execFileAsync('launchctl', [
      'bootout',
      `gui/${process.getuid!()}`,
      plistPath,
    ])
  } catch {
    // Removing the durable plist is authoritative even if no instance is loaded.
  }
  await unlink(plistPath)
  await syncDirectory(dirname(plistPath))
  return true
}
