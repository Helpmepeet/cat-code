import type { Buffer } from 'buffer'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isInBundledMode } from '../../utils/bundledMode.js'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  extract(region: { left: number; top: number; width: number; height: number }): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  const imported = await loadSharp<SharpFunction>()
  const sharp = unwrapDefault(imported)
  imageProcessorModule = { default: sharp }
  return sharp
}

/**
 * Get image creator for generating new images from scratch.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  const imported = await loadSharp<SharpCreator>()
  const sharp = unwrapDefault(imported)
  imageCreatorModule = { default: sharp }
  return sharp
}

// Dynamic import shape varies by module interop mode — ESM yields { default: fn }, CJS yields fn directly.
type MaybeDefault<T> = T | { default: T }

async function loadSharp<T>(): Promise<MaybeDefault<T>> {
  if (isInBundledMode()) {
    // Sharp's dynamic addon lookup cannot be embedded by Bun's compiler.
    // Resolve only the build-owned companion, never cwd or a global package.
    const path = join(dirname(process.execPath), 'image-runtime', 'sharp.cjs')
    return createRequire(process.execPath)(path) as MaybeDefault<T>
  }
  return (await import('sharp')) as unknown as MaybeDefault<T>
}

function unwrapDefault<T extends (...args: never[]) => unknown>(
  mod: MaybeDefault<T>,
): T {
  return typeof mod === 'function' ? mod : mod.default
}
