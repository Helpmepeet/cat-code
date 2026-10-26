// A process-backed fixture for the driver's documented line-delimited socket
// protocol. No CuaDriver binary, Accessibility API or application is used.
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { createConnection, createServer } from 'net'
import { join } from 'path'

const home = process.env.HOME!
const socketPath = join(home, 'Library', 'Caches', 'cua-driver', 'cua-driver.sock')
if (process.argv[2] === 'serve') {
  appendFileSync(join(home, 'starts'), `${process.pid}\n`)
  while (process.env.CUA_TEST_START_GATE && !existsSync(process.env.CUA_TEST_START_GATE)) {
    await Bun.sleep(10)
  }
  mkdirSync(join(home, 'Library', 'Caches', 'cua-driver'), { recursive: true })
  const server = createServer(socket => {
    let input = ''
    socket.on('data', chunk => {
      input += chunk.toString()
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(input.slice(0, newline))
      if (request.method === 'shutdown') {
        socket.end('{"ok":true}\n')
        server.close(() => {
          rmSync(socketPath, { force: true })
          process.exit(0)
        })
      } else if (request.method === 'list') {
        socket.end('{"ok":true,"result":[]}\n')
      } else if (request.method === 'call') {
        appendFileSync(join(home, 'effects'), `${request.args.value}\n`)
        socket.end(JSON.stringify(request.args.value === 'fail-after-effect'
          ? { ok: false, error: 'Internal error after effect' }
          : { ok: true, result: 'ok' }) + '\n')
      }
    })
  })
  server.listen(socketPath)
} else if (process.argv[2] === 'stop') {
  const socket = createConnection(socketPath)
  socket.once('error', () => process.exit(0))
  socket.once('connect', () => socket.write('{"method":"shutdown"}\n'))
  socket.once('end', async () => {
    while (existsSync(socketPath)) await Bun.sleep(10)
    process.exit(0)
  })
  socket.resume()
}
