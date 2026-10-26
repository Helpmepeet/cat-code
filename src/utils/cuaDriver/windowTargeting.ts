import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { getImageProcessor } from '../../tools/FileReadTool/imageProcessor.js'

const ZOOM_DESCRIPTION =
  'Inspect a region of one explicit window at native capture resolution. Requires pid and window_id. First get_window_state or screenshot for this same window. Coordinates x1, y1, x2, y2 use the pixels of that delivered image. Validates current ownership before capturing the explicit window; refresh your image if the window changed. Adds 20% padding. This image is for inspection: take a fresh get_window_state and use its normal coordinates for actions. from_zoom=true is unavailable. This window-scoped zoom is provided by Cat Code MCP; direct cua-driver CLI zoom remains PID-only.'

export const CUA_DRIVER_FROM_ZOOM_MESSAGE =
  'from_zoom=true cannot identify the window that produced the native zoom context. Take a fresh get_window_state with pid and window_id, then use its normal coordinates with from_zoom=false.'

export function getCuaDriverWindowTargetRefusal(
  _tool: string,
  args: unknown,
): string | null {
  return typeof args === 'object' && args !== null &&
    'from_zoom' in args && args.from_zoom === true
    ? CUA_DRIVER_FROM_ZOOM_MESSAGE
    : null
}

type ScreenshotContract = { requiresPid: boolean; acceptsFormat: boolean }
const screenshotContracts = new WeakMap<object, ScreenshotContract>()


type WindowFrame = { width: number; height: number; pid?: number }
const windowFrames = new WeakMap<object, WeakMap<object, Map<number, WindowFrame>>>()
const MAX_WINDOW_FRAMES = 32

function framesFor(client: object, scope: object | undefined): Map<number, WindowFrame> | undefined {
  return scope ? windowFrames.get(scope)?.get(client) : undefined
}

function isImageObservation(tool: string): boolean {
  return tool === 'get_window_state' || tool === 'screenshot'
}

/** Record the model-ready normalized image, not raw SDK dimensions. */
export async function recordCuaDriverWindowImage(
  client: object,
  scope: object | undefined,
  tool: string,
  args: Record<string, unknown>,
  content: unknown,
): Promise<void> {
  if (!scope || !isImageObservation(tool) || !positiveInteger(args.window_id)) return
  const clients = windowFrames.get(scope) ?? new WeakMap<object, Map<number, WindowFrame>>()
  const frames = clients.get(client) ?? new Map<number, WindowFrame>()
  frames.delete(args.window_id)
  clients.set(client, frames)
  windowFrames.set(scope, clients)
  if (!Array.isArray(content)) return
  const images = content.filter(item => item?.type === 'image' &&
    item.source?.type === 'base64' && typeof item.source.data === 'string')
  if (images.length !== 1) return
  try {
    const sharp = await getImageProcessor()
    const { width, height } = await sharp(Buffer.from(images[0].source.data, 'base64')).metadata()
    if (!positiveInteger(width) || !positiveInteger(height)) return
    frames.set(args.window_id, {
      width, height, ...(positiveInteger(args.pid) ? { pid: args.pid } : {}),
    })
    while (frames.size > MAX_WINDOW_FRAMES) frames.delete(frames.keys().next().value!)
  } catch {
    // The normal image pipeline owns malformed-image errors. No usable frame
    // means zoom asks for another explicit image instead of reusing stale data.
  }
}

export function hasCuaDriverWindowTools(client: object): boolean {
  return screenshotContracts.has(client)
}

/** Keep the advertised screenshot contract with its exact SDK connection. */
export function prepareCuaDriverWindowTools(
  client: object,
  tools: Tool[],
): Tool[] {
  const screenshot = tools.find(tool => tool.name === 'screenshot')
  const properties = screenshot?.inputSchema.properties
  if (properties && 'window_id' in properties) {
    screenshotContracts.set(client, {
      acceptsFormat: 'format' in properties,
      requiresPid: Array.isArray(screenshot?.inputSchema.required) &&
        screenshot.inputSchema.required.includes('pid'),
    })
  } else {
    screenshotContracts.delete(client)
  }

  return tools.map(tool => {
    if (tool.name === 'zoom') {
      return {
        ...tool,
        description: ZOOM_DESCRIPTION,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            window_id: {
              type: 'integer',
              minimum: 1,
              description: 'CGWindowID belonging to pid, from list_windows.',
            },
          },
          required: [...new Set([
            ...(tool.inputSchema.required ?? []), 'pid', 'window_id',
          ])],
        },
      }
    }
    if (tool.inputSchema.properties && 'from_zoom' in tool.inputSchema.properties) {
      return {
        ...tool,
        description: `${tool.description ?? ''}\nUse a fresh get_window_state of the target window and normal screenshot coordinates. from_zoom=true is unavailable.`,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            from_zoom: {
              type: 'boolean', const: false,
              description: 'Use false and coordinates from get_window_state.',
            },
          },
        },
      }
    }
    return tool
  })
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function readImage(result: CallToolResult): Promise<{
  bytes: Buffer; width: number; height: number
}> {
  if (result.isError) {
    const details = result.content.filter(item => item.type === 'text')
      .map(item => item.text).join('\n')
    throw new Error(details || 'Window capture failed.')
  }
  const images = result.content.filter(item => item.type === 'image')
  if (images.length !== 1) {
    throw new Error('Window zoom needs exactly one inline screenshot. Take a fresh get_window_state with an image.')
  }
  const bytes = Buffer.from(images[0]!.data, 'base64')
  const sharp = await getImageProcessor()
  const { width, height } = await sharp(bytes).metadata()
  if (!positiveInteger(width) || !positiveInteger(height)) {
    throw new Error('Window screenshot has invalid dimensions.')
  }
  return { bytes, width, height }
}

