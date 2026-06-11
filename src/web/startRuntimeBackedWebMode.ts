import chalk from 'chalk'
import type { AppSessionController } from '../app-runtime/AppSessionController.js'
import type { QueryEngineAppSessionConfig } from '../app-runtime/createQueryEngineAppSession.js'
import {
  createRuntimeBackedWebAppSession,
  type RuntimeBackedWebAppSessionOptions,
} from '../app-runtime/createRuntimeBackedWebAppSession.js'
import { startAppSessionWebSocketServer } from './AppSessionWebSocketServer.js'
import {
  launchWebAppDevServer,
  type LaunchedWebAppDevServer,
} from './launchWebAppDevServer.js'

type StartedAppSessionWebSocketServer = Awaited<
  ReturnType<typeof startAppSessionWebSocketServer>
>

export type StartRuntimeBackedWebModeOptions = {
  queryEngineConfig: QueryEngineAppSessionConfig
  webDir: string
  token: string
  wsPort?: number
  webPort?: number
  allowedOrigins?: string[]
  createController?: (
    options: RuntimeBackedWebAppSessionOptions,
  ) => AppSessionController
  startServer?: typeof startAppSessionWebSocketServer
  launchWebApp?: typeof launchWebAppDevServer
  waitForever?: () => Promise<void>
  log?: (message: string) => void
  writeError?: (message: string) => void
}

export async function startRuntimeBackedWebMode({
  queryEngineConfig,
  webDir,
  token,
  wsPort = 3456,
  webPort = 5173,
  allowedOrigins = [`http://127.0.0.1:${webPort}`],
  createController = createRuntimeBackedWebAppSession,
  startServer = startAppSessionWebSocketServer,
  launchWebApp = launchWebAppDevServer,
  waitForever = () => new Promise<void>(() => {}),
  log = message => {
    console.log(message)
  },
  writeError = message => {
    process.stderr.write(message)
  },
}: StartRuntimeBackedWebModeOptions): Promise<void> {
  let server: StartedAppSessionWebSocketServer | undefined
  let webApp: LaunchedWebAppDevServer | undefined
  const redactToken = (message: string) => message.split(token).join('[REDACTED]')
  let primaryError: unknown

  try {
    const controller = createController({ queryEngineConfig })
    server = await startServer({
      port: wsPort,
      token,
      allowedOrigins,
      controller,
    })
    log(chalk.magenta(`App session WebSocket listening on ${server.url}`))

    webApp = await launchWebApp({
      webDir,
      token,
      port: webPort,
    })
    log(chalk.magenta(`Web app dev server logs: ${webApp.logPath}`))
    log(chalk.magenta('Web mode is runtime-backed: skipping the Ink REPL.'))

    await waitForever()
  } catch (error) {
    primaryError = error
    const message = error instanceof Error ? error.message : String(error)
    writeError(
      chalk.red(
        `Failed to start runtime-backed web mode: ${redactToken(message)}\n`,
      ),
    )
  } finally {
    const cleanupErrors: string[] = []
    if (webApp) {
      try {
        await webApp.stop()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const redactedMessage = redactToken(message)
        cleanupErrors.push(`Failed to stop web app dev server: ${redactedMessage}`)
        writeError(
          chalk.red(
            `Failed to stop web app dev server: ${redactedMessage}\n`,
          ),
        )
      }
    }
    if (server) {
      try {
        await server.stop()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const redactedMessage = redactToken(message)
        cleanupErrors.push(
          `Failed to stop app session WebSocket server: ${redactedMessage}`,
        )
        writeError(
          chalk.red(
            `Failed to stop app session WebSocket server: ${redactedMessage}\n`,
          ),
        )
      }
    }

    if (!primaryError && cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.join('\n'))
    }
  }

  if (primaryError) {
    throw primaryError
  }
}
