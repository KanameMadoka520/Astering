import {effectScope, nextTick, ref, type EffectScope} from 'vue'
import {afterEach, describe, expect, it} from 'vitest'
import {useCompassEntryDraft} from './useCompassEntryDraft'
import {compassAccountNamespace} from '@/helpers/compass/storage'
import {compassDraftKey, emptyCompassDraftFields, loadCompassDraft} from '@/helpers/compass/drafts'
import {clearAccountDrafts, clearStorageKeepingScopedDrafts} from '@/helpers/localDrafts'

const namespace = compassAccountNamespace('/api/v2', 41)
const scopes: EffectScope[] = []
function desk() {
 const scope = effectScope()
 const seed = emptyCompassDraftFields()
 const fields = ref({...seed, tags: [] as string[]})
 const draft = scope.run(() => useCompassEntryDraft({
  namespace, spaceId: 1, entryId: ref(7), fields, base: {fields: seed, revision: 1},
 }))!
 scopes.push(scope)
 return {scope, fields, draft}
}
afterEach(() => {
 scopes.splice(0).forEach(scope => scope.stop())
 localStorage.clear()
})

describe('Compass draft clear leases', () => {
 it('old disposal and clean-state callbacks cannot resurrect or remove the next session’s draft', async () => {
  const old = desk()
  old.fields.value.title = 'old writing'
  await nextTick()
  old.draft.persistNow()
  const key = compassDraftKey(namespace, 1, 7)
  expect(loadCompassDraft(key, 1, 7)?.fields.title).toBe('old writing')
  clearAccountDrafts({compass: namespace, editor: ''})
  clearStorageKeepingScopedDrafts()
  const current = desk()
  current.fields.value.title = 'new session writing'
  await nextTick()
  current.draft.persistNow()

  // A late acknowledgement makes the old editor clean, which ordinarily clears its slot.
  old.fields.value = emptyCompassDraftFields()
  await nextTick()
  expect(loadCompassDraft(key, 1, 7)?.fields.title).toBe('new session writing')
  old.fields.value.title = 'old pending callback'
  await nextTick()
  old.scope.stop()
  expect(loadCompassDraft(key, 1, 7)?.fields.title).toBe('new session writing')
 })
})
