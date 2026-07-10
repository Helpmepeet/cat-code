import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, extname, isAbsolute, join, relative } from 'path'
import React from 'react'
import { z } from 'zod/v4'
import { FilePathLink } from '../../components/FilePathLink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import { getSessionId } from '../../bootstrap/state.js'
import { resolveCodexOAuthTokensForLeaseOwner } from '../../services/api/client.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { PNG } from 'pngjs'
import promptingGuideText from './PROMPTING_GUIDE.md' with { type: 'text' }
import { getXDGDataHome } from '../../utils/xdg.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { expandPath } from '../../utils/path.js'
import { checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatFileSize } from '../../utils/format.js'

const GENERATE_IMAGE_TOOL_NAME = 'GenerateImage'
const OPENAI_IMAGES_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations'
const CODEX_IMAGE_GENERATIONS_URL = 'https://chatgpt.com/backend-api/codex/responses'
const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
const DEFAULT_CODEX_RESPONSE_MODEL = 'gpt-5.6-terra'
const CODEX_IMAGE_GENERATION_INSTRUCTIONS =
  'Generate the requested image using the image_generation tool.'
const TERMINAL_PREVIEW_WIDTH_COLUMNS = 48
const TERMINAL_PREVIEW_HEIGHT_ROWS = 16
const DEFAULT_GENERATED_IMAGE_DIR = 'generated-images'
const ITERM2_FILE_PART_CHARS = 1_000_000

const outputFormats = ['png', 'jpeg', 'webp'] as const
type OutputFormat = (typeof outputFormats)[number]

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z.string().min(1).describe('The image prompt to generate from'),
    output_path: z
      .string()
      .optional()
      .describe(
        'Absolute path where the generated image should be saved. Defaults to the Cat Code config generated-images directory.',
      ),
    reference_image_path: z
      .string()
      .optional()
      .describe(
        'Optional local image path to use as a visual reference for the generated image. Supported formats: .png, .jpg/.jpeg, and .webp.',
      ),
    model: z
      .enum(['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'])
      .optional()
      .describe('GPT image model to use. Defaults to gpt-image-2.'),
    size: z
      .enum(['1024x1024', '1536x1024', '1024x1536', 'auto'])
      .optional()
      .describe('Generated image size. Defaults to 1024x1024.'),
    quality: z
      .enum(['low', 'medium', 'high', 'auto'])
      .optional()
      .describe('Generated image quality. Defaults to auto.'),
    background: z
      .enum(['transparent', 'opaque', 'auto'])
      .optional()
      .describe('Background handling for GPT image models. Defaults to auto.'),
    output_format: z
      .enum(outputFormats)
      .optional()
      .describe('Image file format. Defaults to the output_path extension.'),
    output_compression: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'Output compression level from 0 to 100 for jpeg and webp output formats. Ignored for PNG.',
      ),
    action: z
      .enum(['auto', 'generate', 'edit'])
      .optional()
      .describe(
        'Controls whether the model generates a new image or edits an existing one. Defaults to auto, or edit when reference_image_path is set.',
      ),
    input_fidelity: z
      .enum(['high', 'low'])
      .optional()
      .describe(
        'Reference image fidelity to use when a reference_image_path is provided.',
      ),
    moderation: z
      .enum(['low', 'auto'])
      .optional()
      .describe('Content moderation level. Defaults to auto.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Set true to overwrite an existing output file.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('Path where the generated image was saved'),
    model: z.string().describe('OpenAI image model used'),
    size: z.string().describe('Requested image size'),
    outputFormat: z.enum(outputFormats).describe('Image format written'),
    bytes: z.number().describe('Number of bytes written'),
    revisedPrompt: z.string().optional().describe('Revised prompt returned by the API'),
    usage: z.unknown().optional().describe('Token usage returned by the API'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

type ImageGenerationResponse = {
  data?: Array<{
    b64_json?: string
    revised_prompt?: string
    url?: string
  }>
  usage?: unknown
}

type ImageAuth = {
  token: string
  accountId?: string
  backend: 'openai-api' | 'codex'
}

type ReferenceImage = {
  imageUrl: string
}

type CollectedImage = {
  final?: string
  partial?: string
}

type TerminalImagePreview =
  | { kind: 'ansi'; lines: string[]; width: number }
  | { kind: 'iterm2'; sequence: string; cellHeight: number; width: number }

const terminalPreviewCache = new Map<string, Promise<TerminalImagePreview | null>>()

function normalizeOutputPath(outputPath: string): string {
  return expandPath(outputPath)
}

// Materializes the GPT Image 2 prompting guide to a stable on-disk path so
// the model can opt in via Read only when the user asks for a prompt rewrite.
// Embedding the guide directly in the tool prompt would inject it into the
// model's context every turn — defeating the gating goal.
let promptingGuidePromise: Promise<string> | null = null
async function ensurePromptingGuideOnDisk(): Promise<string> {
  if (promptingGuidePromise) return promptingGuidePromise
  promptingGuidePromise = (async () => {
    const dir = join(getXDGDataHome(), 'cat-code')
    const path = join(dir, 'gpt-image-2-prompting-guide.md')
    try {
      const existing = await readFile(path, 'utf8')
      if (existing === promptingGuideText) return path
    } catch (e) {
      if (!isENOENT(e)) throw e
    }
    await mkdir(dir, { recursive: true })
    await writeFile(path, promptingGuideText, 'utf8')
    return path
  })()
  return promptingGuidePromise
}

function slugifyImagePrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'image'
}

function getDefaultOutputPath(input: Input): string {
  const outputFormat = input.output_format ?? 'png'
  const extension = outputFormat === 'jpeg' ? 'jpg' : outputFormat
  const timestamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '-')
  return join(
    getClaudeConfigHomeDir(),
    DEFAULT_GENERATED_IMAGE_DIR,
    `${timestamp}-${slugifyImagePrompt(input.prompt)}-${randomUUID().slice(0, 8)}.${extension}`,
  )
}

