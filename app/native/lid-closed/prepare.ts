import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin' || process.argv.length !== 2) throw new Error('Run prepare.ts on macOS without arguments')
const source = fileURLToPath(new URL('.', import.meta.url))
const output = mkdtempSync('/private/tmp/cat-lid-install-')
function run(command: string, args: string[], timeout = 60_000): string {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 1_048_576 })
  if (result.error || result.status !== 0) throw new Error(result.stderr || `${command} failed`)
  return result.stdout + result.stderr
}
const helper = join(output, 'helper')
run('/usr/bin/swiftc', ['-module-cache-path', join(output, 'cache'),
  join(source, 'LidCore.swift'), join(source, 'LidPlatform.swift'), join(source, 'main.swift'), '-o', helper])
// No entitlements. This is ordinary ad hoc signing, never the rejected route.
run('/usr/bin/codesign', ['--force', '--sign', '-', helper])
const signature = run('/usr/bin/codesign', ['-d', '--verbose=4', helper])
const cdhash = signature.match(/^CDHash=([a-f0-9]+)$/m)?.[1]
if (!cdhash) throw new Error('Could not pin the native helper signature')
const requirement = `cdhash H"${cdhash}"`
const installed = '/Library/PrivilegedHelperTools/com.catcode.lid-closed'
writeFileSync(join(output, 'configuration.json'), JSON.stringify({ version: 1, uid: process.getuid!(),
  bridgeRequirement: requirement, parents: [{ path: installed, requirement, experiment: true }],
  experimentUntil: Date.now() / 1000 + 24 * 60 * 60,
  qualifiedBoot: null, qualifiedOS: null, qualificationEvidence: null }) + '\n', { mode: 0o600 })
function plist(label: string, argument: string, mach = false) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${installed}</string><string>${argument}</string></array>\n<key>UserName</key><string>root</string><key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>1</integer>\n${mach ? '<key>MachServices</key><dict><key>com.catcode.lid-closed</key><true/></dict>' : ''}\n</dict></plist>\n`
}
writeFileSync(join(output, 'daemon.plist'), plist('com.catcode.lid-closed', '--daemon', true))
writeFileSync(join(output, 'recovery.plist'), plist('com.catcode.lid-closed.recovery', '--watch'))
copyFileSync(join(source, 'uninstall.sh'), join(output, 'uninstall.sh'))
const files = ['helper', 'configuration.json', 'daemon.plist', 'recovery.plist', 'uninstall.sh']
const sums = files.map(file =>
  `${createHash('sha256').update(readFileSync(join(output, file))).digest('hex')}  ${file}`).join('\n') + '\n'
writeFileSync(join(output, 'SHA256SUMS'), sums)
writeFileSync(join(output, 'install.sh'), readFileSync(join(source, 'install.sh'), 'utf8')
  .replace('__EXPECTED_PAYLOAD__', sums.trimEnd()), { mode: 0o700 })
chmodSync(join(output, 'install.sh'), 0o700)
const installerSHA256 = createHash('sha256').update(readFileSync(join(output, 'install.sh'))).digest('hex')
function quote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'" }
// Copy the approved installer into a root-owned directory, verify its pinned
// digest there, and execute that protected copy. The script pins payload hashes.
const privilegedInstall = `set -euo pipefail
lid_root_stage=$(/usr/bin/mktemp -d /private/tmp/cat-lid-root.XXXXXX)
trap '/bin/rm -rf "$lid_root_stage"' EXIT
/usr/bin/install -o root -g wheel -m 0600 ${quote(join(output, 'install.sh'))} "$lid_root_stage/install.sh"
/bin/echo '${installerSHA256}  '"$lid_root_stage/install.sh" | /usr/bin/shasum -a 256 -c -
/bin/bash "$lid_root_stage/install.sh" ${quote(output)}`
console.log(JSON.stringify({ preparedDirectory: output, hardwareQualified: false, installed: false,
  install: `sudo /bin/bash -c ${quote(privilegedInstall)}`, installerSHA256,
  restore: `sudo '${installed}' --restore-for-uninstall`,
  uninstall: "sudo /bin/bash '/Library/Application Support/Cat Code/LidClosed/uninstall.sh'",
  experiment: `${installed} --experiment progress`,
  helperSHA256: createHash('sha256').update(readFileSync(helper)).digest('hex') }, null, 2))
