import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { REBRAND_RECIPE } from './prepare-dev-electron.js'

const outcomes = ['prepare-failure', 'no-launch', 'running-timeout', 'start-failure', 'reused-success', 'forged-exit'] as const
const cases = ['visual-acceptance', 'run-hardening-smoke'].flatMap(runner => outcomes.map(outcome => ({ runner, outcome })))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test.each(cases)('$runner native lifecycle on $outcome ignores stale output and preserves unconfirmed ownership', async ({ runner, outcome }) => {
  const root = mkdtempSync(join(tmpdir(), 'native-runner-test-'))
  const scripts = join(root, 'scripts'), temp = join(root, 'tmp'), output = join(root, 'captures'), bin = join(root, 'bin')
  for (const dir of [scripts, temp, output, bin, join(root, 'node_modules', '.bin'), join(root, 'node_modules', 'electron', 'dist', 'Electron.app'), join(root, '.dev-electron', 'Cat Code Dev.app')]) mkdirSync(dir, { recursive: true })
  for (const file of [`${runner}.ts`, 'devLauncher.ts', 'prepare-dev-electron.ts', 'visualAcceptanceFixture.ts', 'nativeCaptureLifetime.ts']) copyFileSync(new URL(`./${file}`, import.meta.url), join(scripts, file))
  writeFileSync(join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '0.0.0' }))
  writeFileSync(join(root, '.dev-electron', '.electron-version'), `0.0.0 r${REBRAND_RECIPE}`)
  writeFileSync(join(root, 'node_modules', '.bin', 'electron'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  writeFileSync(join(scripts, 'visual-acceptance-driver.ts'), 'export {}\n')
  writeFileSync(join(scripts, 'hardening-smoke.ts'), 'export {}\n')
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\n[ "$RUNNER_OUTCOME" != prepare-failure ] || exit 23\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'bunx'), `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.RUNNER_FIXTURE+'/vite.pid',String(process.pid));
writeFileSync(process.env.RUNNER_FIXTURE+'/vite.ready','');
process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
`, { mode: 0o755 })
  writeFileSync(join(root, 'preload.ts'), `import {existsSync} from 'node:fs';globalThis.fetch=async()=>{if(!existsSync(process.env.RUNNER_FIXTURE+'/vite.ready'))throw new Error('pending');return new Response('ready')};`)
  const stale = { 'result.json': '{"ok":true}', 'exited.json': '{"code":0}', 'electron.log': 'STALE SUCCESS\n[hardening-smoke] renderer document + main-process policy passed\n' }
  for (const [name, text] of Object.entries(stale)) writeFileSync(join(output, name), text)
  const child = Bun.spawn({ cmd: [process.execPath, '--preload', join(root, 'preload.ts'), join(scripts, `${runner}.ts`), '--prepare-native'], cwd: root, env: { PATH: bin, TMPDIR: temp, RUNNER_FIXTURE: root, RUNNER_OUTCOME: outcome, CATCODE_CAPTURE_OUT: output, CATCODE_HARDENING_OUT: output, CATCODE_NATIVE_TIMEOUT_MS: '800', ...(runner === 'visual-acceptance' ? { CATCODE_CAPTURE_SCENE: 'usage' } : {}) }, stdout: 'pipe', stderr: 'pipe' })
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
  let native: ReturnType<typeof Bun.spawn> | null = null
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 6000)
  try {
    if (outcome === 'prepare-failure') {
      expect(await child.exited).toBe(23)
      expect(await stdout + await stderr).toContain('build failed')
      expect(readdirSync(temp)).toEqual([])
      expect(readdirSync(output).sort()).toEqual(Object.keys(stale).sort())
      return
    }
    let manifest: any
    const deadline = Date.now() + 4000
    while (!manifest && Date.now() < deadline) {
      for (const dir of readdirSync(output).filter(name => name.startsWith('run-'))) {
        const path = join(output, dir, 'native-launch.json')
        if (existsSync(path)) manifest = JSON.parse(readFileSync(path, 'utf8'))
      }
      if (!manifest) await sleep(10)
    }
    expect(manifest).toBeDefined()
    expect(manifest.outDir).not.toBe(output)
    if (runner === 'visual-acceptance') expect(readFileSync(join(manifest.outDir, 'native-bootstrap.cjs'), 'utf8')).toContain('"CATCODE_CAPTURE_SCENE":"usage"')
    expect(existsSync(join(manifest.outDir, 'exited.json'))).toBe(false)
    expect(child.exitCode).toBe(null)
    if (outcome !== 'no-launch') {
      native = Bun.spawn({ cmd: [process.execPath, '-e', `
const fs=require('node:fs'),m=JSON.parse(process.argv[1]),outcome=process.argv[2];
const write=(name,value)=>{const path=m.outDir+'/'+name;fs.writeFileSync(path+'.tmp',JSON.stringify(value));fs.renameSync(path+'.tmp',path)};
write('started.json',{runId:m.runId,pid:process.pid});
if(outcome==='running-timeout')setInterval(()=>{},1000);
else if(outcome==='forged-exit'){write('exited.json',{runId:m.runId,pid:process.pid+1,code:0});setInterval(()=>{},1000)}
else{fs.writeFileSync(m.outDir+'/electron.log',outcome==='reused-success'?'[hardening-smoke] renderer document + main-process policy passed\\n':'new startup failure');
if(outcome==='reused-success')write('result.json',{ok:true});
write('exited.json',{runId:m.runId,pid:process.pid,code:outcome==='reused-success'?0:7});}
`, JSON.stringify(manifest), outcome], stdout: 'ignore', stderr: 'pipe' })
    }
    const status = await child.exited
    const log = await stdout + await stderr
    expect(status).toBe(outcome === 'reused-success' ? 0 : 1)
    for (const [name, text] of Object.entries(stale)) expect(readFileSync(join(output, name), 'utf8')).toBe(text)
    const preserved = ['no-launch', 'running-timeout', 'forged-exit'].includes(outcome)
    expect(existsSync(manifest.configHome)).toBe(preserved)
    expect(existsSync(join(manifest.outDir, 'cleanup-required.json'))).toBe(preserved)
    if (preserved) {
      expect(log).toContain('Cleanup required')
      expect(log).toContain('preserved')
      expect(JSON.parse(readFileSync(join(manifest.outDir, 'cancelled.json'), 'utf8')).runId).toBe(manifest.runId)
      if (native) { expect(native.exitCode).toBe(null); expect(() => process.kill(native!.pid, 0)).not.toThrow() }
      if (runner === 'visual-acceptance') expect(() => process.kill(Number(readFileSync(join(root, 'vite.pid'), 'utf8')), 0)).not.toThrow()
    } else {
      expect(log).not.toContain('Cleanup required')
      expect(readFileSync(join(manifest.outDir, 'electron.log'), 'utf8')).not.toContain('STALE SUCCESS')
      if (runner === 'visual-acceptance') expect(() => process.kill(Number(readFileSync(join(root, 'vite.pid'), 'utf8')), 0)).toThrow()
    }
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill('SIGKILL')
    if (native && native.exitCode === null) { native.kill('SIGKILL'); await native.exited }
    const vite = join(root, 'vite.pid')
    if (existsSync(vite)) {
      const pid = Number(readFileSync(vite, 'utf8'))
      const command = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
      if (command.status === 0 && command.stdout.includes(join(bin, 'bunx'))) {
        try { process.kill(pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        const deadline = Date.now() + 1000
        while (true) {
          try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error }
          if (Date.now() > deadline) throw new Error(`Owned fixture Vite did not stop; state preserved at ${root}`)
          await sleep(10)
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 8000)
