import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { ConnectedMCPServer } from './types.js'

// The local adapter keeps a JavaScript realm per stdio connection. After general
// JS runs, even a literal cua.getBrowser call can resolve to a replaced binding.
const usedRealms = new WeakSet<ConnectedMCPServer['client']>()
const browserAdapters = new WeakSet<ConnectedMCPServer['client']>()
const selected = new WeakMap<object, ConnectedMCPServer['client']>()

export function isDirectBrowserAdapterLaunch(
  name: string,
  scope: ConnectedMCPServer['config']['scope'],
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  shellPrefix: string | undefined,
): boolean {
  return name === 'codex-computer-use' && scope === 'user' && !shellPrefix &&
    isAbsolute(command) && basename(command) === 'node' &&
    args.length === 1 && args[0] === join(homedir(), '.local/share/codex-computer-use-mcp/local/dist/mcp-server.js') &&
    !Object.entries(env).some(([key, value]) => value &&
      /^(?:NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_)/iu.test(key))
}

export function registerDirectBrowserAdapter(connection: ConnectedMCPServer): void {
  if (connection.serverInfo?.name === 'codex-computer-use-mcp') browserAdapters.add(connection.client)
}

function isBrowserSelection(args: Record<string, unknown>): boolean {
  if (Object.keys(args).some(key => !['code', 'title', 'timeout_ms'].includes(key)) ||
      typeof args.code !== 'string' || (args.title !== undefined && typeof args.title !== 'string')) return false
  return /^(?:(?:let|const) (?!cua\b)[A-Za-z_$][\w$]*\s*=\s*)?await\s+cua\.getBrowser\(\s*\{\s*id\s*:\s*(?:"iab"|'iab')\s*\}\s*\)\s*;?$/u.test(args.code.trim())
}

export function admitBrowserSelection(connection: ConnectedMCPServer, tool: string, args: Record<string, unknown>, attempt: object): boolean {
  if (!browserAdapters.has(connection.client) || tool !== 'js' ||
      usedRealms.has(connection.client) || !isBrowserSelection(args)) return false
  selected.set(attempt, connection.client)
  return true
}

export function bindBrowserSelection(attempt: object | undefined, meta: object): void {
  const client = attempt && selected.get(attempt)
  if (client) selected.set(meta, client)
}

export function checkBrowserDispatch(connection: ConnectedMCPServer, tool: string, args: Record<string, unknown>, meta?: object): void {
  const admitted = meta && selected.get(meta)
  if (admitted && (connection.client !== admitted || usedRealms.has(admitted) || tool !== 'js' || !isBrowserSelection(args))) {
    throw new Error('Browser session changed before selection. Retry the browser call.')
  }
  if (browserAdapters.has(connection.client) && tool === 'js' && !isBrowserSelection(args)) usedRealms.add(connection.client)
}
