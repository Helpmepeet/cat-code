import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const source = import.meta.dir + '/..'
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cat-code-model-replacement-')))
const catalogPath = 'src/utils/model/configs.ts'

try {
  const files = execFileSync('git', [
    '-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'app/shared', 'app/sidecar', 'app/host',
    'package.json', 'tsconfig.json', 'env.d.ts',
  ], { cwd: source, maxBuffer: 8 * 1024 * 1024 }).toString().split('\0').filter(Boolean)
  files.push('scripts/model-replacement.fixture.ts')
  for (const file of new Set(files)) {
    if (!existsSync(join(source, file))) continue
    const target = join(fixture, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(source, file), target)
  }
  for (const path of ['node_modules', 'app/node_modules']) {
    symlinkSync(join(source, path), join(fixture, path), 'dir')
  }

  const catalog = join(fixture, catalogPath)
  const original = readFileSync(catalog, 'utf8')
  const activeSol = '  sol: [\n'
  if (original.split(activeSol).length !== 2) {
    throw new Error('Cannot locate the Sol family in the catalog')
  }
  writeFileSync(catalog, original.replace(activeSol, activeSol + `    {
      ...codex6,
      id: 'gpt-catalog-fixture-sol',
      wireId: 'Catalog-Fixture.Responses',
      label: 'Catalog Fixture Sol',
      pickerDescription: 'Synthetic catalog verification',
      agentDescription: 'Synthetic catalog verification',
      adapterDescription: 'Synthetic catalog verification',
      context: codexWindow(618_000),
      efforts: ['low', 'medium'],
      defaultEffort: 'low',
      minimalOnWire: 'none',
    },
    {
      id: 'gpt-catalog-prior-sol', wireId: 'Catalog-Prior.Responses',
      label: 'Catalog Prior Sol', promptFamily: 'gpt-6', usage: 'retired',
    },
`))
  console.log(`Synthetic replacement edits only ${catalogPath}`)
  const home = join(fixture, '.home')
  mkdirSync(home)
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'config'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  function run(name: string, args: string[]): boolean {
    const child = Bun.spawnSync([process.execPath, ...args], {
      cwd: fixture, env: { ...env, CLAUDE_CONFIG_DIR: join(home, name) },
      stdout: 'inherit', stderr: 'inherit',
    })
    return child.exitCode === 0
  }

  const snapshotsDir = join(fixture, 'src/constants/__prompt_snapshots__')
  const snapshotContents = () => Object.fromEntries(
    readdirSync(snapshotsDir).map(file => [file, readFileSync(join(snapshotsDir, file), 'utf8')]),
  )
  const before = JSON.stringify(snapshotContents())
  const codex = run('codex', ['scripts/model-replacement.fixture.ts', 'codex'])
  const unchangedSuites = [
    'test', '--isolate', 'src/constants/promptAssembly.snapshot.test.ts',
    'src/commands/switch-account/switch-account.test.ts', 'app/host/peerNames.test.ts',
    'src/utils/model/modelOverridePrecedence.test.ts', 'src/utils/model/modelOptions.test.ts',
    'src/utils/model/smallFastModel.test.ts', 'src/utils/model/agent.test.ts',
    'app/sidecar/usageSummary.test.ts',
  ]
  const codexTests = run('codex-tests', unchangedSuites)

  const cloudSonnet = /sonnet: \{ current: '[^']+', cloud: '([^']+)' \}/
  if (!cloudSonnet.test(original)) throw new Error('Cannot locate the Claude Sonnet default')
  writeFileSync(catalog, original.replace(
    'const CLAUDE_RELEASES = {',
    `const CLAUDE_RELEASES = {
  sonnetFixture: {
    ...frontier, family: 'sonnet', label: 'Catalog Fixture Sonnet',
    wire: {
      firstParty: 'claude-catalog-sonnet', bedrock: 'anthropic.claude-sonnet-9-9-fixture-v1',
      vertex: 'claude-sonnet-9-9@fixture', foundry: 'claude-sonnet-9-9',
      openai: 'claude-catalog-sonnet',
    },
    effort: 'xhigh', requiredAdaptiveThinking: true, priceAs: 'claude-sonnet-5-5',
  },`,
  ).replace(cloudSonnet, "sonnet: { current: 'sonnetFixture', cloud: '$1' }"))
  console.log(`Claude replacement edits only ${catalogPath}`)
  const claude = run('claude', ['scripts/model-replacement.fixture.ts', 'claude'])
  const claudeTests = run('claude-tests', unchangedSuites)
  const startup = run('startup', ['scripts/model-replacement.fixture.ts', 'startup'])

  writeFileSync(catalog, original.replace('  terra: [\n', `  terra: [
    {
      ...codex6, id: 'gpt-catalog-fixture-terra', priceAs: terra61Id,
      label: 'Catalog Fixture Terra', pickerDescription: 'Synthetic pricing verification',
      agentDescription: 'Synthetic pricing verification', adapterDescription: 'Synthetic pricing verification',
      context: codexWindow(1_050_000), efforts: codexMax,
    },
`))
  const terra = run('terra', ['scripts/model-replacement.fixture.ts', 'terra'])

  writeFileSync(catalog, original.replace('  luna: [\n', `  luna: [
    {
      ...codex6, id: 'gpt-catalog-fixture-luna', label: 'Catalog Fixture Luna',
      pickerDescription: 'Synthetic reviewer verification', agentDescription: 'Synthetic reviewer verification',
      adapterDescription: 'Synthetic reviewer verification', context: codexWindow(1_050_000),
      efforts: codexMax, defaultEffort: 'low', minimalOnWire: 'none', maxOnWire: 'max',
    },
`))
  const reviewer = run('reviewer', [
    '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
    'scripts/model-replacement.fixture.ts', 'reviewer',
  ])

  if (before !== JSON.stringify(snapshotContents())) throw new Error('Prompt snapshots changed during verification')
  console.log('Replacement proof used unchanged tests and prompt snapshots')
  process.exitCode = codex && codexTests && claude && claudeTests && startup && terra && reviewer ? 0 : 1
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
