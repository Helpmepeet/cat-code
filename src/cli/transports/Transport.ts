import type { StreamClientEvent } from './SSETransport.js'

export interface Transport {
  connect(): Promise<void>
  close(): void
  setOnData(callback: (data: string) => void): void
  setOnClose(callback: (closeCode?: number) => void): void
  write(message: unknown): Promise<void>
  writeBatch?(messages: unknown[]): Promise<void>
  isConnectedStatus(): boolean
  isClosedStatus(): boolean
  getStateLabel(): string
  setOnConnect?(callback: () => void): void
  setOnEvent?(callback: (event: StreamClientEvent) => void): void
}
