import { expect, test } from 'bun:test'
import { isCreateProjectInput, isProjectDraftId, isProjectName } from './projects.js'
const draftId = '12345678-1234-4234-8234-123456789abc'
test('project creation admits only a closed name, draft-id and boolean trust choice', () => {
  for (const trustFolder of [false, true]) expect(isCreateProjectInput({ draftId, name: ' Project ', trustFolder })).toBe(true)
  for (const value of [null, [], {}, { draftId, name: 'No' }, { draftId, name: 'No', trustFolder: 'true' }, { draftId, name: 'No', trustFolder: true, cwd: '/tmp' }, { draftId, name: 'No', trustFolder: true, trustRoot: '/tmp' }, { draftId, name: 'No', trustFolder: false, extra: true }, { draftId: '/tmp', name: 'No', trustFolder: false }, { draftId, name: ' ', trustFolder: false }, { draftId, name: 'x'.repeat(161), trustFolder: false }]) expect(isCreateProjectInput(value)).toBe(false)
  expect(isProjectDraftId(draftId)).toBe(true)
  expect(isProjectName('x'.repeat(160))).toBe(true)
})
