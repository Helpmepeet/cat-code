/** Owned loopback servers and offline transcripts for native localhost-pane acceptance. */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer, type ViteDevServer } from 'vite'
import type { ServerWebSocket } from 'bun'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv[2] === 'control') {
  const manifest = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as { controlUrl: string }
  const response = await fetch(manifest.controlUrl + '&command=' + encodeURIComponent(process.argv[4] ?? 'status'))
  process.stdout.write(await response.text() + '\n')
  process.exit(response.ok ? 0 : 1)
}
const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'catcode-localhost-pane-gui-')))
const viteRoot = join(runRoot, 'vite-site')
mkdirSync(viteRoot, { recursive: true })
let version = 1
let localPort = 0
let ipv6Available = false
let stopped = false
let submittedPosts = 0
let unintendedGets = 0
let vite: ViteDevServer | undefined
let vitePort = 0
const sockets = new Set<ServerWebSocket<undefined>>()
const writeVersion = () => writeFileSync(join(viteRoot, 'hot.js'), `export const version=${version};\n`)
writeVersion()
writeFileSync(join(viteRoot, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Real Vite HMR fixture</title><style>body{background:white;color:#222;font:16px/1.6 system-ui;padding:24px}section{height:180px;border-top:1px solid #ccc}</style></head><body><h1>Real Vite HMR</h1><p id="version">Module pending</p><input id="preserved" aria-label="HMR preserved state" placeholder="Type here; HMR must preserve this"><p><button id="route">Router pushState</button> <a href="#section-18">Section 18 hash</a></p><script type="module" src="/entry.js"></script>${Array.from({ length: 24 }, (_, i) => `<section id="section-${i + 1}"><h2>Vite section ${i + 1}</h2></section>`).join('')}</body></html>`)
writeFileSync(join(viteRoot, 'entry.js'), `import {version} from './hot.js';const show=v=>document.querySelector('#version').textContent='Real Vite hot version '+v;show(version);if(import.meta.hot)import.meta.hot.accept('./hot.js',mod=>show(mod.version));const renderRoute=()=>document.querySelector('h1').textContent=location.pathname==='/'?'Real Vite HMR':'Real Vite '+location.pathname;addEventListener('popstate',renderRoute);renderRoute();document.querySelector('#route').onclick=()=>{history.pushState({},'','/router/second');renderRoute()};`)
async function startVite() {
  if (!vitePort) {
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 404 }) })
    vitePort = reservation.port!
    await reservation.stop(true)
  }
  vite = await createServer({ configFile: false, root: viteRoot, clearScreen: false, logLevel: 'error', plugins: [{ name: 'fixture-unserved-router-path', configureServer(server) { server.middlewares.use((request, response, next) => { if (!request.url?.startsWith('/router/')) return next(); response.statusCode = 404; response.end('Backend does not serve SPA deep routes') }) } }], server: { host: '127.0.0.1', port: vitePort || 0, strictPort: true, watch: { usePolling: true, interval: 100 }, allowedHosts: ['localhost'] } })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not bind')
  vitePort = address.port
}
const html = (path: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Localhost route ${path}</title><style>body{margin:0;background:white;color:#222;font:15px/1.6 system-ui}main{padding:24px;max-width:760px;margin:auto}button,input{font:inherit}section{height:180px;border-top:1px solid #ddd}</style></head><body><main><h1>Localhost ${path}</h1><p id="version">Server version ${version}</p><p id="module">Module pending</p><p id="socket">Socket pending</p><input aria-label="Local page input" placeholder="Page key focus"><p><a href="/second">Second route</a> · <a href="/redirect-local">Local redirect</a> · <a href="/head-get-redirect">HEAD200 then GET redirect</a> · <a href="#section-18">Section 18</a></p><p><button id="router">Router pushState</button> <button id="replace">Router replaceState</button> <button id="script-route">Script route</button> <button id="reload">Page reload</button> <button id="arm">Arm reload on socket outage</button></p><form action="/form" method="get"><input name="value" value="local"><button>GET form route</button></form><form action="/form" method="get"><input name="value" value="submitter override"><button formmethod="post" formaction="/submitter-post">POST using submitter override</button></form><p><a href="/submission-counts">Submission counts</a></p><p><a href="/headers">XFO and frame ancestors</a> · <a href="/policy">Preserved script policy</a> · <a href="/head-405">HEAD unsupported</a></p><p><a href="http://example.invalid/leave">External anchor</a> · <a href="http://example.invalid/popup-leave" target="_blank">External new window</a> · <a href="/redirect-external">External redirect</a> · <a href="/redirect-app">App origin redirect</a> · <button id="external">External script navigation</button> · <button id="app-origin">App origin navigation</button> · <button id="top">Top navigation</button></p><ul id="isolation"></ul><script type="module" src="/module.js"></script>${Array.from({ length: 28 }, (_, i) => `<section id="section-${i + 1}"><h2>Local section ${i + 1}</h2><p>Route ${path}, version ${version}</p></section>`).join('')}</main></body></html>`
const moduleScript = `const data=await fetch('/data.json').then(r=>r.json());document.querySelector('#module').textContent='Relative module and JSON loaded: '+data.version;let armed=false;const connect=()=>{const socket=new WebSocket('ws://'+location.host+'/socket');socket.onopen=()=>document.querySelector('#socket').textContent='WebSocket connected';socket.onmessage=e=>{if(e.data==='reload')location.reload();else document.querySelector('#version').textContent='Socket hot version '+e.data};socket.onclose=()=>{document.querySelector('#socket').textContent='WebSocket disconnected';if(armed)location.reload();else setTimeout(connect,300)}};connect();document.querySelector('#arm').onclick=()=>{armed=true;document.querySelector('#socket').textContent='Armed reload on socket outage'};const renderRoute=()=>document.querySelector('h1').textContent='Localhost '+location.pathname;addEventListener('popstate',renderRoute);renderRoute();document.querySelector('#router').onclick=()=>{history.pushState({},'','/router/second');renderRoute()};document.querySelector('#replace').onclick=()=>{history.replaceState({},'','/router/replaced');renderRoute()};document.querySelector('#script-route').onclick=()=>location.href='/script-route';document.querySelector('#reload').onclick=()=>location.reload();document.querySelector('#external').onclick=()=>location.href='http://example.invalid/script-leave';document.querySelector('#app-origin').onclick=()=>location.href='http://localhost:5189';document.querySelector('#top').onclick=()=>{try{top.location.href='http://localhost:5189'}catch{}};const report=(name,ok)=>{const li=document.createElement('li');li.textContent=(ok?'PASS: ':'FAIL: ')+name;document.querySelector('#isolation').append(li)};report('No preload bridge',typeof window.catcode==='undefined');report('No require',typeof window.require==='undefined');report('No process',typeof window.process==='undefined');let blocked=false;try{void parent.document.body}catch{blocked=true}report('Parent document blocked',blocked);let bridge=false;try{bridge=typeof parent.catcode==='undefined'}catch{bridge=true}report('Parent bridge blocked',bridge);let popup=null;try{popup=open('about:blank')}catch{}report('Popup blocked',popup===null);if(popup)popup.close();`
const websocket = { open(ws: ServerWebSocket<undefined>) { sockets.add(ws) }, close(ws: ServerWebSocket<undefined>) { sockets.delete(ws) }, message() {} }
const fetchPage = (request: Request, server: Bun.Server<undefined>): Response | undefined => {
  const url = new URL(request.url)
  if (url.pathname === '/socket' && server.upgrade(request)) return
  if (url.pathname === '/head-get-redirect') return request.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.redirect(new URL('/actual-final', request.url), 302)
  if (url.pathname === '/submission-counts') return Response.json({ submittedPosts, unintendedGets })
  if (url.pathname === '/submitter-post') {
    if (request.method === 'HEAD') return new Response(null, { status: 200 })
    if (request.method === 'POST') submittedPosts++
    else if (request.method === 'GET') unintendedGets++
    return new Response(`<!doctype html><h1>${request.method} submission received</h1><p>POST count: ${submittedPosts}. Unintended GET count: ${unintendedGets}.</p><a href="/">Return to fixture</a>`, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } })
  }
  if (url.pathname === '/redirect-external') return Response.redirect('http://example.invalid/redirect-leave', 302)
  if (url.pathname === '/redirect-app') return Response.redirect('http://localhost:5189', 302)
  if (url.pathname === '/redirect-local') return Response.redirect(new URL('/second?redirected=1', request.url), 302)
  if (url.pathname.startsWith('/router/')) return new Response('Backend does not serve SPA deep routes', { status: 404 })
  if (url.pathname === '/head-405' && request.method === 'HEAD') return new Response('Use GET', { status: 405 })
  if (url.pathname === '/module.js') return new Response(moduleScript, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } })
  if (url.pathname === '/data.json') return Response.json({ version })
  const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  if (url.pathname === '/headers') { headers['X-Frame-Options'] = 'DENY'; headers['Content-Security-Policy'] = "frame-ancestors 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'" }
  if (url.pathname === '/policy') { headers['X-Frame-Options'] = 'SAMEORIGIN'; headers['Content-Security-Policy'] = "frame-ancestors 'none'; script-src 'none'; style-src 'unsafe-inline'" }
  return new Response(request.method === 'HEAD' ? null : html(url.pathname), { headers })
}
let ipv4: Bun.Server<undefined> | undefined
let ipv6: Bun.Server<undefined> | undefined
function startLocal() {
  ipv4 = Bun.serve<undefined>({ hostname: '127.0.0.1', port: localPort, fetch: fetchPage, websocket })
  localPort = ipv4.port!
  try { ipv6 = Bun.serve<undefined>({ hostname: '::1', port: localPort, fetch: fetchPage, websocket }); ipv6Available = true } catch { ipv6Available = false }
  stopped = false
}
async function stopLocal() { await ipv4?.stop(true); await ipv6?.stop(true); ipv4 = undefined; ipv6 = undefined; stopped = true }
startLocal()
await startVite()
const token = randomUUID()
const control = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url)
  if (url.searchParams.get('token') !== token) return new Response('Forbidden', { status: 403 })
  const command = url.searchParams.get('command') ?? 'status'
  if (command === 'stop') await stopLocal()
  else if (command === 'start' && stopped) { version++; startLocal() }
  else if (command === 'hot') { version++; for (const ws of sockets) ws.send(String(version)); writeVersion() }
  else if (command === 'reload') for (const ws of sockets) ws.send('reload')
  else if (command === 'manual-version') version++
  else if (command === 'vite-stop') { await vite?.close(); vite = undefined }
  else if (command === 'vite-start' && !vite) { version++; writeVersion(); await startVite() }
  else if (command === 'shutdown') { setTimeout(async () => { await stopLocal(); await vite?.close(); control.stop(true); process.exit(0) }, 30) }
  else if (!['status', 'stop', 'start', 'hot', 'reload', 'manual-version', 'vite-stop', 'vite-start', 'shutdown'].includes(command)) return new Response('Unknown command', { status: 400 })
  return Response.json({ pid: process.pid, stopped, version, viteRunning: Boolean(vite), localPort, vitePort, ipv6Available })
} })
const unusedPortReservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 404 }) })
const unusedPort = unusedPortReservation.port!
await unusedPortReservation.stop(true)
const links = [
  { label: 'Localhost', url: `http://localhost:${localPort}/` },
  { label: 'IPv4', url: `http://127.0.0.1:${localPort}/` },
  { label: 'Real Vite HMR', url: `http://127.0.0.1:${vitePort}/` },
  ...(ipv6Available ? [{ label: 'IPv6', url: `http://[::1]:${localPort}/` }] : []),
  { label: 'HEAD200 GET redirect', url: `http://127.0.0.1:${localPort}/head-get-redirect` },
  { label: 'Frame headers', url: `http://127.0.0.1:${localPort}/headers` },
  { label: 'No server', url: `http://127.0.0.1:${unusedPort}/` },
  { label: 'App Vite origin must refuse', url: 'http://localhost:5189/' },
]
const linksPath = join(runRoot, 'transcript-links.json')
writeFileSync(linksPath, JSON.stringify(links))
const generated = spawnSync(process.execPath, ['run', join(appRoot, 'scripts', 'filePaneGuiFixture.ts'), '--localhost-links', linksPath], { encoding: 'utf8', timeout: 60000 })
if (generated.status !== 0) { await stopLocal(); await vite?.close(); control.stop(true); throw new Error('Offline transcript generation failed: ' + generated.stderr) }
const fileFixture = JSON.parse(generated.stdout) as { manifest: string }
const manifestPath = join(runRoot, 'manifest.json')
const manifest = { runRoot, pid: process.pid, controlUrl: `http://127.0.0.1:${control.port}/?token=${token}`, links, localPort, vitePort, ipv6Available, fileFixtureManifest: fileFixture.manifest, fileFixture: JSON.parse(readFileSync(fileFixture.manifest, 'utf8')), controlCommand: `bun run ${JSON.stringify(fileURLToPath(import.meta.url))} control ${JSON.stringify(manifestPath)} <status|stop|start|hot|reload|manual-version|vite-stop|vite-start|shutdown>`, note: 'Only loopback listeners; example.invalid leave links must be blocked by the app. No model turns or GUI automation. Non-HMR route uses manual-version then header Reload; hot changes real Vite module and custom WebSocket text. Arm outage reload before stop to test page-initiated reload retention.' }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
process.stdout.write(JSON.stringify({ manifest: manifestPath, ...manifest }, null, 2) + '\n')
process.on('SIGTERM', async () => { await stopLocal(); await vite?.close(); control.stop(true); process.exit(0) })
