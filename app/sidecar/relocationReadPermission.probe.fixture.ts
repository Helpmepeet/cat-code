/** Isolated probe of the engine's actual FileRead permission decision. */
import { switchSession } from '../../src/bootstrap/state.js'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import { asSessionId } from '../../src/types/ids.js'
import { checkReadPermissionForTool } from '../../src/utils/permissions/filesystem.js'

const [sessionId, filePath, deniedPath] = process.argv.slice(2)
if (!sessionId || !filePath) throw new Error('usage: <sessionId> <filePath> [deniedPath]')

// The bundled build defines this macro. The probe runs source directly.
;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO = {
  VERSION: 'relocation-probe',
}
switchSession(asSessionId(sessionId))
const context = getEmptyToolPermissionContext()
const result = checkReadPermissionForTool(
  FileReadTool,
  { file_path: filePath },
  deniedPath
    ? {
        ...context,
        alwaysDenyRules: { userSettings: [`Read(/${deniedPath}/**)`] },
      }
    : context,
)
process.stdout.write(`READ_PERMISSION=${result.behavior}\n`)
await new Promise<void>(resolve => {
  if (process.stdout.write('')) resolve()
  else process.stdout.once('drain', resolve)
})
process.exit(0)
