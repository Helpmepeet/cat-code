export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export function log(level: LogLevel, message: string): void {
  console.log(`[${level}] ${message}`)
}

export function debug(message: string): void {
  log('debug', message)
}
