import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLidHelper } from '../../scripts/build-lid-helper.js'

const macTest = process.platform === 'darwin' ? test : test.skip
macTest('native identity admits an exact sealed allowlist and rejects broadened or unprotected code', async () => {
  const scratch = mkdtempSync('/private/tmp/cat-lid-identity-')
  const source = fileURLToPath(new URL('.', import.meta.url))
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 })
    if (r.error || r.status !== 0) throw new Error(r.stderr || `${cmd} exited ${r.status}`)
    return r.stdout + r.stderr
  }
  const sign = (path: string, extra: string[] = []) => run('/usr/bin/codesign', ['--force', '--sign', '-', ...extra, path])
  const bundle = join(scratch, 'Fixture.app')
  const contents = join(bundle, 'Contents')
  const executable = join(contents, 'MacOS', 'fixture')
  const helper = join(source, 'dist', 'helper')
  let child: ReturnType<typeof spawn> | undefined
  try {
    buildLidHelper()
    mkdirSync(dirname(executable), { recursive: true })
    mkdirSync(join(contents, 'Resources'), { recursive: true })
    writeFileSync(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>com.catcode.desktop.dev</string><key>CFBundlePackageType</key><string>APPL</string><key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>fixture</string></dict></dict></dict></plist>')
    const archive = join(contents, 'Resources', 'app.asar')
    writeFileSync(archive, 'sealed fixture')
    writeFileSync(join(scratch, 'main.c'), '#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("ready"); fflush(stdout); sleep(30); return 0; }\n')
    run('/usr/bin/clang', [join(scratch, 'main.c'), '-o', executable])
    writeFileSync(join(scratch, 'library.c'), '__attribute__((used)) const char fuse[] = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\\x01\\x08" "01001100";\nint fixture(void) { return 1; }\n')
    const library = join(scratch, 'library.dylib')
    run('/usr/bin/clang', ['-dynamiclib', join(scratch, 'library.c'), '-o', library])
    const frameworks = ['Electron Framework', 'Mantle', 'ReactiveObjC', 'Squirrel']
    const binaries: string[] = []
    for (const name of frameworks) {
      const path = join(contents, 'Frameworks', `${name}.framework`)
      const version = join(path, 'Versions', 'A')
      mkdirSync(join(version, 'Resources'), { recursive: true })
      writeFileSync(join(version, 'Resources', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleIdentifier</key><string>fixture.${name.replaceAll(' ', '')}</string><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleVersion</key><string>1</string></dict></plist>`)
      symlinkSync('A', join(path, 'Versions', 'Current'))
      symlinkSync(`Versions/Current/${name}`, join(path, name))
      symlinkSync('Versions/Current/Resources', join(path, 'Resources'))
      copyFileSync(library, join(version, name))
      binaries.push(join(version, name))
      if (name === 'Electron Framework') {
        mkdirSync(join(version, 'Libraries'))
        for (const lib of ['libEGL', 'libGLESv2', 'libffmpeg', 'libvk_swiftshader']) {
          const file = join(version, 'Libraries', `${lib}.dylib`)
          copyFileSync(library, file); sign(file); binaries.push(file)
        }
      }
      sign(path)
    }
    sign(bundle, ['--deep'])
    const hashes = binaries.map(path => run('/usr/bin/codesign', ['-d', '--verbose=4', path]).match(/^CDHash=([a-f0-9]{40})$/m)![1]!).sort()
    const constraint = join(scratch, 'libraries.plist')
    const writeConstraint = (values: string[]) => writeFileSync(constraint, `<?xml version="1.0"?><plist version="1.0"><dict><key>cdhash</key><dict><key>$in</key><array>${values.map(hash => `<data>${Buffer.from(hash, 'hex').toString('base64')}</data>`).join('')}</array></dict></dict></plist>`)
    const protect = (flags = 'hard,kill') => sign(bundle, ['--options', flags, '--library-constraint', constraint, '--enforce-constraint-validity'])
    const qualifies = () => spawnSync(helper, ['--check-application', executable], { encoding: 'utf8', timeout: 10_000 }).status === 0
    writeConstraint(hashes); protect()
    expect(qualifies()).toBe(true)
    sign(bundle, ['--options', 'hard,kill'])
    expect(qualifies()).toBe(false)
    writeConstraint([...hashes, '01'.repeat(20)]); protect()
    expect(qualifies()).toBe(false)
    writeConstraint(hashes); protect('0')
    expect(qualifies()).toBe(false)
    protect()
    const payload = readFileSync(archive)
    writeFileSync(archive, 'substituted payload')
    expect(qualifies()).toBe(false)
    writeFileSync(archive, payload); protect()
    expect(qualifies()).toBe(true)
    // Exercise the live Security-framework check against an actual process,
    // rather than supplying status bits to a fake implementation.
    const probe = join(scratch, 'Probe.swift')
    writeFileSync(probe, 'import Foundation\n@main struct Probe { static func main() { if CommandLine.arguments[1] == "--acl" { exit(lidReadOnlyACL(CommandLine.arguments[2]) ? 0 : 1) }; let pid = Int32(CommandLine.arguments[1])!; exit(lidUndebuggedCode(pid) && lidSafeApplicationArguments(pid) ? 0 : 1) } }\n')
    const checker = join(scratch, 'check-live')
    run('/usr/bin/swiftc', ['-module-cache-path', join(scratch, 'cache'), join(source, 'LidCodeIdentity.swift'), probe, '-o', checker])
    expect(spawnSync(checker, ['--acl', archive]).status).toBe(0)
    run('/bin/chmod', ['+a', `user:${process.env.USER} allow write`, archive])
    expect(spawnSync(checker, ['--acl', archive]).status).toBe(1)
    run('/bin/chmod', ['-N', archive])
    expect(spawnSync(checker, ['--acl', archive]).status).toBe(0)
    expect(spawnSync(checker, ['--acl', join(scratch, 'missing')]).status).toBe(1)
    child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => { child!.stdout!.once('data', () => resolve()); child!.once('error', reject) })
    expect(spawnSync(checker, [String(child.pid)], { timeout: 5000 }).status).toBe(0)
    child.kill(); await new Promise(resolve => child!.once('exit', resolve)); child = undefined
    child = spawn(executable, ['--remote-debugging-port=18998'], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => { child!.stdout!.once('data', () => resolve()); child!.once('error', reject) })
    expect(spawnSync(checker, [String(child.pid)], { timeout: 5000 }).status).toBe(1)
    child.kill(); await new Promise(resolve => child!.once('exit', resolve)); child = undefined
    sign(bundle)
    child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => { child!.stdout!.once('data', () => resolve()); child!.once('error', reject) })
    expect(spawnSync(checker, [String(child.pid)], { timeout: 5000 }).status).toBe(1)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child!.once('exit', resolve)) }
    rmSync(scratch, { recursive: true, force: true })
  }
}, 90_000)