function isDefaultGeneratedImagePath(outputPath: string): boolean {
  const artifactDir = normalizeOutputPath(
    join(getClaudeConfigHomeDir(), DEFAULT_GENERATED_IMAGE_DIR),
  )
  const normalizedOutputPath = normalizeOutputPath(outputPath)
  const relativePath = relative(artifactDir, normalizedOutputPath)
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath)
  )
}

function ensureOutputPath(input: Input): string {
  input.output_path = normalizeOutputPath(input.output_path ?? getDefaultOutputPath(input))
  return input.output_path
}

function normalizeReferenceImagePath(input: Input): string | undefined {
  if (!input.reference_image_path) return undefined
  input.reference_image_path = normalizeOutputPath(input.reference_image_path)
  return input.reference_image_path
}

function getDisplayOutputPath(outputPath: string): string {
  return getDisplayPath(normalizeOutputPath(outputPath))
}

function getImageMediaType(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase()
  switch (extension) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      return null
  }
}

function extractImageBase64FromString(value: string): string | undefined {
  const dataUrlMatch = value.match(
    /^data:image\/(?:png|jpe?g|webp);base64,([a-zA-Z0-9+/=]+)$/i,
  )
  return dataUrlMatch?.[1]
}

function getOutputFormat(input: Input): OutputFormat | null {
  if (input.output_format) return input.output_format
  const extension = extname(ensureOutputPath(input)).toLowerCase().slice(1)
  if (extension === 'jpg') return 'jpeg'
  return outputFormats.includes(extension as OutputFormat)
    ? (extension as OutputFormat)
    : null
}

