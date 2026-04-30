export type Status = 'active' | 'inactive' | 'pending'

export function isActive(status: Status): boolean {
  return status === 'active'
}
