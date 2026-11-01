import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {VueQueryPlugin} from '@tanstack/vue-query'
import {createMemoryHistory, createRouter, type Router} from 'vue-router'
import {defineComponent} from 'vue'

const sdk = vi.hoisted(() => ({
	projectsList: vi.fn(),
	tcyShowcaseSettings: vi.fn(),
	tcyShowcaseSave: vi.fn(),
	tcyShowcasePreview: vi.fn(),
	tcyShowcasePublish: vi.fn(),
	tcyShowcaseUnpublish: vi.fn(),
	tcyShowcasePublic: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import ShowcaseEditor from './ShowcaseEditor.vue'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Modal from '@/components/misc/Modal.vue'
import type {Project, TcyShowcaseSettingsResponse} from '@/client/generated'
import {queryClient} from '@/client/queryClient'
import {guides} from '@/helpers/guidedTour'
import {i18n} from '@/i18n'
import en from '@/i18n/lang/en.json'
import {useConfigStore} from '@/stores/config'

// The real useProjects is used on purpose: a mock with a different shape (a ref instead of the
// reactive state) once hid a render crash that left the whole settings page blank.
const projects: Project[] = [
	{id: 4, title: 'Thesis', is_archived: false},
	{id: 9, title: 'Reading list', is_archived: false},
	{id: 7, title: 'Old archive', is_archived: true},
	{id: -1, title: 'Favorites'},
	{id: -2, title: 'Saved filter'},
]

let wrapper: VueWrapper | undefined
let renderErrors: unknown[] = []

beforeEach(() => {
	vi.resetAllMocks()
	renderErrors = []
	setActivePinia(createPinia())
	i18n.global.setLocaleMessage('en', en)
	i18n.global.locale.value = 'en'
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	queryClient.clear()
})

function projectPage(items: Project[]) {
	return {data: {items, total_pages: 1}}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return {promise, resolve}
}

function mountEditor(initial: TcyShowcaseSettingsResponse) {
	wrapper = mount(ShowcaseEditor, {
		attachTo: document.body,
		props: {initial},
		global: {
			// Same client as the app: useProjects reads the shared module client directly.
			plugins: [i18n, [VueQueryPlugin, {queryClient}]],
			components: {XButton, Modal, Card},
			stubs: {Icon: true},
			config: {
				errorHandler(err: unknown) {
					renderErrors.push(err)
				},
			},
		},
	})
	return wrapper
}

function buttonNamed(name: string) {
	const button = wrapper!.findAll('button').find(candidate => candidate.text() === name)
	if (!button) throw new Error(`No button "${name}"`)
	return button
}

function projectOptions() {
	return wrapper!.find('select[aria-label="Select a project"]').findAll('option').map(option => option.text())
}

describe('ShowcaseEditor', () => {
	it.each([
		['an unpublished draft', {draft: {slug: 'tcy', title: 'Draft page'}}, 'Not published'],
		['a published page', {draft: {slug: 'tcy', title: 'Draft page'}, published: {slug: 'tcy'}}, 'Published'],
	])('renders the page heading and every showcase tour anchor for %s', async (_case, initial, status) => {
		sdk.projectsList.mockResolvedValue(projectPage(projects))
		mountEditor(initial)
		await flushPromises()

		expect(renderErrors).toEqual([])
		const headings = wrapper!.findAll('h1')
		expect(headings).toHaveLength(1)
		expect(headings[0]!.text()).toBe('Public page')
		expect(wrapper!.find('[data-tour="showcase-status"]').text()).toContain(status)
		// Each guide step needs its anchor on the page, otherwise the tour shows "This area is unavailable".
		const targets = guides.showcase.steps.map(step => step.target)
		expect(targets).toHaveLength(6)
		for (const target of targets) {
			const anchor = wrapper!.find(`[data-tour="${target}"]`)
			expect(anchor.exists(), target).toBe(true)
			expect(anchor.isVisible(), target).toBe(true)
		}
	})

	it('lists projects that finish loading after the editor mounted', async () => {
		const pending = deferred<ReturnType<typeof projectPage>>()
		sdk.projectsList.mockReturnValue(pending.promise)
		mountEditor({draft: {slug: 'tcy', projects: [{id: 9, mode: 'busy'}]}})
		await flushPromises()

		expect(renderErrors).toEqual([])
		// Still loading: no rule is named by its number, and the picker says why it is empty.
		expect(projectOptions()).toEqual(['Loading your projects…'])
		expect(wrapper!.find('.project-rule .rule-name').text()).toBe('Loading…')

		pending.resolve(projectPage(projects))
		await flushPromises()

		// Archived projects, favourites and saved filters cannot be published.
		expect(projectOptions()).toEqual(['Select a project', 'Thesis', 'Reading list'])
		expect(wrapper!.find('.project-rule .rule-name').text()).toBe('Reading list')
		await wrapper!.find('select[aria-label="Select a project"]').setValue('4')
		await buttonNamed('Add project rule').trigger('click')
		expect(wrapper!.findAll('.project-rule .rule-name').map(name => name.text())).toEqual(['Reading list', 'Thesis'])
		expect(renderErrors).toEqual([])
	})

	it('keeps publishing gated behind a preview of the current draft', async () => {
		sdk.projectsList.mockResolvedValue(projectPage([]))
		sdk.tcyShowcasePreview.mockResolvedValue({data: {
			page: {
				title: 'Draft page',
				content: '# Custom',
				format: 'markdown',
				events: [],
				free: [],
				projects: [],
			},
			sources: [],
		}})
		mountEditor({draft: {slug: 'tcy', title: 'Draft page'}})
		await flushPromises()

		const publish = buttonNamed('Publish this preview')
		expect(publish.attributes('aria-disabled')).toBe('true')
		const hint = wrapper!.find(`#${publish.attributes('aria-describedby')}`)
		expect(hint.text()).toBe('Preview the current draft to enable publishing.')
		await publish.trigger('click')
		await flushPromises()
		expect(sdk.tcyShowcasePublish).not.toHaveBeenCalled()

		await buttonNamed('Preview public page').trigger('click')
		await flushPromises()

		expect(buttonNamed('Publish this preview').attributes('aria-disabled')).toBeUndefined()
		expect(wrapper!.findAll('h2').map(h => h.text())).toContain('What visitors will see')
		expect(wrapper!.findAll('iframe')).toHaveLength(1)
		expect(wrapper!.findAll('h1')).toHaveLength(1)

		await wrapper!.find('input[maxlength="100"]').setValue('Changed title')
		expect(buttonNamed('Publish this preview').attributes('aria-disabled')).toBe('true')
		expect(renderErrors).toEqual([])
	})
})

function openDialog() {
	return document.querySelector('dialog.modal-dialog:not([data-closing])')
}

function dialogButton(name: string) {
	const found = [...(openDialog()?.querySelectorAll('button') ?? [])].find(button => button.textContent?.trim() === name)
	if (!found) throw new Error(`No dialog button "${name}"`)
	return found
}

describe('ShowcaseEditor: unsaved drafts', () => {
	let router: Router

	async function mountRouted(initial: TcyShowcaseSettingsResponse) {
		const Host = defineComponent({
			components: {ShowcaseEditor},
			setup: () => ({initial}),
			template: '<ShowcaseEditor :initial="initial" />',
		})
		router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{path: '/settings', component: Host},
				{path: '/elsewhere', component: {template: '<div class="elsewhere" />'}},
			],
		})
		await router.push('/settings')
		await router.isReady()
		wrapper = mount(defineComponent({template: '<RouterView />'}), {
			attachTo: document.body,
			global: {
				plugins: [i18n, router, [VueQueryPlugin, {queryClient}]],
				components: {XButton, Modal, Card},
				stubs: {Icon: true},
			},
		})
		await flushPromises()
	}

	it('says when there are unsaved changes and asks before leaving', async () => {
		sdk.projectsList.mockResolvedValue(projectPage([]))
		await mountRouted({draft: {slug: 'tcy', title: 'Draft page'}})
		expect(wrapper!.text()).not.toContain('Unsaved changes')

		await wrapper!.find('input[maxlength="100"]').setValue('Changed title')
		expect(wrapper!.text()).toContain('Unsaved changes')

		await router.push('/elsewhere')
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/settings')
		expect(openDialog()?.textContent).toContain('Leave without saving?')

		dialogButton('Stay').click()
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/settings')
		expect((wrapper!.find('input[maxlength="100"]').element as HTMLInputElement).value).toBe('Changed title')

		sdk.tcyShowcaseSave.mockResolvedValue({data: {draft: {slug: 'tcy', title: 'Changed title'}}})
		await buttonNamed('Save draft').trigger('click')
		await flushPromises()
		expect(wrapper!.text()).not.toContain('Unsaved changes')

		await router.push('/elsewhere')
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/elsewhere')
	})

	it('leaves after an explicit discard', async () => {
		sdk.projectsList.mockResolvedValue(projectPage([]))
		await mountRouted({draft: {slug: 'tcy', title: 'Draft page'}})
		await wrapper!.find('input[maxlength="100"]').setValue('Changed title')

		await router.push('/elsewhere')
		await flushPromises()
		dialogButton('Discard and leave').click()
		await flushPromises()

		expect(router.currentRoute.value.path).toBe('/elsewhere')
	})

	it('asks the browser to confirm closing the tab only while there are unsaved changes', async () => {
		sdk.projectsList.mockResolvedValue(projectPage([]))
		await mountRouted({draft: {slug: 'tcy', title: 'Draft page'}})

		const clean = new Event('beforeunload', {cancelable: true})
		window.dispatchEvent(clean)
		expect(clean.defaultPrevented).toBe(false)

		await wrapper!.find('input[maxlength="100"]').setValue('Changed title')
		const dirty = new Event('beforeunload', {cancelable: true})
		window.dispatchEvent(dirty)
		expect(dirty.defaultPrevented).toBe(true)
	})
})

