import { useCallback, useSyncExternalStore } from 'react'
import { defaultViewPreferenceStorage, readViewPreference, writeViewPreference } from './viewPreference.js'

const KEY = 'catcode.sourceWrap.v1'
const listeners = new Set<() => void>()
let current: boolean | undefined
function snapshot(): boolean {
  return current ??= readViewPreference(defaultViewPreferenceStorage(), KEY, 'wrap', value => typeof value === 'boolean' ? value : null) ?? false
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useSourceWrap(): [boolean, (wrap: boolean) => void] {
  const value = useSyncExternalStore(subscribe, snapshot, () => false)
  const set = useCallback((wrap: boolean) => {
    current = wrap
    writeViewPreference(defaultViewPreferenceStorage(), KEY, 'wrap', wrap)
    listeners.forEach(listener => listener())
  }, [])
  return [value, set]
}