// Box-filter downscale: each destination pixel averages the rectangle of
// source pixels it covers. Far higher fidelity than nearest-neighbor when
// shrinking by a large factor (e.g. 1024px → 32px), at the same O(srcW*srcH)
// cost. Falls back to nearest-neighbor for any axis being upscaled, which we
// never hit in the preview path (withoutEnlargement semantics).
function resampleArea(
  src: Buffer,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Buffer {
  const dst = Buffer.alloc(dstWidth * dstHeight * 4)
  const xRatio = srcWidth / dstWidth
  const yRatio = srcHeight / dstHeight
  for (let y = 0; y < dstHeight; y++) {
    const y0 = Math.floor(y * yRatio)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio))
    for (let x = 0; x < dstWidth; x++) {
      const x0 = Math.floor(x * xRatio)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = y0; sy < y1 && sy < srcHeight; sy++) {
        for (let sx = x0; sx < x1 && sx < srcWidth; sx++) {
          const o = (sy * srcWidth + sx) * 4
          r += src[o] ?? 0
          g += src[o + 1] ?? 0
          b += src[o + 2] ?? 0
          a += src[o + 3] ?? 255
          count++
        }
      }
      const dstOffset = (y * dstWidth + x) * 4
      dst[dstOffset] = Math.round(r / count)
      dst[dstOffset + 1] = Math.round(g / count)
      dst[dstOffset + 2] = Math.round(b / count)
      dst[dstOffset + 3] = Math.round(a / count)
    }
  }
  return dst
}

function blendOnBackground(
  red: number,
  green: number,
  blue: number,
  alpha: number,
): [number, number, number] {
  if (alpha >= 255) return [red, green, blue]
  const background = 24
  const opacity = alpha / 255
  return [
    Math.round(red * opacity + background * (1 - opacity)),
    Math.round(green * opacity + background * (1 - opacity)),
    Math.round(blue * opacity + background * (1 - opacity)),
  ]
}

// Decodes only PNG. JPEG/WebP previews are skipped (return null) — the file
// link is still shown. PNG is the default output format for GenerateImage.
async function buildTerminalImagePreview(
  filePath: string,
  width: number = TERMINAL_PREVIEW_WIDTH_COLUMNS,
): Promise<TerminalImagePreview | null> {
  if (extname(filePath).toLowerCase() !== '.png') return null

  const imageBuffer = await readFile(filePath)

  if (supportsIterm2InlineImages()) {
    // ~16 rows is a comfortable preview block, matches the half-block path.
    const heightCells = TERMINAL_PREVIEW_HEIGHT_ROWS
    return buildIterm2InlineImage(imageBuffer, filePath, width, heightCells)
  }

  const decoded = PNG.sync.read(imageBuffer)
  if (decoded.width < 1 || decoded.height < 1) return null

  const maxWidth = width
  const maxHeight = TERMINAL_PREVIEW_HEIGHT_ROWS * 2
  const scale = Math.min(
    1,
    maxWidth / decoded.width,
    maxHeight / decoded.height,
  )
  const targetWidth = Math.max(1, Math.floor(decoded.width * scale))
  const targetHeight = Math.max(1, Math.floor(decoded.height * scale))
  const channels = 4
  const data = resampleArea(
    decoded.data,
    decoded.width,
    decoded.height,
    targetWidth,
    targetHeight,
  )
  const info = { width: targetWidth, height: targetHeight, channels }

  const lines: string[] = []
  for (let y = 0; y < info.height; y += 2) {
    let line = ''
    for (let x = 0; x < info.width; x++) {
      const topOffset = (y * info.width + x) * info.channels
      const bottomOffset =
        (Math.min(y + 1, info.height - 1) * info.width + x) * info.channels
      const [topRed, topGreen, topBlue] = blendOnBackground(
        data[topOffset] ?? 0,
        data[topOffset + 1] ?? 0,
        data[topOffset + 2] ?? 0,
        data[topOffset + 3] ?? 255,
      )
      const [bottomRed, bottomGreen, bottomBlue] = blendOnBackground(
        data[bottomOffset] ?? 0,
        data[bottomOffset + 1] ?? 0,
        data[bottomOffset + 2] ?? 0,
        data[bottomOffset + 3] ?? 255,
      )
      line += `\x1b[38;2;${topRed};${topGreen};${topBlue}m\x1b[48;2;${bottomRed};${bottomGreen};${bottomBlue}m▀`
    }
    lines.push(`${line}\x1b[0m`)
  }

  return { kind: 'ansi', lines, width: info.width }
}

