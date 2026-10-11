import { constants, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inventory, dependencyHash, prepare } from './prepare.js'
import { sha } from './policy.js'
import { subscriptionPolicy } from './subscription.js'

if (process.env.CAT_CODE_EVAL_FIXTURE === 'queue-resume') {
  const out = resolve(process.argv[2]!)
  await prepare(out)
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  manifest.subscription = subscriptionPolicy
  manifest.schedule = subscriptionPolicy.schedule
  manifest.preparation = { authorization: subscriptionPolicy.authorization, fixture: 'queue-resume', source: 'Pinned repair with new public queue inputs and hidden independent oracle; no live model warm-up.' }
  const frozen = JSON.stringify(manifest, null, 2)
  writeFileSync(join(out, 'manifest.json'), frozen, { mode: 0o600 })
  writeFileSync(join(out, 'manifest.sha256'), sha(frozen) + '\n')
  console.log(JSON.stringify({ out, manifestSha256: sha(frozen) }))
  process.exit(0)
}

const proposal = JSON.parse(readFileSync(resolve(import.meta.dir, '../task-restore-manifest.v2.json'), 'utf8'))
const source = proposal.frozenSource.localPath, out = resolve(process.argv[2]!)
if (existsSync(out)) throw Error('New output directory required; no overwrite')
const raw = readFileSync(join(source, 'manifest.json'), 'utf8'), manifest = JSON.parse(raw)
if (sha(raw) !== proposal.frozenSource.manifestSha256 || JSON.stringify(inventory(join(source, 'engine'))) !== JSON.stringify(manifest.engineInventory)) throw Error('Original frozen source drift')
if (dependencyHash(join(source, 'engine/node_modules')) !== manifest.runtime.dependencyTreeSha256) throw Error('Original dependency drift')
mkdirSync(out, { mode: 0o700 })
cpSync(join(source, 'engine'), join(out, 'engine'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
cpSync(join(source, 'seeds'), join(out, 'seeds'), { recursive: true })
cpSync(import.meta.dir, join(out, 'engine/scripts/harness-design-eval/task-restore'), { recursive: true })
for (const relative of Object.keys(inventory(join(out, 'seeds')))) {
  const file = join(out, 'seeds', relative)
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll(source, out), { mode: 0o600 })
}
for (const id of Object.keys(manifest.inputs)) {
  const seed = join(out, 'seeds', id)
  const projects = join(seed, 'home/.cat-code/projects')
  const oldProject = join(source, 'seeds', id, 'workspace').replace(/[^a-zA-Z0-9]/g, '-')
  const newProject = join(seed, 'workspace').replace(/[^a-zA-Z0-9]/g, '-')
  if (existsSync(join(projects, oldProject))) renameSync(join(projects, oldProject), join(projects, newProject))
  manifest.inputs[id].workspace = inventory(join(seed, 'workspace'))
  manifest.inputs[id].home = inventory(join(seed, 'home'))
  manifest.inputs[id].seed = JSON.parse(readFileSync(join(seed, 'seed.json'), 'utf8'))
}
manifest.engineInventory = inventory(join(out, 'engine'))
manifest.subscription = subscriptionPolicy
manifest.subscriptionProvenance = { originalManifestSha256: sha(raw), originalRoot: source,
  changes: 'Evaluator transport/auth, live admission and response accounting only. Prepared fixtures rebased identically; grader and production repair unchanged.',
  supportInventory: inventory(import.meta.dir) }
const frozen = JSON.stringify(manifest, null, 2)
writeFileSync(join(out, 'manifest.json'), frozen, { mode: 0o600 })
writeFileSync(join(out, 'manifest.sha256'), sha(frozen) + '\n')
console.log(JSON.stringify({ out, manifestSha256: sha(frozen), graderSha256: sha(readFileSync(join(out, 'engine/scripts/harness-design-eval/task-restore/grade.ts'))) }))
