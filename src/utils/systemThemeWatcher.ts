import type { TerminalQuerier } from '../ink/terminal-querier.js'
import { oscColor } from '../ink/terminal-querier.js'
import {
  setCachedSystemTheme,
  themeFromOscColor,
  type SystemTheme,
} from './systemTheme.js'

export function watchSystemTheme(
  querier: TerminalQuerier,
  onThemeChange: (theme: SystemTheme) => void,
): () => void {
  let disposed = false

  const poll = async (): Promise<void> => {
    const response = await querier.send(oscColor(11))
    await querier.flush()

    if (disposed || !response) {
      return
    }

    const theme = themeFromOscColor(response.data)
    if (!theme) {
      return
    }

    setCachedSystemTheme(theme)
    onThemeChange(theme)
  }

  void poll()

  return () => {
    disposed = true
  }
}
