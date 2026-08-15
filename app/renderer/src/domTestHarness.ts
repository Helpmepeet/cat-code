/**
 * Opt-in DOM harness for renderer tests.
 *
 * `bun test app/` evaluates every test file in ONE process, sequentially, with a
 * shared `globalThis` (verified: a global set by one file is visible to the
 * next). A bunfig `[test] preload` that registered happy-dom would therefore
 * hand a `window` and a `document` to all ~214 files at once, flipping the
 * `typeof window === 'undefined'` / `typeof ResizeObserver === 'undefined'`
 * branches that the existing `renderToStaticMarkup` suites are written against.
 *
 * So registration is per file and reversible: a suite calls
 * `createDomTestHarness()` in `beforeAll`, `teardown()` in `afterAll`, and no
 * other file ever observes a DOM. Import this module from a `*.dom.test.ts`
 * file only.
 *
 * `react-dom/client` is loaded lazily, after the globals exist, so the SSR test
 * files never pull the DOM renderer into the module graph at all.
 */

import { act } from 'react'
import type { ReactNode } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

type ActEnvironmentGlobal = { IS_REACT_ACT_ENVIRONMENT?: boolean }

type ReactDomClient = typeof import('react-dom/client')

/** A single React tree mounted into its own container under `document.body`. */
export type MountedTree = {
  /** The element the tree was rendered into. Still attached until `unmount()`. */
  container: HTMLElement
  /** Re-renders the same root with a new element, flushing effects. */
  render: (node: ReactNode) => Promise<void>
  /** Unmounts the root and detaches the container, flushing effect cleanups. */
  unmount: () => Promise<void>
}

export type DomTestHarness = {
  /** The happy-dom document installed on `globalThis` for this suite. */
  document: Document
  /** Mounts a React tree into a fresh container appended to `document.body`. */
  mount: (node: ReactNode) => Promise<MountedTree>
  /** Resolves after one real animation frame has run. */
  nextFrame: () => Promise<void>
  /** Unmounts every tree this harness mounted. Safe to call from `afterEach`. */
  unmountAll: () => Promise<void>
  /** Unmounts everything, then removes the happy-dom globals again. */
  teardown: () => Promise<void>
}

let reactDomClient: ReactDomClient | null = null

async function loadReactDomClient(): Promise<ReactDomClient> {
  reactDomClient ??= await import('react-dom/client')
  return reactDomClient
}

/**
 * Registers happy-dom globals and returns a mount/teardown pair for React 19.
 * Throws if a harness is already live, because two registrations would fight
 * over the same `globalThis` slots.
 */
export async function createDomTestHarness(): Promise<DomTestHarness> {
  if (GlobalRegistrator.isRegistered) {
    throw new Error('A DOM test harness is already registered; tear the previous one down first.')
  }

  GlobalRegistrator.register({ url: 'http://localhost/' })

  // Without this React logs "The current testing environment is not configured
  // to support act(...)" and effects do not flush deterministically.
  const actGlobal = globalThis as typeof globalThis & ActEnvironmentGlobal
  const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const { createRoot } = await loadReactDomClient()
  const trees = new Set<MountedTree>()

  const mount = async (node: ReactNode): Promise<MountedTree> => {
    const container = globalThis.document.createElement('div')
    globalThis.document.body.appendChild(container)
    const root = createRoot(container)

    const tree: MountedTree = {
      container,
      render: async (next: ReactNode) => {
        await act(async () => {
          root.render(next)
        })
      },
      unmount: async () => {
        if (!trees.delete(tree)) return
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
    }

    trees.add(tree)
    await tree.render(node)
    return tree
  }

  const nextFrame = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      globalThis.requestAnimationFrame(() => {
        resolve()
      })
    })
  }

  const unmountAll = async (): Promise<void> => {
    for (const tree of [...trees]) await tree.unmount()
  }

  const teardown = async (): Promise<void> => {
    await unmountAll()
    if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT
    else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    await GlobalRegistrator.unregister()
  }

  return { document: globalThis.document, mount, nextFrame, unmountAll, teardown }
}

export const _forTest = {
  isRegistered(): boolean {
    return GlobalRegistrator.isRegistered
  },
}