/**
 * Never use the driver's PID-only zoom/resize registry. Match a delivered
 * image's frame to an explicit current window, then crop its native capture.
 * Errors never fall back to another window or create native from_zoom state.
 */
export async function callCuaDriverWindowTool(
  client: object,
  tool: string,
  args: Record<string, unknown>,
  call: (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>,
  scope: object | undefined,
): Promise<CallToolResult> {
  const refusal = getCuaDriverWindowTargetRefusal(tool, args)
  if (refusal) throw new Error(refusal)
  if (tool !== 'zoom') {
    if (isImageObservation(tool) && positiveInteger(args.window_id)) {
      framesFor(client, scope)?.delete(args.window_id)
    }
    return call(tool, args)
  }

  const { pid, window_id: windowId, x1, y1, x2, y2 } = args
  if (!positiveInteger(pid) || !positiveInteger(windowId)) {
    throw new Error('Window zoom requires explicit positive pid and window_id from list_windows.')
  }
  const coordinates = [x1, y1, x2, y2]
  if (!coordinates.every(value => typeof value === 'number' && Number.isFinite(value)) ||
    !(typeof x1 === 'number' && typeof y1 === 'number' &&
      typeof x2 === 'number' && typeof y2 === 'number') ||
    x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1 || x2 - x1 > 500) {
    throw new Error('Window zoom needs finite, ordered screenshot coordinates and a region at most 500 pixels wide.')
  }
  const contract = screenshotContracts.get(client)
  if (!contract) {
    throw new Error('This CuaDriver connection has no advertised window-scoped screenshot. Use get_window_state for the explicit window.')
  }
  const snapshot = framesFor(client, scope)?.get(windowId)
  if (!snapshot || (snapshot.pid !== undefined && snapshot.pid !== pid)) {
    throw new Error('Take a fresh get_window_state or screenshot for this explicit window before zoom.')
  }
  const listed = await call('list_windows', { pid })
  const windows = listed.structuredContent?.windows
  if (listed.isError || !Array.isArray(windows) || !windows.some(window =>
    typeof window === 'object' && window !== null &&
    window.pid === pid && window.window_id === windowId && window.on_current_space === true)) {
    framesFor(client, scope)?.delete(windowId)
    throw new Error('The selected window is not owned by this pid on the current Space. Refresh list_windows and capture the explicit window.')
  }
  if (x2 > snapshot.width || y2 > snapshot.height) {
    throw new Error('Zoom region is outside this window snapshot. Take a fresh get_window_state for the same window.')
  }
  const native = await readImage(await call('screenshot', {
    window_id: windowId,
    ...(contract.acceptsFormat ? { format: 'png' } : {}),
    ...(contract.requiresPid ? { pid } : {}),
  }))
  // Captures can race a resize. Do not crop a different window aspect ratio.
  if (Math.abs(native.width / native.height - snapshot.width / snapshot.height) >
      2 / snapshot.height) {
    throw new Error('Window dimensions changed during zoom. Take a fresh get_window_state and retry.')
  }
  const ratioX = native.width / snapshot.width
  const ratioY = native.height / snapshot.height
  const padX = (x2 - x1) * 0.2
  const padY = (y2 - y1) * 0.2
  const left = Math.max(0, Math.floor((x1 - padX) * ratioX))
  const top = Math.max(0, Math.floor((y1 - padY) * ratioY))
  const right = Math.min(native.width, Math.ceil((x2 + padX) * ratioX))
  const bottom = Math.min(native.height, Math.ceil((y2 + padY) * ratioY))
  const sharp = await getImageProcessor()
  const cropped = await sharp(native.bytes).extract({
    left, top, width: right - left, height: bottom - top,
  }).png().toBuffer()
  return {
    content: [
      {
        type: 'text',
        text: `Window ${windowId} of pid ${pid}. Native crop ${right - left}x${bottom - top}, origin (${left}, ${top}) in the ${native.width}x${native.height} native capture. For actions, take a fresh get_window_state and use its normal coordinates with from_zoom=false.`,
      },
      { type: 'image', data: cropped.toString('base64'), mimeType: 'image/png' },
    ],
    structuredContent: {
      pid, window_id: windowId,
      crop: { left, top, width: right - left, height: bottom - top },
      snapshot: { width: snapshot.width, height: snapshot.height },
      native: { width: native.width, height: native.height },
      from_zoom: false,
    },
  }
}
