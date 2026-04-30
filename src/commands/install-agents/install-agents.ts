import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

import type { LocalCommandCall } from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'

// ── Constants ──────────────────────────────────────────────────────────────

const RESUME_LABEL = 'com.codex-nootp.resume'
const TOUCH_ALL_LABEL = 'com.codex-nootp.touch-all'

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents')
const LOG_DIR = join(homedir(), '.codex-nootp')

const RESUME_PLIST = join(LAUNCH_AGENTS_DIR, `${RESUME_LABEL}.plist`)
const TOUCH_ALL_PLIST = join(LAUNCH_AGENTS_DIR, `${TOUCH_ALL_LABEL}.plist`)

// ── Plist generation ───────────────────────────────────────────────────────

function makeResumePlist(cliPath: string): string {
  const logPath = join(LOG_DIR, 'launchd-resume.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${RESUME_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cliPath}</string>
    <string>touch-all</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`
}

function makeTouchAllPlist(cliPath: string): string {
  const logPath = join(LOG_DIR, 'launchd-touch-all.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${TOUCH_ALL_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${cliPath}</string>
    <string>touch-all</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`
}

// ── CLI path resolution ────────────────────────────────────────────────────

function resolveCliPath(): string | null {
  // process.argv[1] is typically the script/binary path
  const argv1 = process.argv[1]
  if (argv1 && argv1.startsWith('/')) return argv1

  // Fallback: look for the compiled binary in the project directory
  // process.argv[0] is the Bun runtime
  try {
    const which = execSync('which claude 2>/dev/null || which claude-code 2>/dev/null', {
      encoding: 'utf-8',
    }).trim()
    if (which) return which
  } catch {}

  return null
}

// ── Command implementation ─────────────────────────────────────────────────

export const call: LocalCommandCall = async (args) => {
  if (process.platform !== 'darwin') {
    return {
      type: 'text',
      value: 'LaunchAgents are only supported on macOS.',
    }
  }

  const action = args.trim().toLowerCase() || 'install'

  if (action === 'uninstall') {
    return uninstallAgents()
  }

  if (action === 'install') {
    return installAgents()
  }

  return {
    type: 'text',
    value: 'Usage: /install-agents [install|uninstall]',
  }
}

function installAgents(): { type: 'text'; value: string } {
  const cliPath = resolveCliPath()
  if (!cliPath) {
    return {
      type: 'text',
      value:
        'Could not determine CLI binary path. Run from an absolute path or ensure "claude" is in PATH.',
    }
  }

  // Ensure directories exist
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true })
  }
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }

  // Unload existing agents first (ignore errors if not loaded)
  for (const plist of [RESUME_PLIST, TOUCH_ALL_PLIST]) {
    if (existsSync(plist)) {
      try {
        execSync(`launchctl unload "${plist}" 2>/dev/null`)
      } catch {}
    }
  }

  // Write plists
  writeFileSync(RESUME_PLIST, makeResumePlist(cliPath))
  writeFileSync(TOUCH_ALL_PLIST, makeTouchAllPlist(cliPath))

  // Load agents
  const errors: string[] = []
  for (const plist of [RESUME_PLIST, TOUCH_ALL_PLIST]) {
    try {
      execSync(`launchctl load "${plist}"`)
    } catch (err) {
      errors.push(
        `Failed to load ${plist}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  logForDebugging(`[install-agents] Installed LaunchAgents using CLI: ${cliPath}`)

  const lines = [
    'LaunchAgents installed:',
    '',
    `  ${RESUME_LABEL}    → runs on login (touch-all)`,
    `  ${TOUCH_ALL_LABEL} → daily at 03:00 (touch-all)`,
    '',
    `CLI path: ${cliPath}`,
    `Logs: ${LOG_DIR}/launchd-*.log`,
  ]
  if (errors.length > 0) {
    lines.push('', 'Errors:', ...errors.map((e) => `  ${e}`))
  }

  return { type: 'text', value: lines.join('\n') }
}

function uninstallAgents(): { type: 'text'; value: string } {
  const removed: string[] = []
  for (const [label, plist] of [
    [RESUME_LABEL, RESUME_PLIST],
    [TOUCH_ALL_LABEL, TOUCH_ALL_PLIST],
  ] as const) {
    if (existsSync(plist)) {
      try {
        execSync(`launchctl unload "${plist}" 2>/dev/null`)
      } catch {}
      try {
        unlinkSync(plist)
      } catch {}
      removed.push(label)
    }
  }

  if (removed.length === 0) {
    return { type: 'text', value: 'No LaunchAgents found to uninstall.' }
  }

  logForDebugging(`[install-agents] Uninstalled: ${removed.join(', ')}`)
  return {
    type: 'text',
    value: `Uninstalled: ${removed.join(', ')}`,
  }
}