// iTerm2 inline image protocol (OSC 1337). The image is base64-encoded and
// the terminal renders it natively at the requested cell dimensions. We size
// it in cells so layout is predictable; the terminal scales the bitmap to fit.
// https://iterm2.com/documentation-images.html
function supportsIterm2InlineImages(): boolean {
  if (!process.stdout.isTTY) return false
  if (process.env.TERM_PROGRAM === 'iTerm.app') return true
  if (process.env.TERM_PROGRAM === 'WezTerm') return true
  if (process.env.LC_TERMINAL === 'iTerm2') return true
  return false
}

function buildIterm2InlineImage(
  imageBuffer: Buffer,
  filePath: string,
  widthCells: number,
  heightCells: number,
): TerminalImagePreview {
  const base64 = imageBuffer.toString('base64')
  const nameB64 = Buffer.from(basename(filePath)).toString('base64')
  const args = [
    `name=${nameB64}`,
    `size=${imageBuffer.length}`,
    `width=${widthCells}`,
    `height=${heightCells}`,
    'preserveAspectRatio=1',
    'inline=1',
    'type=image/png',
  ].join(';')

  const sequences = [`\x1b]1337;MultipartFile=${args}\x07`]
  for (let i = 0; i < base64.length; i += ITERM2_FILE_PART_CHARS) {
    sequences.push(
      `\x1b]1337;FilePart=${base64.slice(i, i + ITERM2_FILE_PART_CHARS)}\x07`,
    )
  }
  sequences.push('\x1b]1337;FileEnd\x07')

  const sequence = process.env.TMUX
    ? sequences.map(seq => `\x1bPtmux;\x1b${seq}\x1b\\`).join('')
    : sequences.join('')

  return {
    kind: 'iterm2',
    sequence,
    cellHeight: heightCells,
    width: widthCells,
  }
}

function getCachedTerminalImagePreview(
  output: Output,
  width: number,
): Promise<TerminalImagePreview | null> {
  const cacheKey = `${output.filePath}:${output.bytes}:${width}`
  let preview = terminalPreviewCache.get(cacheKey)
  if (!preview) {
    preview = buildTerminalImagePreview(output.filePath, width)
    terminalPreviewCache.set(cacheKey, preview)
  }
  return preview
}

function GeneratedImageResult({ output }: { output: Output }): React.ReactNode {
  const displayPath = getDisplayPath(output.filePath)
  const details = `${output.model} · ${output.size} · ${output.outputFormat.toUpperCase()} · ${formatFileSize(output.bytes)}`

  return React.createElement(
    MessageResponse,
    null,
    React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(
        Text,
        null,
        'Generated image: ',
        React.createElement(
          FilePathLink,
          { filePath: output.filePath },
          displayPath,
        ),
      ),
      React.createElement(Text, { dimColor: true }, details),
    ),
  )
}

async function getImageAuth(context: ToolUseContext): Promise<ImageAuth> {
  if (process.env.CAT_CODE_IMAGE_BACKEND === 'openai-api') {
    const apiKey = process.env.OPENAI_API_KEY
    if (apiKey) {
      return { token: apiKey, backend: 'openai-api' }
    }
  }

  // Image requests must resolve Codex auth at request time so subagents use
  // their leased account instead of whatever pool.activeIndex currently points at.
  const codexTokens = await resolveCodexOAuthTokensForLeaseOwner({
    codexLeaseOwnerId: context.agentId ?? getSessionId(),
    codexLeaseOwnerType: context.agentId ? 'subagent' : 'main',
  })
  if (codexTokens?.accessToken) {
    return {
      token: codexTokens.accessToken,
      accountId: codexTokens.accountId,
      backend: 'codex',
    }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey) {
    return { token: apiKey, backend: 'openai-api' }
  }

  throw new Error(
    'No OpenAI credentials found. Set OPENAI_API_KEY or log in to a Codex/OpenAI account.',
  )
}

function parseImageGenerationResponse(text: string): ImageGenerationResponse {
  try {
    return JSON.parse(text) as ImageGenerationResponse
  } catch {
    throw new Error('OpenAI image generation returned invalid JSON.')
  }
}

function getOpenAIErrorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; type?: string; code?: string }
    }
    const message = parsed.error?.message
    const code = parsed.error?.code ?? parsed.error?.type
    if (message && code) return `${message} (${code})`
    if (message) return message
  } catch {
    // Fall through to the raw response text below.
  }
  return text.trim() || `HTTP ${status}`
}

async function loadReferenceImage(input: Input): Promise<ReferenceImage | undefined> {
  const filePath = normalizeReferenceImagePath(input)
  if (!filePath) return undefined

  const mediaType = getImageMediaType(filePath)
  if (!mediaType) {
    throw new Error('reference_image_path must end in .png, .jpg, .jpeg, or .webp.')
  }

  const bytes = await readFile(filePath)
  return {
    imageUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
  }
}

function buildCodexImageGenerationBody(
  input: Input,
  outputFormat: OutputFormat,
  model: string,
  referenceImage?: ReferenceImage,
) {
  const content = [
    {
      type: 'input_text',
      text: input.prompt,
    },
    ...(referenceImage
      ? [
          {
            type: 'input_image',
            image_url: referenceImage.imageUrl,
          },
        ]
      : []),
  ]

  return {
    model,
    instructions: CODEX_IMAGE_GENERATION_INSTRUCTIONS,
    store: false,
    stream: true,
    input: [
      {
        role: 'user',
        content,
      },
    ],
    tools: [
      {
        type: 'image_generation',
        size: input.size ?? '1024x1024',
        quality: input.quality ?? 'auto',
        moderation: input.moderation ?? 'auto',
        output_format: outputFormat,
        action: input.action ?? (input.reference_image_path ? 'edit' : 'auto'),
        ...(input.output_compression !== undefined
          ? { output_compression: input.output_compression }
          : {}),
        ...(input.input_fidelity ? { input_fidelity: input.input_fidelity } : {}),
        ...(input.background ? { background: input.background } : {}),
      },
    ],
    tool_choice: 'required',
    parallel_tool_calls: false,
  }
}

function collectImageBase64(value: unknown): CollectedImage {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : undefined
  let result: CollectedImage = {}

  if (
    (type === 'image_generation_call' ||
      type === 'response.image_generation_call.completed') &&
    typeof record.result === 'string'
  ) {
    result.final = extractImageBase64FromString(record.result) ?? record.result
  }

  if (typeof record.b64_json === 'string') {
    result.final = record.b64_json
  }

  for (const key of [
    'base64',
    'image_base64',
    'image_b64',
    'image_url',
    'url',
  ]) {
    const stringValue = record[key]
    if (typeof stringValue === 'string') {
      const imageBase64 = extractImageBase64FromString(stringValue)
      if (imageBase64) result.final = imageBase64
    }
  }

  if (typeof record.partial_image_b64 === 'string') {
    result.partial = record.partial_image_b64
  }

  for (const child of Object.values(record)) {
    if (!child || typeof child !== 'object') continue
    const childResult = Array.isArray(child)
      ? child.reduce<CollectedImage>((acc, item) => {
          const nested = collectImageBase64(item)
          return {
            final: nested.final ?? acc.final,
            partial: nested.partial ?? acc.partial,
          }
        }, {})
      : collectImageBase64(child)
    result = {
      final: childResult.final ?? result.final,
      partial: childResult.partial ?? result.partial,
    }
  }

  return result
}

function summarizeCodexImageResponse(text: string): string {
  const eventTypes = new Set<string>()
  const itemTypes = new Set<string>()
  const responseStatuses = new Set<string>()
  const outputText: string[] = []

  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }

    const record = value as Record<string, unknown>
    if (typeof record.type === 'string') eventTypes.add(record.type)
    if (typeof record.status === 'string') responseStatuses.add(record.status)
    const item = record.item
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const itemType = (item as Record<string, unknown>).type
      if (typeof itemType === 'string') itemTypes.add(itemType)
    }
    if (typeof record.text === 'string' && outputText.length < 2) {
      outputText.push(record.text.slice(0, 160))
    }

    for (const child of Object.values(record)) visit(child)
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data: ')) continue
    const data = trimmed.slice(6)
    if (!data || data === '[DONE]') continue
    try {
      visit(JSON.parse(data) as unknown)
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }

  if (eventTypes.size === 0) {
    try {
      visit(JSON.parse(text) as unknown)
    } catch {
      // Ignore; length still helps distinguish an empty response.
    }
  }

  const parts = [
    `bytes=${text.length}`,
    eventTypes.size ? `events=${[...eventTypes].slice(0, 8).join(',')}` : null,
    itemTypes.size ? `items=${[...itemTypes].slice(0, 8).join(',')}` : null,
    responseStatuses.size
      ? `statuses=${[...responseStatuses].slice(0, 8).join(',')}`
      : null,
    outputText.length ? `text=${JSON.stringify(outputText.join(' | '))}` : null,
  ].filter(Boolean)

  return parts.join(' ')
}

