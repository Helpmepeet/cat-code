import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertMacOSDeploymentTarget, verifyMacOSCompatibility } from './macosCompatibility.js'

function commands(version: string, command = 'LC_BUILD_VERSION'): string {
  return `Load command 0
      cmd ${command}
  cmdsize 32
 platform 1
    ${command === 'LC_BUILD_VERSION' ? 'minos' : 'version'} ${version}
      sdk 26.5
Load command 1
      cmd LC_ID_DYLIB
  current version 99.0.0
`
}

test('accepts older and equal macOS deployment targets without treating SDK or dylib versions as OS requirements', () => {
  for (const version of ['11.0', '12.6', '13.0', '13.0.0']) {
    expect(() => assertMacOSDeploymentTarget(commands(version), 'native-image')).not.toThrow()
  }
  expect(() => assertMacOSDeploymentTarget(commands('10.15', 'LC_VERSION_MIN_MACOSX'), 'legacy-image')).not.toThrow()
})

test('rejects a newer major, minor, or patch OS requirement', () => {
  for (const version of ['26.0', '14.0', '13.1', '13.0.1']) {
    expect(() => assertMacOSDeploymentTarget(commands(version), 'helper')).toThrow(`helper requires macOS ${version}`)
  }
})

test('fails closed when native image metadata is absent or incomplete', () => {
  expect(() => assertMacOSDeploymentTarget('', 'missing-image')).toThrow('Missing macOS deployment target')
  expect(() => assertMacOSDeploymentTarget('Load command 0\ncmd LC_BUILD_VERSION\nplatform 1\nsdk 26.5', 'broken-image')).toThrow('Missing macOS deployment target')
})

test('rejects a different Apple platform even with an otherwise compatible version', () => {
  expect(() => assertMacOSDeploymentTarget(commands('13.0').replace('platform 1', 'platform 2'), 'ios-image')).toThrow('Not a macOS native image')
})

test.skipIf(process.platform !== 'darwin')('inspects extensionless ARM64 payloads and rejects a newer native dependency', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'catcode-deployment-target-'))
  // A minimal Mach-O header/load command is sufficient for otool; never execute it.
  const image = (major: number) => {
    const bytes = Buffer.alloc(56)
    const words = [0xfeedfacf, 0x0100000c, 0, 2, 1, 24, 0, 0, 0x32, 24, 1, major << 16, 0, 0]
    words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4))
    return bytes
  }
  try {
    writeFileSync(join(scratch, 'Electron Helper (Renderer)'), image(13))
    writeFileSync(join(scratch, 'notes.txt'), 'not a native image')
    expect(verifyMacOSCompatibility(scratch)).toBe(1)
    writeFileSync(join(scratch, 'helper'), image(26))
    expect(() => verifyMacOSCompatibility(scratch)).toThrow('requires macOS 26.0')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
