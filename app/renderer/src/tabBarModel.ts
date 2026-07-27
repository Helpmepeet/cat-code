import type { SessionDescriptor } from '../../shared/hostApi.js'
import { basename } from './pathUtils.js'

export function tabLabel(descriptor: SessionDescriptor): string {
  if (descriptor.title && descriptor.title.trim().length > 0) {
    return descriptor.title
  }
  const base = basename(descriptor.cwd)
  return base.length > 0 ? base : 'New session'
}