function parseCodexImageGenerationResponse(text: string): string {
  let image: CollectedImage = {}

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data: ')) continue
    const data = trimmed.slice(6)
    if (!data || data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data) as unknown
      const found = collectImageBase64(parsed)
      image = {
        final: found.final ?? image.final,
        partial: found.partial ?? image.partial,
      }
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }

  if (!image.final && !image.partial) {
    try {
      image = collectImageBase64(JSON.parse(text) as unknown)
    } catch {
      // Fall through to the error below.
    }
  }

  const b64 = image.final ?? image.partial
  if (!b64) {
    throw new Error(
      `Codex image generation did not return base64 image data (${summarizeCodexImageResponse(text)}).`,
    )
  }
  return b64
}

async function generateWithOpenAIImagesAPI(
  input: Input,
  outputFormat: OutputFormat,
  signal: AbortSignal,
  auth: ImageAuth,
): Promise<{ b64: string; usage?: unknown; revisedPrompt?: string; model: string }> {
  const model = input.model ?? DEFAULT_IMAGE_MODEL
  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    size: input.size ?? '1024x1024',
    quality: input.quality ?? 'auto',
    background: input.background ?? 'auto',
    output_format: outputFormat,
    moderation: input.moderation ?? 'auto',
  }

  const response = await fetch(OPENAI_IMAGES_GENERATIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  const responseText = await response.text()

  if (!response.ok) {
    throw new Error(
      `OpenAI image generation failed (${response.status}): ${getOpenAIErrorMessage(response.status, responseText)}`,
    )
  }

  const parsed = parseImageGenerationResponse(responseText)
  const image = parsed.data?.[0]
  if (!image?.b64_json) {
    throw new Error('OpenAI image generation did not return base64 image data.')
  }

  return {
    b64: image.b64_json,
    model,
    ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  }
}

async function generateWithCodexBackend(
  input: Input,
  outputFormat: OutputFormat,
  auth: ImageAuth,
  responseModel: string,
  signal: AbortSignal,
): Promise<{ b64: string; model: string }> {
  if (!auth.accountId) {
    throw new Error('Codex image generation requires a ChatGPT account ID.')
  }

  const referenceImage = await loadReferenceImage(input)
  const conversationId = randomUUID()
  const response = await fetch(CODEX_IMAGE_GENERATIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'chatgpt-account-id': auth.accountId,
      originator: 'codex_cli_rs',
      'conversation-id': conversationId,
      session_id: conversationId,
      'x-client-request-id': conversationId,
      'OpenAI-Beta': 'responses=experimental',
    },
    body: JSON.stringify(
      buildCodexImageGenerationBody(
        input,
        outputFormat,
        responseModel,
        referenceImage,
      ),
    ),
    signal,
  })
  const responseText = await response.text()

  if (!response.ok) {
    throw new Error(
      `Codex image generation failed (${response.status}): ${getOpenAIErrorMessage(response.status, responseText)}`,
    )
  }

  return {
    b64: parseCodexImageGenerationResponse(responseText),
    model: responseModel,
  }
}

