import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const installer = new URL('./install-local-app.sh', import.meta.url).pathname
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cat-install-test-'))
  roots.push(root)
  const applications = join(root, 'Applications')
  const installed = join(applications, 'Cat Code.app')
  const backups = join(root, 'Backups.noindex')
  const source = join(root, 'build', 'Cat Code.app')
  mkdirSync(applications)
  mkdirSync(backups)
  return { root, applications, installed, backups, source }
}

function bundle(path: string, commit: string, id = 'com.catcode.desktop') {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(path, 'commit'), commit)
  writeFileSync(join(path, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`)
}

// Only native signature/process/Launch Services boundaries are substituted.
// Copying, promotion, rollback, locking, and backup retirement use real files.
const nativeBoundaries = `
verify_bundle() {
  printf 'verify %s\n' "$1" >> "$LOG"
  [[ $(cat "$1/commit") == "$2" ]] || return 1
  [[ ! -f "$1/fail-installed" || "$1" != "$INSTALLED" ]]
}
check_closed() { [[ ! -f "$1/running" ]]; }
unregister_bundle() { printf 'unregister %s\n' "$1" >> "$LOG"; }
register_bundle() {
  printf 'register %s\n' "$1" >> "$LOG"
  [[ ! -f "$1/fail-registration" ]]
}
`

function install(f: ReturnType<typeof fixture>, commit: string, extraShell = '') {
  return spawnSync('bash', ['-c', `source "$SCRIPT"\n${nativeBoundaries}\n${extraShell}\ninstall_bundle "$SOURCE" "$INSTALLED" "$BACKUPS" "$COMMIT"`], {
    encoding: 'utf8',
    env: { ...process.env, SCRIPT: installer, SOURCE: f.source, INSTALLED: f.installed,
      BACKUPS: f.backups, COMMIT: commit, LOG: join(f.root, 'native.log') },
  })
}

function commitAt(path: string) { return readFileSync(join(path, 'commit'), 'utf8') }
function retained(f: ReturnType<typeof fixture>) { return readdirSync(f.backups).filter(n => n.endsWith('.app')) }
function expectCleanApplications(f: ReturnType<typeof fixture>) {
  expect(readdirSync(f.applications).filter(n => n.endsWith('.app'))).toEqual(['Cat Code.app'])
  expect(readdirSync(join(f.applications, '.cat-code-install.noindex'))).toEqual([])
}

test('repeated updates leave one visible app and only the immediately previous build in backups', () => {
  const f = fixture()
  bundle(f.source, 'first')
  let result = install(f, 'first')
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(retained(f)).toEqual([])
  for (const commit of ['second', 'third']) {
    writeFileSync(join(f.source, 'commit'), commit)
    result = install(f, commit)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expectCleanApplications(f)
    expect(commitAt(f.installed)).toBe(commit)
  }
  const backups = retained(f)
  expect(backups).toHaveLength(1)
  expect(commitAt(join(f.backups, backups[0]!))).toBe('second')
  const log = readFileSync(join(f.root, 'native.log'), 'utf8')
  expect(log.trim().split("\n").at(-1)).toBe(`register ${f.installed}`)
  // Every staged verification used the non-indexed area, never a visible sibling.
  expect(log.split('\n').filter(l => l.startsWith('verify ') && l.includes('transaction.'))
    .every(l => l.includes('/.cat-code-install.noindex/'))).toBe(true)
})

for (const failure of ['fail-installed', 'fail-registration', 'promotion'] as const) {
  test(`${failure} restores the previous installed app and preserves the existing recovery build`, () => {
    const f = fixture()
    bundle(f.installed, 'previous')
    bundle(join(f.backups, 'Cat Code.rollback-older.app'), 'older')
    bundle(f.source, 'new')
    if (failure !== 'promotion') writeFileSync(join(f.source, failure), '')
    const result = install(f, 'new', failure === 'promotion' ? `
mv() {
  if [[ "$1" == */transaction.*/"Cat Code.app" && "$2" == "$INSTALLED" ]]; then return 1; fi
  /bin/mv "$@"
}` : '')
    expect(result.status).not.toBe(0)
    expect(commitAt(f.installed)).toBe('previous')
    expect(retained(f)).toEqual(['Cat Code.rollback-older.app'])
    expectCleanApplications(f)
    expect(readFileSync(join(f.root, 'native.log'), 'utf8')).toContain(`register ${f.installed}\n`)
  })
}

test('a running app or an active installer is never replaced', () => {
  const f = fixture()
  bundle(f.installed, 'previous')
  bundle(f.source, 'new')
  writeFileSync(join(f.installed, 'running'), '')
  expect(install(f, 'new').status).not.toBe(0)
  expect(commitAt(f.installed)).toBe('previous')
  expect(retained(f)).toEqual([])
  mkdirSync(join(f.applications, '.cat-code-install.noindex', 'lock'))
  expect(install(f, 'new').status).not.toBe(0)
  expect(commitAt(f.installed)).toBe('previous')
})

test('an invalid source leaves the installed app and existing backup untouched', () => {
  const f = fixture()
  bundle(f.installed, 'previous')
  bundle(f.source, 'wrong-build')
  bundle(join(f.backups, 'Cat Code.rollback-older.app'), 'older')
  expect(install(f, 'expected-build').status).not.toBe(0)
  expect(commitAt(f.installed)).toBe('previous')
  expect(retained(f)).toEqual(['Cat Code.rollback-older.app'])
  expectCleanApplications(f)
})

test('failed restoration retains recovery artifacts and the lock for inspection', () => {
  const f = fixture()
  bundle(f.installed, 'previous')
  bundle(f.source, 'new')
  writeFileSync(join(f.source, 'fail-installed'), '')
  const result = install(f, 'new', `
mv() {
  if [[ "$1" == */previous.app && "$2" == "$INSTALLED" ]]; then return 1; fi
  /bin/mv "$@"
}`)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Recovery incomplete')
  const area = join(f.applications, '.cat-code-install.noindex')
  expect(readdirSync(area)).toContain('lock')
  const transaction = readdirSync(area).find(n => n.startsWith('transaction.'))!
  expect(commitAt(join(area, transaction, 'previous.app'))).toBe('previous')
  expect(commitAt(join(area, transaction, 'failed.app'))).toBe('new')
})

test('retirement preserves unrelated backups and refuses to delete a running recovery app', () => {
  const f = fixture()
  bundle(f.installed, 'previous')
  bundle(f.source, 'new')
  const unrelated = join(f.backups, 'Cat Code.rollback-unrelated.app')
  bundle(unrelated, 'unrelated', 'org.example.other')
  const running = join(f.backups, 'Cat Code.rollback-running.app')
  bundle(running, 'running')
  writeFileSync(join(running, 'running'), '')
  expect(install(f, 'new').status).not.toBe(0)
  expect(commitAt(f.installed)).toBe('new')
  expect(commitAt(unrelated)).toBe('unrelated')
  expect(commitAt(running)).toBe('running')
})

test('an extra production app prevents a clean-install report while a Dev app is preserved', () => {
  const f = fixture()
  bundle(f.source, 'new')
  const dev = join(f.applications, 'Cat Code Dev.app')
  bundle(dev, 'dev', 'com.catcode.desktop.dev')
  expect(install(f, 'new').status).toBe(0)
  const extra = join(f.applications, 'Cat Code.rollback-legacy.app')
  bundle(extra, 'legacy')
  const result = install(f, 'new')
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Extra Cat Code app remains')
  expect(commitAt(extra)).toBe('legacy')
  expect(commitAt(dev)).toBe('dev')
})
