import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { BROWSER_DIALOG_SCRIPT, BROWSER_ARM_CONFIRM_SCRIPT } from './browserPaneDialogs.js'

test('document-start shim reports alert and confirm without blocking; one armed confirm accepts', () => {
  const reports: string[] = []
  const context: any = { __catBrowserDialogReport: (value: string) => reports.push(value) }
  context.window = context; context.top = context
  context.alert = () => { throw new Error('native alert') }
  context.confirm = () => { throw new Error('native confirm') }
  runInNewContext(BROWSER_DIALOG_SCRIPT, context)
  expect(context.alert('hello')).toBeUndefined()
  expect(context.confirm('no')).toBe(false)
  runInNewContext(BROWSER_ARM_CONFIRM_SCRIPT, context)
  expect(context.confirm('yes')).toBe(true)
  expect(context.confirm('no again')).toBe(false)
  expect(reports.map(v => JSON.parse(v).type)).toEqual(['alert', 'confirm', 'confirm', 'confirm'])
})

test('same-origin child frame shares one arm and a cross-origin frame remains nonblocking', () => {
  const reports: string[] = []
  const top: any = { __catBrowserDialogReport: (v: string) => reports.push(v) }
  top.window = top; top.top = top
  runInNewContext(BROWSER_DIALOG_SCRIPT, top)
  const child: any = { top, __catBrowserDialogReport: top.__catBrowserDialogReport }
  child.window = child
  runInNewContext(BROWSER_DIALOG_SCRIPT, child)
  runInNewContext(BROWSER_ARM_CONFIRM_SCRIPT, top)
  expect(child.confirm('child')).toBe(true)
  expect(top.confirm('top')).toBe(false)
  const cross: any = { __catBrowserDialogReport: top.__catBrowserDialogReport }
  Object.defineProperty(cross, 'top', { get: () => { throw new Error('cross origin') } }); cross.window = cross
  runInNewContext(BROWSER_DIALOG_SCRIPT, cross)
  expect(cross.confirm('cross')).toBe(false)
})