export const GenerateImageTool = buildTool({
  name: GENERATE_IMAGE_TOOL_NAME,
  searchHint: 'generate images with GPT',
  maxResultSizeChars: 20_000,
  strict: true,
  async description(input) {
    const destination = input.output_path
      ? getDisplayOutputPath(input.output_path)
      : getDisplayOutputPath(
          join(getClaudeConfigHomeDir(), DEFAULT_GENERATED_IMAGE_DIR),
        )
    const reference = input.reference_image_path
      ? ` using reference ${getDisplayPath(normalizeOutputPath(input.reference_image_path))}`
      : ''
    return `Generate an image with OpenAI GPT image generation${reference} and save it to ${destination}`
  },
  userFacingName() {
    return 'Generate Image'
  },
  getToolUseSummary(input) {
    return input?.output_path ? getDisplayOutputPath(input.output_path) : null
  },
  getActivityDescription(input) {
    return input?.output_path
      ? `Generating image at ${getDisplayOutputPath(input.output_path)}`
      : 'Generating image'
  },
  async prompt() {
    const guidePath = await ensurePromptingGuideOnDisk()
    return `Generate an image and save it to a local file.

Use this when the user asks to create or generate an image.

Rules:
- Pass the user's requested image prompt exactly as prompt. Do not rewrite, expand, stylize, or add details unless the user explicitly asks you to.
- Omit output_path unless the user asks for a specific save location; Cat Code will save to ~/.cat-code/generated-images by default.
- If the user references an existing image, pass its local path as reference_image_path. This uploads the image to the image-generation backend.
- Use .png unless the user asks for another supported format.
- Do not overwrite existing files unless the user explicitly asks to replace them.

Prompt rewriting:
- Only when the user explicitly asks you to rewrite, improve, expand, or polish the image prompt, first Read this file for guidance on structuring GPT Image 2 prompts: ${guidePath}
- Treat the guide as a guideline, not a strict template — adapt to the user's request.
- Do NOT Read the guide for normal pass-through generations.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  backfillObservableInput(input) {
    if (typeof input.output_path === 'string') {
      input.output_path = normalizeOutputPath(input.output_path)
    }
    if (typeof input.reference_image_path === 'string') {
      input.reference_image_path = normalizeOutputPath(input.reference_image_path)
    }
  },
  getPath(input): string {
    return ensureOutputPath(input)
  },
  isDestructive(input) {
    return input.overwrite === true
  },
  toAutoClassifierInput(input) {
    const destination =
      input.output_path ??
      join(getClaudeConfigHomeDir(), DEFAULT_GENERATED_IMAGE_DIR)
    const reference = input.reference_image_path
      ? ` reference=${normalizeOutputPath(input.reference_image_path)}`
      : ''
    return `${destination}${reference}: ${input.prompt}`
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const outputPath = ensureOutputPath(input)
    if (isDefaultGeneratedImagePath(outputPath)) {
      return {
        behavior: 'allow',
        updatedInput: input,
      }
    }

    return checkWritePermissionForTool(
      GenerateImageTool,
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  renderToolUseMessage(input) {
    const referencePath = input.reference_image_path
      ? normalizeOutputPath(input.reference_image_path)
      : undefined
    if (input.output_path) {
      const filePath = normalizeOutputPath(input.output_path)
      return React.createElement(
        React.Fragment,
        null,
        'Generate image at ',
        React.createElement(
          FilePathLink,
          { filePath },
          getDisplayPath(filePath),
        ),
        referencePath
          ? React.createElement(
              React.Fragment,
              null,
              ' using reference ',
              React.createElement(
                FilePathLink,
                { filePath: referencePath },
                getDisplayPath(referencePath),
              ),
            )
          : null,
      )
    }
    const promptPreview = input.prompt
      ? input.prompt.length > 80
        ? `${input.prompt.slice(0, 80).trim()}…`
        : input.prompt
      : null
    if (referencePath) {
      return React.createElement(
        React.Fragment,
        null,
        'Generate image using reference ',
        React.createElement(
          FilePathLink,
          { filePath: referencePath },
          getDisplayPath(referencePath),
        ),
        promptPreview ? `: ${promptPreview}` : '',
      )
    }
    return promptPreview
      ? `Generate image: ${promptPreview}`
      : 'Generate image'
  },
  renderToolResultMessage(output) {
    return React.createElement(GeneratedImageResult, {
      output,
    })
  },
  async validateInput(input) {
    const filePath = ensureOutputPath(input)
    if (!isAbsolute(filePath)) {
      return {
        result: false,
        message: 'output_path must be an absolute path.',
        errorCode: 1,
      }
    }

    const outputFormat = getOutputFormat(input)
    if (!outputFormat) {
      return {
        result: false,
        message: 'output_path must end in .png, .jpg, .jpeg, or .webp.',
        errorCode: 2,
      }
    }

    if (input.background === 'transparent' && outputFormat === 'jpeg') {
      return {
        result: false,
        message: 'Transparent backgrounds require png or webp output.',
        errorCode: 3,
      }
    }

    if (input.output_compression !== undefined && outputFormat === 'png') {
      return {
        result: false,
        message: 'output_compression is only supported for jpeg and webp output.',
        errorCode: 8,
      }
    }

    const referenceImagePath = normalizeReferenceImagePath(input)
    if (referenceImagePath) {
      if (!isAbsolute(referenceImagePath)) {
        return {
          result: false,
          message: 'reference_image_path must be an absolute path.',
          errorCode: 5,
        }
      }
      if (!getImageMediaType(referenceImagePath)) {
        return {
          result: false,
          message: 'reference_image_path must end in .png, .jpg, .jpeg, or .webp.',
          errorCode: 6,
        }
      }
      try {
        await stat(referenceImagePath)
      } catch (error) {
        if (isENOENT(error)) {
          return {
            result: false,
            message: 'reference_image_path does not exist.',
            errorCode: 7,
          }
        }
        throw error
      }
    }

    if (!input.overwrite) {
      try {
        await stat(filePath)
        return {
          result: false,
          message: 'output_path already exists. Set overwrite to true to replace it.',
          errorCode: 4,
        }
      } catch (error) {
        if (!isENOENT(error)) throw error
      }
    }

    return { result: true }
  },
  async call(input, context: ToolUseContext) {
    const filePath = ensureOutputPath(input)
    const outputFormat = getOutputFormat(input)
    if (!outputFormat) {
      throw new Error('output_path must end in .png, .jpg, .jpeg, or .webp.')
    }

    const size = input.size ?? '1024x1024'
    const auth = await getImageAuth(context)
    if (auth.backend === 'openai-api' && input.reference_image_path) {
      throw new Error('Reference images require a Codex/ChatGPT account.')
    }
    const generation =
      auth.backend === 'openai-api'
        ? await generateWithOpenAIImagesAPI(
            input,
            outputFormat,
            context.abortController.signal,
            auth,
          )
        : await generateWithCodexBackend(
            input,
            outputFormat,
            auth,
            context.options?.mainLoopModel ?? DEFAULT_CODEX_RESPONSE_MODEL,
            context.abortController.signal,
          )

    const bytes = Buffer.from(generation.b64, 'base64')
    if (bytes.length === 0) {
      throw new Error('OpenAI image generation returned an empty image.')
    }

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, bytes)

    return {
      data: {
        filePath,
        model: generation.model,
        size,
        outputFormat,
        bytes: bytes.length,
        ...(generation.revisedPrompt ? { revisedPrompt: generation.revisedPrompt } : {}),
        ...(generation.usage ? { usage: generation.usage } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `Generated image: ${output.filePath}`,
      `Model: ${output.model}`,
      `Size: ${output.size}`,
      `Format: ${output.outputFormat}`,
      `Bytes: ${output.bytes}`,
    ]
    if (output.revisedPrompt) {
      lines.push(`Revised prompt: ${output.revisedPrompt}`)
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
  extractSearchText(output) {
    return [
      `Generated image: ${output.filePath}`,
      `${output.model} · ${output.size} · ${output.outputFormat.toUpperCase()} · ${formatFileSize(output.bytes)}`,
    ].join('\n')
  },
} satisfies ToolDef<InputSchema, Output>)

export const _generateImageToolInternalsForTest = {
  buildTerminalImagePreview,
  buildIterm2InlineImage,
  buildCodexImageGenerationBody,
  parseCodexImageGenerationResponse,
}
