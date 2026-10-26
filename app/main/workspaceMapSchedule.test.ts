import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { supportsWorkspaceMapSchedule, workspaceMapSchedule } from './workspaceMapSchedule.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test('workspace-map eligibility requires a helper file and creation rechecks it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-map-eligibility-')); dirs.push(dir)
  const helper = join(dir, 'scripts/workspaceMapRefreshState.ts')
  expect(supportsWorkspaceMapSchedule(dir)).toBe(false)
  expect(() => workspaceMapSchedule(dir, join(dir, 'state'))).toThrow('does not contain')
  mkdirSync(helper, { recursive: true })
  expect(supportsWorkspaceMapSchedule(dir)).toBe(false)
  rmSync(helper, { recursive: true })
  writeFileSync(helper, '')
  expect(supportsWorkspaceMapSchedule(dir)).toBe(true)
  rmSync(helper)
  expect(() => workspaceMapSchedule(dir, join(dir, 'state'))).toThrow('does not contain')
})

// Builtin redirection stays in a child: other suites keep the real filesystem/home modules.
for (const scenario of ['partial-copy', 'shell-path']) test(`workspace-map preset preserves native state identity (${scenario})`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-map-preset-')); dirs.push(dir)
  mkdirSync(join(dir, 'home'), { recursive: true })
  const loader = join(dir, 'loader.mjs')
  writeFileSync(loader, `export async function load(url, context, nextLoad) {
    if (url === 'node:os') return { format:'module', shortCircuit:true, source:'export function homedir() { return ' + JSON.stringify(process.env.CATCODE_PRESET_TEST_ROOT + '/home') + ' }' };
    if (url === 'node:fs') return { format:'module', shortCircuit:true, source:\`
      import { createRequire } from 'node:module'; const fs = createRequire(process.env.CATCODE_PRESET_TEST_ROOT + '/probe.mjs')('node:fs');
      export const existsSync=fs.existsSync, statSync=fs.statSync, mkdirSync=fs.mkdirSync, readFileSync=fs.readFileSync,
        closeSync=fs.closeSync, fsyncSync=fs.fsyncSync, linkSync=fs.linkSync, unlinkSync=fs.unlinkSync;
      const opened = new Map();
      export function openSync(path,...args) { const fd=fs.openSync(path,...args); opened.set(fd,path); return fd; }
      export function writeFileSync(target,data,...args) {
        const path = typeof target === 'number' ? opened.get(target) : target;
        if (process.env.CATCODE_PRESET_FAIL_WRITE === '1' && path.startsWith(process.env.CATCODE_PRESET_TEST_ROOT + '/native')) {
          fs.writeFileSync(target,'{',...args); throw new Error('injected partial ENOSPC');
        }
        return fs.writeFileSync(target,data,...args);
      }\` };
    return nextLoad(url,context);
  }`)
  const probe = join(dir, 'probe.mjs')
  writeFileSync(probe, `import {createRequire} from 'node:module'; import {join} from 'node:path';
    import {createHash} from 'node:crypto'; import {spawnSync} from 'node:child_process'; import assert from 'node:assert/strict';
    import {workspaceMapSchedule} from ${JSON.stringify(new URL('./workspaceMapSchedule.ts', import.meta.url).href)};
    const fs=createRequire(import.meta.url)('node:fs'), root=process.env.CATCODE_PRESET_TEST_ROOT;
    const project=join(root,'project'), storage=join(root,"native $CATCODE_QUOTE ' literal");
    fs.mkdirSync(join(project,'scripts'),{recursive:true}); fs.writeFileSync(join(project,'scripts/workspaceMapRefreshState.ts'),'');
    const stateDir=join(storage,'workspace-map-refresh',createHash('sha256').update(project).digest('hex').slice(0,16));
    const legacy=join(root,'home/.codex/automations/refresh-workspace-routing-map/state.json');
    const raw=JSON.stringify({schemaVersion:2,repositoryRoot:project,cursor:null,run:null})+'\\n';
    fs.mkdirSync(join(legacy,'..'),{recursive:true}); fs.writeFileSync(legacy,raw);
    if (process.env.CATCODE_PRESET_SCENARIO === 'partial-copy') {
      process.env.CATCODE_PRESET_FAIL_WRITE='1'; assert.throws(()=>workspaceMapSchedule(project,storage),/partial ENOSPC/);
      assert.equal(fs.existsSync(join(stateDir,'state.json')),false); assert.equal(fs.readFileSync(legacy,'utf8'),raw);
      process.env.CATCODE_PRESET_FAIL_WRITE='0'; workspaceMapSchedule(project,storage);
      assert.equal(fs.readFileSync(join(stateDir,'state.json'),'utf8'),raw);
      fs.writeFileSync(join(stateDir,'state.json'),'{'); assert.throws(()=>workspaceMapSchedule(project,storage),/state could not be read/);
      assert.equal(fs.readFileSync(join(stateDir,'state.json'),'utf8'),'{');
    } else {
      const task=workspaceMapSchedule(project,storage), argument=task.prompt.match(/Every helper command must use --state-dir (.+)\\. Do not hand-edit/)[1];
      const argv=join(root,'argv.mjs'); fs.writeFileSync(argv,'console.log(JSON.stringify(process.argv.slice(2)))');
      const shell=spawnSync('zsh',['-c','node '+JSON.stringify(argv)+' --state-dir '+argument],{env:{...process.env,CATCODE_QUOTE:'expanded'},encoding:'utf8'});
      assert.equal(shell.status,0); assert.deepEqual(JSON.parse(shell.stdout),['--state-dir',stateDir]);
    }
    console.log('verified');`)
  const child = Bun.spawnSync(['node', '--no-warnings', '--experimental-loader', loader, probe], {
    env: { ...process.env, CATCODE_PRESET_TEST_ROOT: dir, CATCODE_PRESET_SCENARIO: scenario },
  })
  expect({ code: child.exitCode, error: child.stderr.toString() }).toEqual({ code: 0, error: '' })
  expect(child.stdout.toString().trim()).toBe('verified')
})
