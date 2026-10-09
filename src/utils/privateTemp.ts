import { randomUUID } from 'crypto'
import { chmod, mkdtemp, open, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

export async function createPrivateTempFile(
  prefix: string,
  extension: string,
  baseDir: string = tmpdir(),
): Promise<string> {
  const directory = await mkdtemp(join(baseDir, prefix))
  try {
    if (process.platform !== 'win32') {
      await chmod(directory, 0o700)
    }
    const filePath = join(directory, `${randomUUID()}${extension}`)
    const file = await open(filePath, 'wx', 0o600)
    await file.close()
    return filePath
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function writePrivateTempFile(
  content: string | Uint8Array,
  prefix: string,
  extension: string,
  baseDir: string = tmpdir(),
): Promise<string> {
  const directory = await mkdtemp(join(baseDir, prefix))
  try {
    if (process.platform !== 'win32') {
      await chmod(directory, 0o700)
    }
    const filePath = join(directory, `${randomUUID()}${extension}`)
    const file = await open(filePath, 'wx', 0o600)
    try {
      await file.writeFile(content)
    } finally {
      await file.close()
    }
    return filePath
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function removePrivateTempFile(filePath: string): Promise<void> {
  await rm(dirname(filePath), { recursive: true, force: true })
}
