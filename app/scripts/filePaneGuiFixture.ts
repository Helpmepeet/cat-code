/** Offline content for native file-pane acceptance. No renderer injection or model calls. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createTranscriptCache, readCache, transcriptCacheDir, writeCache } from '../main/transcriptCache.js'
import { REGISTRY_VERSION, type RegistryDocument } from '../host/registry.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows } from '../renderer/src/transcriptProjector.js'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'catcode-file-pane-gui-')))
const cwd = join(runRoot, 'workspace')
const configDir = join(runRoot, 'config')
const profile = join(runRoot, 'electron-profile')
const registryDir = join(configDir, 'desktop')
for (const directory of [cwd, configDir, profile, registryDir, join(cwd, 'assets'), join(configDir, 'generated-images')]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>File pane fixture</title><link rel="stylesheet" href="assets/page.css"><script defer src="assets/page.js"></script></head><body><main><h1>File pane fixture</h1><p id="script-result">Script has not run</p><p><button id="counter">Count: 0</button> <input aria-label="Page input" placeholder="Click here for page keys"></p><p><a href="second.html">Second local page</a> · <a href="#section-20">Jump to section 20</a> · <a href="https://example.com">Outside site</a></p><p><img src="assets/cat.png" width="96" alt="Relative image"></p>${Array.from({ length: 30 }, (_, i) => `<section id="section-${i + 1}"><h2>Section ${i + 1}</h2><p>Scroll restoration sample ${i + 1}. This content remains fixed while switching panels and sessions.</p></section>`).join('')}</main></body></html>`
writeFileSync(join(cwd, 'report.html'), html)
writeFileSync(join(cwd, 'CAPS.HTM'), html.replace('File pane fixture</h1>', 'Case insensitive HTML</h1>'))
writeFileSync(join(cwd, 'assets', 'page.css'), 'body{margin:0;background:#fff;color:#222;font:15px/1.6 system-ui}main{max-width:760px;margin:auto;padding:32px}section{padding:28px 0;border-bottom:1px solid #ddd}button,input{font:inherit}img{display:block}')
writeFileSync(join(cwd, 'assets', 'page.js'), "document.querySelector('#script-result').textContent = 'Relative script loaded';let count=0;document.querySelector('#counter').onclick=event=>event.target.textContent='Count: '+(++count)")
writeFileSync(join(cwd, 'second.html'), '<!doctype html><h1>Second local page</h1><p><a href="report.html">Return to report</a></p><div style="height:1800px">Long second page</div>')
writeFileSync(join(cwd, 'wide.html'), '<!doctype html><style>body{margin:0;background:white;color:#222;font:15px system-ui}main{width:1600px;height:1200px;padding:32px;box-sizing:border-box;background:linear-gradient(90deg,#eef,#fee)}</style><main><h1>Wide file: horizontal scrolling</h1><p style="margin-left:1200px">Right edge marker</p></main>')
writeFileSync(join(cwd, 'notes.md'), '# File pane notes\n\nMarkdown uses the same prose as replies.\n\n[Open report](report.html) · [Second page](second.html) · [Outside link](https://example.com)\n\n![Relative image](assets/cat.png)\n\n' + Array.from({ length: 25 }, (_, i) => `## Section ${i + 1}\n\nMarkdown scroll sample ${i + 1}.\n\n`).join(''))
writeFileSync(join(cwd, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#fff"/><rect x="80" y="80" width="640" height="440" rx="32" fill="#b8d8ff"/><text id="label" x="160" y="310" font-size="32">SVG script pending</text><script>document.getElementById("label").textContent="SVG script ran";</script></svg>')
copyFileSync(join(appRoot, 'renderer', 'src', 'assets', 'welcome-cat-coding.png'), join(cwd, 'assets', 'cat.png'))
copyFileSync(join(cwd, 'assets', 'cat.png'), join(configDir, 'generated-images', 'generated.png'))
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
  text(second ? `# Second session\n\n[Markdown notes](${cwd}/notes.md) and [Report](${cwd}/report.html). Switch sessions after scrolling each file.` : `# File pane acceptance\n\nMarkdown link: [Report](${cwd}/report.html).\n\nBare path: ${cwd}/notes.md\n\nInline code: \`${cwd}/diagram.svg\`.\n\nLine suffix: [Report line 12](${cwd}/report.html:12).\n\n[Image](${cwd}/assets/cat.png) · [Wide page](${cwd}/wide.html) · [Uppercase HTML](${cwd}/CAPS.HTM) · [Normal source](${cwd}/source.ts)\n\n[Missing file](${cwd}/missing.html) · [Outside workspace](${runRoot}/outside.html) · [Symlink outside](${cwd}/escape.html) · [Generated image](${configDir}/generated-images/generated.png)`)
  tool('fixture-write-older', 'Write', { file_path: join(cwd, 'report.html'), content: html }, 'File created successfully.')
  tool('fixture-edit-middle', 'Edit', { file_path: join(cwd, 'report.html'), old_string: 'old', new_string: 'new' }, 'File updated successfully.')
  tool('fixture-edit-newest', 'Edit', { file_path: join(cwd, 'report.html'), old_string: 'new', new_string: 'current' }, 'File updated successfully.')
  tool('fixture-write-notes', 'Write', { file_path: join(cwd, 'notes.md'), content: readFileSync(join(cwd, 'notes.md'), 'utf8') }, 'File created successfully.')
  frames.push(message(appSessionId, engineSessionId, 'assistant', [{ type: 'tool_use', id: 'fixture-agent', name: 'Agent', input: { description: 'Inspect prepared files', subagent_type: 'general-purpose', prompt: 'Read the prepared files without modifying them.' } }]))
  text(`Worker paths: [Report](${cwd}/report.html), bare ${cwd}/notes.md and inline \`${cwd}/diagram.svg\`.`, 'fixture-agent')
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
  let parentUuid: string | null = null
  const transcript = frames.map(frame => {
    if (frame.kind !== 'event' || frame.event.type !== 'message') throw new Error('Unexpected fixture frame')
    const row = { ...frame.event.message, parentUuid, sessionId: engineSessionId, cwd, version: 'file-pane-gui-fixture', isSidechain: false }
    parentUuid = row.uuid ?? null
    return JSON.stringify(row)
  }).join('\n') + '\n'
  writeFileSync(join(projectDir, `${engineSessionId}.jsonl`), transcript, { mode: 0o600 })
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
const manifest = { runRoot, cwd, configDir, profile, bootstrap, appRoot, binary, rendererUrl: `http://localhost:${port}`, sessions: registry.sessions.map(row => ({ appSessionId: row.appSessionId, title: row.title })), environment: { CLAUDE_CONFIG_DIR: configDir, CATCODE_RENDERER_URL: `http://localhost:${port}`, CATCODE_TEST_CWD_ALLOWLIST: cwd, CATCODE_DEBUG_STATE: '1', ANTHROPIC_API_KEY: 'catcode-fixture-not-a-real-key' }, warning: 'Offline fixture. Do not submit a turn. The deliberately invalid API key only keeps the empty-account sign-in surface from covering the prepared transcript.' }
writeFileSync(join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const envPairs = Object.entries(manifest.environment).map(([key, value]) => `${key}=${quote(value)}`).join(' ')
writeFileSync(join(runRoot, 'launch.sh'), `#!/bin/sh\nexec env -i PATH=${quote(process.env.PATH ?? '/usr/bin:/bin')} ${envPairs} ${quote(binary)} --require ${quote(bootstrap)} ${quote(appRoot)}\n`, { mode: 0o700 })
process.stdout.write(JSON.stringify({ manifest: join(runRoot, 'manifest.json'), build: `bun run ${quote(join(appRoot, 'scripts', 'build-electron.ts'))}`, prepareBinary: `bun run ${quote(join(appRoot, 'scripts', 'prepare-dev-electron.ts'))}`, vite: `bunx vite --config ${quote(join(appRoot, 'renderer', 'vite.config.ts'))} --port ${port}`, launch: join(runRoot, 'launch.sh'), ...manifest }, null, 2) + '\n')
