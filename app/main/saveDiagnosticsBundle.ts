import { writeFile } from 'node:fs/promises'
import type { SaveDiagnosticsResult } from '../shared/protocol.js'
import { buildDiagnosticsBundle } from './diagnosticsBundle.js'

/** The destination stays in main; neither paths nor raw errors cross the bridge. */
export async function saveDiagnosticsBundle({
  chooseDestination,
  bundleOptions,
  onFailure,
}: {
  chooseDestination: () => Promise<{ canceled: boolean; filePath?: string }>
  bundleOptions: Parameters<typeof buildDiagnosticsBundle>[0]
  onFailure: (error: unknown) => void
}): Promise<SaveDiagnosticsResult> {
  try {
    const destination = await chooseDestination()
    if (destination.canceled) return 'cancelled'
    if (!destination.filePath) return 'failed'
    await writeFile(destination.filePath, buildDiagnosticsBundle(bundleOptions), 'utf8')
    return 'saved'
  } catch (error) {
    onFailure(error)
    return 'failed'
  }
}
