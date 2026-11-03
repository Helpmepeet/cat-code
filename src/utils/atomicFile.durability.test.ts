import { expect, spyOn, test } from 'bun:test'
import * as fs from 'fs'
import * as promises from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AtomicWriteDurabilityUncertainError,
  writeFileAtomicDurable,
  writeFileAtomicDurableSync,
  writeFileAtomicDurableIfAbsent,
  writeFileAtomicDurableIfContentMatches,
} from './atomicFile.js'

const writers = {
  async: writeFileAtomicDurable,
  sync: writeFileAtomicDurableSync,
  absent: writeFileAtomicDurableIfAbsent,
  matching: (path: string, content: string) =>
    writeFileAtomicDurableIfContentMatches(path, 'old', content),
}

for (const [name, write] of Object.entries(writers)) {
  for (const code of ['EIO', 'EACCES', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
    test(`${name} directory sync ${code} preserves publication and classifies durability`, async () => {
      const directory = await promises.mkdtemp(join(tmpdir(), 'atomic-durability-'))
      const destination = join(directory, 'tokens.json')
      if (name !== 'absent') await promises.writeFile(destination, 'old')
      const failure = Object.assign(new Error(`directory fsync ${code}`), { code })
      const originalOpen = promises.open
      const originalSync = fs.fsyncSync
      let directoryClosed = false
      const syncSpy = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
        if (fs.fstatSync(fd).isDirectory()) throw failure
        originalSync(fd)
      })
      const openSpy = spyOn(promises, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args)
        if (String(args[0]) === directory) {
          const close = handle.close.bind(handle)
          handle.sync = async () => {
            throw failure
          }
          handle.close = async () => {
            directoryClosed = true
            await close()
          }
        }
        return handle
      })
      try {
        let caught: unknown
        try {
          await write(destination, 'new')
        } catch (error) {
          caught = error
        }
        if (code === 'EIO' || code === 'EACCES') {
          expect(caught).toBeInstanceOf(AtomicWriteDurabilityUncertainError)
          const error = caught as AtomicWriteDurabilityUncertainError
          expect(error.code).toBe('ATOMIC_WRITE_DURABILITY_UNCERTAIN')
          expect(error.published).toBe(true)
          expect(error.destination).toBe(destination)
          expect(error.cause).toBe(failure)
        } else {
          expect(caught).toBeUndefined()
        }
        expect(await promises.readFile(destination, 'utf8')).toBe('new')
        expect(await promises.readdir(directory)).toEqual(['tokens.json'])
        if (name !== 'sync') expect(directoryClosed).toBe(true)
      } finally {
        openSpy.mockRestore()
        syncSpy.mockRestore()
        await promises.rm(directory, { recursive: true, force: true })
      }
    })
  }
}
