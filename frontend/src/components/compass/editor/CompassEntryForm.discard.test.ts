import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {computed, defineComponent, h, nextTick, reactive, ref} from 'vue'
import {createMemoryHistory, createRouter, RouterView} from 'vue-router'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({
	compassEntriesRead: vi.fn(),
	compassEntriesUpdate: vi.fn(),
	compassTopicsList: vi.fn(),
}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('@/message', async original => ({...await original<typeof import('@/message')>(), error: vi.fn(), success: vi.fn()}))
vi.mock('@/stores/auth', () => ({useAuthStore: () => reactive({info: {id: 1}, isLinkShareAuth: false})}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => 'https://tasks.example.com/api/v1/'}))
vi.mock('vue-i18n', async original => ({
	...await original<typeof import('vue-i18n')>(),
	useI18n: () => ({
		t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key,
		locale: ref('en'),
	}),
}))
// The rich-text body is TipTap; the desk's own logic is what is tested here.
vi.mock('@/components/input/AsyncEditor', () => ({
	default: {name: 'Editor', props: ['modelValue'], template: '<div class="editor-stub" />'},
}))
// Uploads need a live editor; the count of images still on their way is set by the test.
const pendingUploads = ref(0)
vi.mock('./useCompassImageEditing', async original => {
	const real = await original<typeof import('./useCompassImageEditing')>()
	return {
		...real,
		useCompassImageEditing: (spaceId: number) => ({
			...real.useCompassImageEditing(spaceId),
			pending: computed(() => pendingUploads.value),
		}),
	}
})

import CompassEntryForm from './CompassEntryForm.vue'
import {ApiError} from '@/client/problem'
import {normalizeCompassEntry, normalizeCompassSpace} from '@/client/queries/compass'
import {compassDraftKey} from '@/helpers/compass/drafts'
import {compassAccountNamespace} from '@/helpers/compass/storage'

const space = normalizeCompassSpace({id: 3, title: 'Letters', max_permission: 1})
const entry = normalizeCompassEntry({id: 7, space_id: 3, title: 'Letters to myself', content: '<p>Dear me,</p>', revision: 1, state: 'active'})
const draftKey = compassDraftKey(compassAccountNamespace('https://tasks.example.com/api/v1/', 1), 3, 7)

let wrapper: VueWrapper | undefined

function keepDraft(title: string) {
	localStorage.setItem(draftKey, JSON.stringify({
		v: 1,
		spaceId: 3,
		entryId: 7,
		baseRevision: 1,
		savedAt: '2026-10-30T08:00:00Z',
		fields: {kind: 'note', title, subtitle: '', content: '<p>Dear me,</p>', quote: '', category: '', tags: [], theme: 'inherit', pinned: false},
	}))
}

async function mountDesk() {
	const Desk = defineComponent({render: () => h(CompassEntryForm, {space, entry})})
	const router = createRouter({history: createMemoryHistory(), routes: [
		{path: '/desk', name: 'compass.entry.edit', component: Desk},
		{path: '/entry/:entryId', name: 'compass.entry', component: {render: () => null}},
		{path: '/space/:spaceId', name: 'compass.space', component: {render: () => null}},
		{path: '/elsewhere', name: 'elsewhere', component: {render: () => null}},
	]})
	await router.push('/desk')
	await router.isReady()
	wrapper = mount(defineComponent({render: () => h(RouterView)}), {
		attachTo: document.body,
		global: {
			plugins: [router, [VueQueryPlugin, {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}]],
			mocks: {$t: (key: string) => key},
			stubs: {Icon: true, CompassProse: true},
		},
	})
	await flushPromises()
	return {router, title: () => wrapper!.find<HTMLTextAreaElement>('textarea').element}
}

function buttonByText(text: string): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === text)
}

function dialogText(): string {
	return document.querySelector('dialog[open]')?.textContent ?? ''
}

beforeEach(() => {
	sdk.compassTopicsList.mockResolvedValue({data: {categories: [], tags: []}})
	pendingUploads.value = 0
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	document.body.innerHTML = ''
	localStorage.clear()
	Object.values(sdk).forEach(fn => fn.mockReset())
})

describe('CompassEntryForm: throwing text away asks first', () => {
	it('keeps a restored draft until "Discard draft" is confirmed', async () => {
		keepDraft('Letters to my future self')
		const desk = await mountDesk()
		expect(desk.title().value).toBe('Letters to my future self')

		buttonByText('compass.draft.discard')!.click()
		await flushPromises()

		expect(dialogText()).toContain('compass.draft.discardText')
		expect(desk.title().value).toBe('Letters to my future self')
		expect(localStorage.getItem(draftKey)).not.toBeNull()

		document.querySelector<HTMLButtonElement>('dialog[open] .compass-desk__discard-confirm')!.click()
		await flushPromises()

		expect(desk.title().value).toBe('Letters to myself')
		expect(localStorage.getItem(draftKey)).toBeNull()
	})

	it('asks before "use the latest version" replaces the writer\'s text', async () => {
		const desk = await mountDesk()
		const title = desk.title()
		title.value = 'How I would put it'
		title.dispatchEvent(new Event('input'))
		await flushPromises()
		sdk.compassEntriesUpdate.mockRejectedValueOnce(new ApiError({status: 409, detail: 'A newer revision exists.'}))
		sdk.compassEntriesRead.mockResolvedValue({data: {...entry, title: 'How we put it', revision: 2}})

		document.querySelector<HTMLButtonElement>('.compass-desk__save')!.click()
		await flushPromises()
		buttonByText('compass.conflict.takeLatest')!.click()
		await flushPromises()

		expect(dialogText()).toContain('compass.conflict.takeLatestText')
		expect(desk.title().value).toBe('How I would put it')

		document.querySelector<HTMLButtonElement>('dialog[open] .compass-desk__discard-confirm')!.click()
		await flushPromises()

		expect(desk.title().value).toBe('How we put it')
	})
})

describe('CompassEntryForm: images still uploading', () => {
	it('does not say "Saved" and asks before leaving cancels them', async () => {
		const desk = await mountDesk()
		pendingUploads.value = 2
		await nextTick()

		expect(document.querySelector('.compass-save-status')?.textContent).toContain('compass.editor.status.uploading')

		void desk.router.push('/elsewhere')
		await flushPromises()

		expect(desk.router.currentRoute.value.path).toBe('/desk')
		expect(dialogText()).toContain('compass.leave.uploading')
		buttonByText('compass.leave.cancelUploads')!.click()
		await flushPromises()

		expect(desk.router.currentRoute.value.path).toBe('/elsewhere')
	})
})