describe('ShowcaseEditor: confirmations', () => {
	it('asks before replacing a written page body with the template', async () => {
		sdk.projectsList.mockResolvedValue(projectPage([]))
		mountEditor({draft: {slug: 'tcy', content: '<h1>Mine</h1>', format: 'html'}})
		await flushPromises()

		await buttonNamed('Insert schedule template').trigger('click')
		await flushPromises()
		const body = wrapper!.find('textarea.template-editor').element as HTMLTextAreaElement
		expect(openDialog()?.textContent).toContain('Replace the page body with the template?')
		expect(body.value).toBe('<h1>Mine</h1>')

		dialogButton('Replace body').click()
		await flushPromises()
		expect(body.value).not.toBe('<h1>Mine</h1>')
		expect((wrapper!.find('select[aria-label="Content format"]').element as HTMLSelectElement).value).toBe('markdown')
	})

	it('inserts the template straight into an empty body', async () => {
		sdk.projectsList.mockResolvedValue(projectPage([]))
		mountEditor({draft: {slug: 'tcy', content: ''}})
		await flushPromises()

		await buttonNamed('Insert schedule template').trigger('click')
		await flushPromises()

		expect(openDialog()).toBeNull()
		expect((wrapper!.find('textarea.template-editor').element as HTMLTextAreaElement).value).not.toBe('')
	})

	it('asks before taking the public page down', async () => {
		sdk.projectsList.mockResolvedValue(projectPage([]))
		sdk.tcyShowcaseUnpublish.mockResolvedValue({data: {draft: {slug: 'tcy'}}})
		mountEditor({draft: {slug: 'tcy'}, published: {slug: 'tcy'}})
		await flushPromises()

		await buttonNamed('Take down page').trigger('click')
		await flushPromises()
		expect(sdk.tcyShowcaseUnpublish).not.toHaveBeenCalled()
		expect(openDialog()?.textContent).toContain('Take down your public page?')
		expect(openDialog()?.textContent).toContain('JSON endpoint')

		openDialog()!.querySelector<HTMLButtonElement>('.actions .is-primary')!.click()
		await flushPromises()
		expect(sdk.tcyShowcaseUnpublish).toHaveBeenCalledTimes(1)
	})

	it('builds the public links from the configured addresses', async () => {
		sdk.projectsList.mockResolvedValue(projectPage([]))
		const configStore = useConfigStore()
		configStore.frontend_url = 'https://schedule.example/app/'
		mountEditor({draft: {slug: 'tcy'}, published: {slug: 'tcy'}})
		await flushPromises()

		const links = wrapper!.findAll('.publication a').map(link => link.attributes('href'))
		expect(links).toEqual([
			'https://schedule.example/app/p/tcy',
			`${configStore.apiBase}/api/v2/public/tcy`,
		])
	})
})

describe('ShowcaseEditor: the project picker', () => {
	const withRule = {draft: {slug: 'tcy', title: 'Draft page', projects: [{id: 9, alias: '', mode: 'busy' as const}]}}

	it('says the projects couldn\'t be loaded and offers to try again', async () => {
		const defaults = queryClient.getDefaultOptions()
		queryClient.setDefaultOptions({...defaults, queries: {...defaults.queries, retry: false}})
		try {
			sdk.projectsList.mockRejectedValue(new Error('offline'))
			mountEditor(withRule)
			await flushPromises()

			expect(wrapper!.text()).toContain('Your projects couldn\'t be loaded, so no project can be added right now.')
			expect(wrapper!.find('select[aria-label="Select a project"]').exists()).toBe(false)

			sdk.projectsList.mockResolvedValue(projectPage(projects))
			await buttonNamed('Retry').trigger('click')
			await flushPromises()
			expect(projectOptions()).toContain('Reading list')
		} finally {
			queryClient.setDefaultOptions(defaults)
		}
	})
})
