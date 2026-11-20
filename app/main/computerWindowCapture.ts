import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseComputerWindowCaptureRequest, type ComputerWindowCapture } from '../shared/computerWindowCapture.js'

const exec = promisify(execFile)
const unavailable = { status: 'unavailable' } as const

// CoreGraphics returns windows in front-to-back order. Never substitute another
// application's window or a display capture when the named app is missing.
const resolveWindow = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
function run(argv) {
  if (!$.CGPreflightScreenCaptureAccess() &&
      !(argv[1] === 'ask' && $.CGRequestScreenCaptureAccess())) return 'denied';
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
  const target = argv[0].slice(7).toLowerCase();
  for (const win of windows) {
    if (win.kCGWindowLayer !== 0 || win.kCGWindowAlpha === 0 ||
        win.kCGWindowBounds.Width < 32 || win.kCGWindowBounds.Height < 32) continue;
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(win.kCGWindowOwnerPID);
    const bundle = ObjC.unwrap(app.bundleIdentifier);
    const name = ObjC.unwrap(app.localizedName);
    if ([bundle, name, win.kCGWindowOwnerName].some(value =>
        typeof value === 'string' && value.toLowerCase() === target)) return String(win.kCGWindowNumber);
  }
  return '';
}`

export function createComputerWindowCaptureHandler<E>(deps: {
  trusted: (event: E) => boolean
  capture: (app: string, ask: boolean) => Promise<ComputerWindowCapture>
  mac: boolean
}) {
  let active = false
  let asked = false
  return async (event: E, ...args: unknown[]): Promise<ComputerWindowCapture> => {
    if (!deps.mac || !deps.trusted(event) || active || args.length !== 1) return unavailable
    const request = parseComputerWindowCaptureRequest(args[0])
    if (!request) return unavailable
    active = true
    const ask = !asked
    asked = true
    try {
      return await deps.capture(request.app, ask)
    } catch {
      return unavailable
    } finally {
      active = false
    }
  }
}

export async function captureComputerWindow(app: string, ask: boolean, encode: (path: string) => ComputerWindowCapture): Promise<ComputerWindowCapture> {
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', resolveWindow, `target:${app}`, ask ? 'ask' : 'check'], { timeout: ask ? 60_000 : 4_000, maxBuffer: 1024 })
  const id = stdout.trim()
  if (id === 'denied') return { status: 'denied' }
  if (!/^[1-9]\d{0,9}$/.test(id)) return unavailable
  const dir = await mkdtemp(join(tmpdir(), 'cat-code-window-'))
  try {
    const path = join(dir, 'window.jpg')
    await exec('/usr/sbin/screencapture', ['-x', '-o', '-t', 'jpg', `-l${id}`, path], { timeout: 4_000 })
    if ((await stat(path)).size > 20 * 1024 * 1024) return unavailable
    return encode(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
