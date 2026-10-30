/** Offline content for native file-pane acceptance. No renderer injection or model calls. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseAccountsPoolWorkerResult } from '../shared/accountsPoolWorker.js'
import { createTranscriptCache, readCache, transcriptCacheDir, writeCache } from '../main/transcriptCache.js'
import { REGISTRY_VERSION, type RegistryDocument } from '../host/registry.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows } from '../renderer/src/transcriptProjector.js'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const localhostLinksArgument = process.argv.indexOf('--localhost-links')
const localhostLinks = localhostLinksArgument < 0 ? [] : JSON.parse(readFileSync(process.argv[localhostLinksArgument + 1]!, 'utf8')) as Array<{ label: string; url: string }>
const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'catcode-file-pane-gui-')))
const cwd = join(runRoot, 'workspace')
const configDir = join(runRoot, 'config')
const profile = join(runRoot, 'electron-profile')
const fixtureHome = join(runRoot, 'fixture-home')
const registryDir = join(configDir, 'desktop')
for (const directory of [cwd, configDir, profile, fixtureHome, registryDir, join(cwd, 'assets'), join(configDir, 'generated-images')]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>File pane fixture</title><link rel="stylesheet" href="assets/page.css"><script defer src="assets/page.js"></script><script type="module" src="assets/module.js"></script></head><body><main><h1>File pane fixture</h1><p id="script-result">Script has not run</p><p id="module-result">Module and local JSON fetch pending</p><p><button id="counter">Count: 0</button> <input aria-label="Page input" placeholder="Click here for page keys"></p><p><a href="second.html">Second local page</a> · <a href="#section-20">Jump to section 20</a> · <a href="https://example.com">Outside site</a></p><p><img src="assets/cat.png" width="96" alt="Relative image"></p>${Array.from({ length: 30 }, (_, i) => `<section id="section-${i + 1}"><h2>Section ${i + 1}</h2><p>Scroll restoration sample ${i + 1}. This content remains fixed while switching panels and sessions.</p></section>`).join('')}</main></body></html>`
writeFileSync(join(cwd, 'report.html'), html)
writeFileSync(join(cwd, 'CAPS.HTM'), html.replace('File pane fixture</h1>', 'Case insensitive HTML</h1>'))
writeFileSync(join(cwd, 'assets', 'page.css'), 'body{margin:0;background:#fff;color:#222;font:15px/1.6 system-ui}main{max-width:760px;margin:auto;padding:32px}section{padding:28px 0;border-bottom:1px solid #ddd}button,input{font:inherit}img{display:block}')
writeFileSync(join(cwd, 'assets', 'module.js'), "const data=await fetch(new URL('module-data.json',import.meta.url)).then(response=>{if(!response.ok)throw new Error('JSON load failed');return response.json()});document.querySelector('#module-result').textContent=data.message")
writeFileSync(join(cwd, 'assets', 'module-data.json'), JSON.stringify({ message: 'Relative module and local JSON fetch loaded' }))
writeFileSync(join(cwd, 'assets', 'page.js'), "document.querySelector('#script-result').textContent = 'Relative script loaded';let count=0;document.querySelector('#counter').onclick=event=>event.target.textContent='Count: '+(++count)")
writeFileSync(join(cwd, 'second.html'), '<!doctype html><h1>Second local page</h1><p><a href="report.html">Return to report</a></p><div style="height:1800px">Long second page</div>')
writeFileSync(join(cwd, 'wide.html'), '<!doctype html><style>body{margin:0;background:white;color:#222;font:15px system-ui}main{width:1600px;height:1200px;padding:32px;box-sizing:border-box;background:linear-gradient(90deg,#eef,#fee)}</style><main><h1>Wide file: horizontal scrolling</h1><p style="margin-left:1200px">Right edge marker</p></main>')
writeFileSync(join(cwd, 'notes.md'), '# File pane notes\n\nMarkdown uses the same prose as replies.\n\n[Open report](report.html) · [Second page](second.html) · [Outside link](https://example.com)\n\n![Relative image](assets/cat.png)\n\n' + Array.from({ length: 25 }, (_, i) => `## Section ${i + 1}\n\nMarkdown scroll sample ${i + 1}.\n\n`).join(''))
writeFileSync(join(cwd, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#fff"/><rect x="80" y="80" width="640" height="440" rx="32" fill="#b8d8ff"/><text id="label" x="160" y="310" font-size="32">SVG script pending</text><script>document.getElementById("label").textContent="SVG script ran";</script></svg>')
copyFileSync(join(appRoot, 'renderer', 'src', 'assets', 'welcome-cat-coding.png'), join(cwd, 'assets', 'cat.png'))
copyFileSync(join(cwd, 'assets', 'cat.png'), join(configDir, 'generated-images', 'generated.png'))
writeFileSync(join(cwd, 'isolation.html'), `<!doctype html><html><meta charset="utf-8"><title>Preview isolation checks</title><style>body{margin:24px;background:white;color:#222;font:15px/1.7 system-ui}li{margin:8px 0}button{font:inherit;margin:8px 12px 8px 0}</style><h1>Preview isolation checks</h1><ul id="results"></ul><button id="top-navigation">Attempt top navigation</button><button id="app-origin">Attempt app origin navigation</button><p id="attempt">No navigation requested</p><script>
const list=document.querySelector('#results');const report=(name,pass)=>{const item=document.createElement('li');item.textContent=(pass?'PASS: ':'FAIL: ')+name;list.append(item)};
report('Script runs',true);report('No preload bridge',typeof window.catcode==='undefined');report('No Node require',typeof window.require==='undefined');report('No Node process',typeof window.process==='undefined');
let parentBlocked=false;try{void parent.document.body}catch{parentBlocked=true}report('Parent document blocked',parentBlocked);
let bridgeBlocked=false;try{bridgeBlocked=typeof parent.catcode==='undefined'}catch{bridgeBlocked=true}report('Parent preload bridge blocked',bridgeBlocked);
let popup=null;try{popup=window.open('about:blank')}catch{}report('Popup blocked',popup===null);if(popup)popup.close();
document.querySelector('#top-navigation').onclick=()=>{try{top.location.href='http://localhost:5189';document.querySelector('#attempt').textContent='Top navigation requested; the app must remain visible'}catch{document.querySelector('#attempt').textContent='Top navigation blocked'}};
document.querySelector('#app-origin').onclick=()=>{document.querySelector('#attempt').textContent='App origin navigation requested; this file must remain visible';location.href='http://localhost:5189'};
</script></html>`)
writeFileSync(join(cwd, 'broken.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>')
writeFileSync(join(cwd, 'corrupt.png'), Buffer.alloc(0))
writeFileSync(join(cwd, 'source.ts'), 'export const notPreviewable = true\n')
writeFileSync(join(runRoot, 'outside.html'), '<h1>Outside workspace: must refuse</h1>')
symlinkSync(join(runRoot, 'outside.html'), join(cwd, 'escape.html'))
writeFileSync(join(configDir, '.config.json'), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [], mcpContextUris: [], mcpServers: {} } }, hasCompletedOnboarding: true }))

const ids = [randomUUID(), randomUUID()]
const engineIds = [randomUUID(), randomUUID()]
let sequence = 0
function message(appSessionId: string, engineSessionId: string, role: 'assistant' | 'user', content: unknown, parent: string | null = null, extra: Record<string, unknown> = {}): ServerFrame {
  sequence++
  return {
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId,
    event: { type: 'message', message: {
      type: role, session_id: engineSessionId, parent_tool_use_id: parent,
      uuid: randomUUID(), timestamp: new Date(Date.now() + sequence).toISOString(),
      message: { id: `fixture-message-${sequence}`, role, content }, ...extra,
    } },
  } as unknown as ServerFrame
}
function fixtureFrames(appSessionId: string, engineSessionId: string, second: boolean): ServerFrame[] {
  const frames: ServerFrame[] = []
  const text = (value: string, parent: string | null = null) => frames.push(message(appSessionId, engineSessionId, 'assistant', [{ type: 'text', text: value }], parent))
  const tool = (id: string, name: string, input: Record<string, unknown>, result: string, structured: Record<string, unknown> = {}, parent: string | null = null) => {
    frames.push(message(appSessionId, engineSessionId, 'assistant', [{ type: 'tool_use', id, name, input }], parent))
    frames.push(message(appSessionId, engineSessionId, 'user', [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }], parent, { tool_use_result: structured }))
  }
  frames.push(message(appSessionId, engineSessionId, 'user', 'Review the prepared local files. This offline fixture never submits a model request.'))
  text(second ? `# Second session\n\n[Markdown notes](${cwd}/notes.md) and [Report](${cwd}/report.html). Switch sessions after scrolling each file.` : `# File pane acceptance\n\nMarkdown link: [Report](${cwd}/report.html).\n\nBare path: ${cwd}/notes.md\n\nInline code: \`${cwd}/diagram.svg\`.\n\nLine suffix: [Report line 12](${cwd}/report.html:12).\n\n[Image](${cwd}/assets/cat.png) · [Wide page](${cwd}/wide.html) · [Uppercase HTML](${cwd}/CAPS.HTM) · [Malformed SVG](${cwd}/broken.svg) · [Corrupt PNG](${cwd}/corrupt.png) · [Isolation checks](${cwd}/isolation.html) · [Normal source](${cwd}/source.ts)\n\n[Missing file](${cwd}/missing.html) · [Outside workspace](${runRoot}/outside.html) · [Symlink outside](${cwd}/escape.html) · [Generated image](${configDir}/generated-images/generated.png)`)
  text('| Short local link | Type |\n| --- | --- |\n| [report.html](report.html) | HTML |\n| [notes.md](notes.md) | Markdown |\n| [cat.png](assets/cat.png) | Image |\n| [diagram.svg](diagram.svg) | SVG |\n| [broken.svg](broken.svg) | Malformed XML |\n| [corrupt.png](corrupt.png) | Invalid image |')
  if (localhostLinks.length) {
    text('# Local server acceptance\n\n| Page | URL |\n| --- | --- |\n' + localhostLinks.map(link => `| ${link.label} | [${link.label}](${link.url}) |`).join('\n'))
    tool('fixture-localhost-bash', 'Bash', { command: 'Read the prepared local server addresses' }, localhostLinks.map(link => `${link.label}: ${link.url}`).join('\n'))
  }
  tool('fixture-write-older', 'Write', { file_path: join(cwd, 'report.html'), content: html }, 'File created successfully.')
  tool('fixture-edit-middle', 'Edit', { file_path: join(cwd, 'report.html'), old_string: 'old', new_string: 'new' }, 'File updated successfully.')
  tool('fixture-edit-newest', 'Edit', { file_path: join(cwd, 'report.html'), old_string: 'new', new_string: 'current' }, 'File updated successfully.')
  tool('fixture-write-notes', 'Write', { file_path: join(cwd, 'notes.md'), content: readFileSync(join(cwd, 'notes.md'), 'utf8') }, 'File created successfully.')
  frames.push(message(appSessionId, engineSessionId, 'assistant', [{ type: 'tool_use', id: 'fixture-agent', name: 'Agent', input: { description: 'Inspect prepared files', subagent_type: 'general-purpose', prompt: 'Read the prepared files without modifying them.' } }]))
  text(`Worker paths: [Report](${cwd}/report.html), bare ${cwd}/notes.md and inline \`${cwd}/diagram.svg\`.`, 'fixture-agent')
  if (localhostLinks.length) text('Worker local servers: ' + localhostLinks.map(link => `[${link.label}](${link.url})`).join(' · '), 'fixture-agent')
  tool('fixture-worker-write', 'Write', { file_path: join(cwd, 'second.html'), content: '<h1>Second local page</h1>' }, 'File written.', {}, 'fixture-agent')
  tool('fixture-worker-bash', 'Bash', { command: 'Print a large local result' }, Array.from({ length: 180 }, (_, i) => `Output line ${i + 1}: retained detail for output panel verification`).join('\n'), {}, 'fixture-agent')
  frames.push(message(appSessionId, engineSessionId, 'user', [{ type: 'tool_result', tool_use_id: 'fixture-agent', content: 'Prepared files inspected.', is_error: false }], null, { tool_use_result: { agentId: 'fixture-worker', agentName: 'File inspector', model: 'claude-sonnet-4-6', status: 'completed', totalTokens: 1200, totalToolUseCount: 2, totalDurationMs: 1000 } }))
  text(`All files remain ready. [Report](${cwd}/report.html) · [Notes](${cwd}/notes.md) · [Second local page](${cwd}/second.html).`)
  return frames
}

const now = Date.now()
const registry: RegistryDocument = { registryVersion: REGISTRY_VERSION, hostPid: 0, updatedAt: now, sessions: [] }
for (let index = 0; index < ids.length; index++) {
  const appSessionId = ids[index]!
  const engineSessionId = engineIds[index]!
  const frames = fixtureFrames(appSessionId, engineSessionId, index === 1)
  const projectDir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const serialize = (sidechain: boolean) => {
    let parentUuid: string | null = null
    return frames.flatMap(frame => {
      if (frame.kind !== 'event' || frame.event.type !== 'message') throw new Error('Unexpected fixture frame')
      const sdk = frame.event.message
      const child = 'parent_tool_use_id' in sdk && sdk.parent_tool_use_id != null
      if (child !== sidechain) return []
      const row: Record<string, unknown> = { ...sdk, parentUuid, sessionId: engineSessionId, cwd, version: 'file-pane-gui-fixture', isSidechain: sidechain, ...(sidechain ? { agentId: 'fixture-worker' } : {}) }
      // SDK display messages use snake_case. Engine JSONL persists Message fields.
      if ('tool_use_result' in row) row.toolUseResult = row.tool_use_result
      delete row.tool_use_result; delete row.parent_tool_use_id; delete row.session_id
      parentUuid = typeof row.uuid === 'string' ? row.uuid : null
      return [JSON.stringify(row)]
    }).join('\n') + '\n'
  }
  writeFileSync(join(projectDir, `${engineSessionId}.jsonl`), serialize(false), { mode: 0o600 })
  const agentDirectory = join(projectDir, engineSessionId, 'subagents')
  mkdirSync(agentDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(join(agentDirectory, 'agent-fixture-worker.jsonl'), serialize(true), { mode: 0o600 })
  const firstChild = frames.find(frame => frame.kind === 'event' && frame.event.type === 'message' && 'parent_tool_use_id' in frame.event.message && frame.event.message.parent_tool_use_id === 'fixture-agent')
  const firstMessageUuid = firstChild?.kind === 'event' && firstChild.event.type === 'message' ? firstChild.event.message.uuid : undefined
  writeFileSync(join(agentDirectory, 'agent-fixture-worker.meta.json'), JSON.stringify({ agentType: 'general-purpose', agentName: 'File inspector', description: 'Inspect prepared files', parentSessionId: engineSessionId, parentToolUseId: 'fixture-agent', spawnedAt: new Date(now).toISOString(), runs: [{ parentToolUseId: 'fixture-agent', firstMessageUuid }] }), { mode: 0o600 })
  writeCache(transcriptCacheDir(registryDir), createTranscriptCache(appSessionId, engineSessionId, frames))
  if (readCache(transcriptCacheDir(registryDir), appSessionId)?.frames.length !== frames.length) throw new Error('Fixture cache did not round-trip through production codec')
  const ready: ServerFrame = { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId, engineSessionId, payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } }
  const projected = frames.reduce(projectServerFrame, projectServerFrame(createTranscriptState(), ready))
  const rows = selectNestedTranscriptRows(projected, appSessionId)
  const agent = rows.find(row => row.kind === 'tool-use' && row.toolUseId === 'fixture-agent')
  if (agent?.kind !== 'tool-use' || agent.children.length < 3 || agent.result?.agentId !== 'fixture-worker') throw new Error('Fixture worker did not project through production transcript path')
  registry.sessions.push({ appSessionId, engineSessionId, cwd, binding: { kind: 'project' }, title: index ? 'File pane second session' : 'File pane acceptance', forked: false, createdAt: now - 1000 + index, lastAttachedAt: now - index, lastMessageSentAt: now - index, hasAcceptedInput: true, shutdown: 'clean' })
}
writeFileSync(join(registryDir, 'registry.json'), JSON.stringify(registry), { mode: 0o600 })
const bootstrap = join(runRoot, 'isolate-profile.cjs')
writeFileSync(bootstrap, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(profile)});\n`, { mode: 0o600 })
const binary = join(appRoot, '.dev-electron', 'Cat Code Dev.app', 'Contents', 'MacOS', 'Electron')
const port = 5189
const manifest = { runRoot, cwd, configDir, profile, fixtureHome, bootstrap, appRoot, binary, rendererUrl: `http://localhost:${port}`, sessions: registry.sessions.map(row => ({ appSessionId: row.appSessionId, title: row.title })), environment: { HOME: fixtureHome, CLAUDE_CONFIG_DIR: configDir, CATCODE_RENDERER_URL: `http://localhost:${port}`, CATCODE_TEST_CWD_ALLOWLIST: cwd, CATCODE_DEBUG_STATE: '1', ANTHROPIC_API_KEY: 'catcode-fixture-not-a-real-key' }, warning: 'Offline fixture. Do not submit a turn. The deliberately invalid API key only keeps the empty-account sign-in surface from covering the prepared transcript.' }
// Both account vault defaults use homedir(), independently of CLAUDE_CONFIG_DIR.
// Check the exact child environment before publishing a launchable fixture.
const childEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'development', ...manifest.environment }
const homeProbe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env: childEnvironment, encoding: 'utf8', timeout: 10000 })
if (homeProbe.status !== 0 || homeProbe.stdout !== fixtureHome) throw new Error('Fixture child HOME is not isolated')
const poolProbe = spawnSync(process.execPath, ['run', join(appRoot, 'sidecar', 'accountsPoolWorker.ts'), '--bare', '--cached'], { cwd, env: childEnvironment, encoding: 'utf8', timeout: 30000 })
const poolRecords = poolProbe.stdout.trim().split('\n').filter(Boolean).map(line => parseAccountsPoolWorkerResult(JSON.parse(line)))
const pool = poolRecords.find(record => record?.type === 'pool')
if (poolProbe.status !== 0 || pool?.type !== 'pool' || pool.pool.poolCount !== 0 || pool.pool.anthropicPoolCount !== 0 || !pool.pool.anthropicRouteAvailable) throw new Error('Fixture account pool isolation failed')
const replaySource = `
const root=${JSON.stringify(resolve(appRoot, '..'))},project=${JSON.stringify(join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')))};
const {ensureEngineMacro}=await import(root+'/app/sidecar/engineMetadata.ts');ensureEngineMacro();
const {switchSession,setOriginalCwd}=await import(root+'/src/bootstrap/state.ts');setOriginalCwd(${JSON.stringify(cwd)});
const {loadDisplayTranscriptFromJsonlPath}=await import(root+'/src/utils/sessionStorage.ts');
const {projectResumedHistory}=await import(root+'/app/sidecar/historyProjection.ts');
const {withRestoredSubagentHistory}=await import(root+'/app/sidecar/subagentHistory.ts');
const {createTranscriptState,projectServerFrame,selectNestedTranscriptRows}=await import(root+'/app/renderer/src/transcriptProjector.ts');
const {createSubagentDockState,reconcileSubagentDockState,selectSubagentDock}=await import(root+'/app/renderer/src/subagentDockState.ts');
const {canOpenSubagentPanel}=await import(root+'/app/renderer/src/subagentPanelState.ts');
for(const [id,engine] of ${JSON.stringify(ids.map((id, index) => [id, engineIds[index]]))}){
 switchSession(engine,project);
 const loaded=await loadDisplayTranscriptFromJsonlPath(project+'/'+engine+'.jsonl',{maxMessages:1000,maxBytes:4*1024*1024});
 const restored=await withRestoredSubagentHistory(engine,projectResumedHistory(loaded.messages));
 const ready={kind:'ready',protocolVersion:${PROTOCOL_VERSION},sessionId:id,engineSessionId:engine,payload:{type:'app.ready',protocolVersion:1,inputEnabled:true,activeTurn:false,abort:{status:'idle'},goalSnapshot:null,pendingPermissionRequests:[]}};
 let state=projectServerFrame(createTranscriptState(),ready);
 for(const message of restored.history)state=projectServerFrame(state,{kind:'event',protocolVersion:${PROTOCOL_VERSION},sessionId:id,event:{type:'message',message}});
 const rows=selectNestedTranscriptRows(state,id);
 const facts={workers:[],tasks:null,transcriptRows:rows,leases:null,nowMs:Date.now(),reducedMotion:true};
 const dock=selectSubagentDock(reconcileSubagentDockState(createSubagentDockState(),facts),facts);
 const worker=[...dock.active,...dock.finished].find(item=>item.agentId==='fixture-worker');
 if(!worker||!canOpenSubagentPanel(worker,rows))throw new Error('Fixture worker is not openable after real JSONL/subagent replay');
}
console.log('replay-faithful');process.exit(0);
`
const replayProbe = spawnSync(process.execPath, ['-e', replaySource], { cwd, env: childEnvironment, encoding: 'utf8', timeout: 30000 })
if (replayProbe.status !== 0 || !replayProbe.stdout.includes('replay-faithful')) throw new Error('Fixture production replay validation failed: ' + replayProbe.stderr.slice(-2000))
writeFileSync(join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const envPairs = Object.entries(manifest.environment).map(([key, value]) => `${key}=${quote(value)}`).join(' ')
writeFileSync(join(runRoot, 'launch.sh'), `#!/bin/sh\nexec env -i PATH=${quote(process.env.PATH ?? '/usr/bin:/bin')} ${envPairs} ${quote(binary)} --require ${quote(bootstrap)} ${quote(appRoot)}\n`, { mode: 0o700 })
process.stdout.write(JSON.stringify({ manifest: join(runRoot, 'manifest.json'), build: `bun run ${quote(join(appRoot, 'scripts', 'build-electron.ts'))}`, prepareBinary: `bun run ${quote(join(appRoot, 'scripts', 'prepare-dev-electron.ts'))}`, vite: `bunx vite --config ${quote(join(appRoot, 'renderer', 'vite.config.ts'))} --port ${port}`, launch: join(runRoot, 'launch.sh'), ...manifest }, null, 2) + '\n')
