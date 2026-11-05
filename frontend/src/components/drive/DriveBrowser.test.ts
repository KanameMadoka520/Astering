import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {defineComponent, h} from 'vue'
import {createMemoryHistory, createRouter, RouterView, type Router} from 'vue-router'

const sdk = vi.hoisted(() => ({
	driveList: vi.fn(),
	driveUsages: vi.fn(),
	driveUpload: vi.fn(),
	driveChange: vi.fn(),
	driveAttach: vi.fn(),
	driveCover: vi.fn(),
	driveDownload: vi.fn(),
	drivePreview: vi.fn(),
}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', async original => ({...await original<typeof import('@/message')>(), success: vi.fn(), error: vi.fn()}))

import DriveBrowser from './DriveBrowser.vue'
import en from '@/i18n/lang/en.json'
import {error} from '@/message'
import {imagePrompt, UPLOAD_CHOICE_HEADER} from '@/helpers/uploadTransport'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})

function file(id: number, overrides: Record<string, unknown> = {}) {
	return {
		file_id: id,
		revision: 1,
		category: '',
		pinned: false,
		file: {
			id,
			name: `document-${id}.txt`,
			mime: 'text/plain',
			size: 2048,
			created: '2026-10-30T09:00:00Z',
		},
		...overrides,
	}
}

let client: QueryClient
let wrapper: VueWrapper | undefined
let router: Router

beforeEach(() => {
	vi.resetAllMocks()
	localStorage.clear()
	setActivePinia(createPinia())
	client = new QueryClient({defaultOptions: {queries: {retry: false}}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	imagePrompt.value?.resolve(null)
})

// Renders the dialog body only while open, like the real Modal.
const ModalStub = defineComponent({
	props: {enabled: Boolean},
	template: '<div v-if="enabled" class="modal-stub" v-bind="$attrs"><slot /></div>',
})

// Mounted on a route so the page's leave guard is active, as in the app.
async function mountBrowser(props: {picker?: boolean, images?: boolean, busy?: boolean} = {}) {
	router = createRouter({history: createMemoryHistory(), routes: [
		{path: '/', component: {render: () => h(DriveBrowser, props)}},
		{path: '/elsewhere', component: {render: () => null}},
	]})
	await router.push('/')
	await router.isReady()
	wrapper = mount(defineComponent({render: () => h(RouterView)}), {
		attachTo: document.body,
		global: {
			plugins: [router, i18n, [VueQueryPlugin, {queryClient: client}]],
			stubs: {
				XButton: {template: '<button type="button" v-bind="$attrs"><slot /></button>'},
				Modal: ModalStub,
				Icon: true,
				RouterLink: true,
			},
			directives: {tooltip: {}},
		},
	})
	return wrapper
}

function buttonsNamed(name: string) {
	return wrapper!.findAll('button').filter(button => button.text() === name || button.attributes('aria-label') === name)
}

describe('DriveBrowser', () => {
	it('renders every file as a card with its pinned marker, category and labelled actions', async () => {
		sdk.driveList.mockResolvedValue({data: {
			files: [file(1, {pinned: true, category: 'Work'}), file(2)],
			total: 2,
			bytes: 3 * 1024 * 1024 * 1024,
			categories: ['Work'],
		}})
		await mountBrowser()
		await flushPromises()

		expect(wrapper!.find('h1').text()).toBe('My Drive')
		const cards = wrapper!.findAll('.drive-card')
		expect(cards).toHaveLength(2)
		expect(cards[0].text()).toContain('★ document-1.txt')
		expect(cards[0].text()).toContain('Work')
		expect(cards[0].findAll('button').filter(b => b.text() === 'Details and usages')).toHaveLength(1)
		expect(cards[0].findAll('button').filter(b => b.text() === 'Move to recycle bin')).toHaveLength(1)
		// The thumbnail button is a mouse shortcut and must not add a second accessible name per card.
		expect(cards[0].find('.drive-preview').attributes('aria-hidden')).toBe('true')
		expect(wrapper!.find('.drive-summary').text()).toContain('3 GiB')
		expect(wrapper!.findAll('input[type=search]')).toHaveLength(1)
		expect(wrapper!.find('.drive-browser input[type=file]').exists()).toBe(true)
		expect(wrapper!.find('.drive-toolbar').findAll('button').filter(b => b.text() === 'Recycle bin')).toHaveLength(1)
	})

	it('offers exactly one choose button per file in picker mode', async () => {
		sdk.driveList.mockResolvedValue({data: {files: [file(3)], total: 1, bytes: 10, categories: []}})
		await mountBrowser({picker: true})
		await flushPromises()

		const choose = buttonsNamed('Choose from Drive')
		expect(choose).toHaveLength(1)
		expect(wrapper!.find('h1').exists()).toBe(false)
		expect(buttonsNamed('Recycle bin')).toHaveLength(0)
		await choose[0].trigger('click')
		expect(wrapper!.findComponent(DriveBrowser).emitted('select')?.[0]?.[0]).toMatchObject({file_id: 3})
	})

	it('explains an empty filtered result and clears the filters', async () => {
		sdk.driveList.mockResolvedValue({data: {files: [], total: 0, bytes: 0, categories: []}})
		await mountBrowser()
		await flushPromises()
		expect(wrapper!.text()).toContain('No files here. Upload a file or change your filters.')

		await wrapper!.find('input[type=search]').setValue('nothing')
		await flushPromises()
		expect(wrapper!.text()).toContain('No files match these filters.')
		await buttonsNamed('Clear filters')[0].trigger('click')
		expect((wrapper!.find('input[type=search]').element as HTMLInputElement).value).toBe('')
	})

	it('pages with a single Next button and remembers the chosen layout', async () => {
		sdk.driveList.mockResolvedValue({data: {
			files: Array.from({length: 60}, (_, index) => file(index + 1)),
			total: 61,
			bytes: 0,
			categories: [],
		}})
		await mountBrowser()
		await flushPromises()

		expect(wrapper!.text()).toContain('Page 1 of 2')
		expect(buttonsNamed('Next')).toHaveLength(1)
		await buttonsNamed('List')[0].trigger('click')
		expect(wrapper!.find('.drive-files').classes()).toContain('is-list')
		expect(localStorage.getItem('tcymc-drive-view')).toBe('list')
	})

	it('clears selection immediately on a page change and cannot select placeholder rows from the previous page', async () => {
		const second = deferred<{data: {files: ReturnType<typeof file>[], total: number}}>()
		sdk.driveList
			.mockResolvedValueOnce({data: {files: [file(1)], total: 61, bytes: 10, categories: []}})
			.mockReturnValueOnce(second.promise)
		await mountBrowser()
		await flushPromises()
		await buttonsNamed('Select files')[0].trigger('click')
		await wrapper!.find('.drive-card-selection input').trigger('click')
		expect(wrapper!.find('.drive-batch').text()).toContain('1 selected')
		await buttonsNamed('Next')[0].trigger('click')
		await flushPromises()
		expect(wrapper!.find('.drive-card').text()).toContain('document-1.txt')
		expect(wrapper!.findAll('.drive-card-selection')).toHaveLength(0)
		expect(buttonsNamed('Select files')[0].attributes('aria-disabled')).toBe('true')
		await buttonsNamed('Select files')[0].trigger('click')
		expect(wrapper!.findAll('.drive-card-selection')).toHaveLength(0)
		second.resolve({data: {files: [file(61)], total: 61}})
		await flushPromises()
		expect(buttonsNamed('Select files')[0].attributes('aria-disabled')).toBeUndefined()
		await buttonsNamed('Select files')[0].trigger('click')
		expect(wrapper!.find('.drive-batch').text()).toContain('0 selected')
	})

	it('abandons an in-flight reference review after navigation without opening or applying an old dialog', async () => {
		const usages = deferred<{data: []}>()
		sdk.driveList.mockResolvedValue({data: {files: [file(1)], total: 1, bytes: 10, categories: []}})
		sdk.driveUsages.mockReturnValue(usages.promise)
		await mountBrowser()
		await flushPromises()
		await buttonsNamed('Select files')[0].trigger('click')
		await buttonsNamed('Select current page')[0].trigger('click')
		await buttonsNamed('Move selected to recycle bin')[0].trigger('click')
		await flushPromises()
		expect(wrapper!.find('.drive-batch-review').attributes('data-stage')).toBe('scan')
		await router.push('/elsewhere')
		usages.resolve({data: []})
		await flushPromises()
		expect(wrapper!.find('.drive-batch-review').exists()).toBe(false)
		expect(sdk.driveChange).not.toHaveBeenCalled()
	})

	it('does not permit selection during the search debounce gap', async () => {
		sdk.driveList.mockResolvedValue({data: {files: [file(1)], total: 1, bytes: 10, categories: []}})
		await mountBrowser()
		await flushPromises()
		await wrapper!.find('input[type=search]').setValue('another scope')
		expect(buttonsNamed('Select files')[0].attributes('aria-disabled')).toBe('true')
		await buttonsNamed('Select files')[0].trigger('click')
		expect(wrapper!.findAll('.drive-card-selection')).toHaveLength(0)
	})

	it('can start a new selection after scope changes during a write and ignores the old batch completion', async () => {
		const change = deferred<{data: ReturnType<typeof file>}>()
		sdk.driveList.mockResolvedValue({data: {files: [file(1)], total: 1, bytes: 10, categories: []}})
		sdk.driveChange.mockReturnValueOnce(change.promise)
		await mountBrowser()
		await flushPromises()
		await buttonsNamed('Select files')[0].trigger('click')
		await buttonsNamed('Select current page')[0].trigger('click')
		await buttonsNamed('Pin selected')[0].trigger('click')
		await flushPromises()
		await buttonsNamed('Apply to eligible files')[0].trigger('click')
		await flushPromises()
		expect(wrapper!.find('.drive-batch-review').attributes('data-stage')).toBe('running')
		await router.push('/?next-scope=1')
		await flushPromises()
		await buttonsNamed('Select files')[0].trigger('click')
		await buttonsNamed('Select current page')[0].trigger('click')
		await buttonsNamed('Unpin selected')[0].trigger('click')
		await flushPromises()
		expect(wrapper!.find('.drive-batch-review').attributes('data-stage')).toBe('review')
		change.resolve({data: file(1)})
		await flushPromises()
		expect(wrapper!.find('.drive-batch-review').attributes('data-stage')).toBe('review')
		expect(wrapper!.find('.drive-batch-review').text()).toContain('Unpin selected')
		expect(sdk.driveChange).toHaveBeenCalledTimes(1)
	})
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return {promise, resolve}
}

const textFile = (name: string) => new File(['x'], name, {type: 'text/plain'})
const imageFile = (name: string) => new File(['x'], name, {type: 'image/png'})
const emptyList = {data: {files: [], total: 0, bytes: 0, categories: []}}

function uploaded(id: number) {
	return {data: file(id)}
}

async function chooseFiles(files: File[]) {
	const input = wrapper!.find('.drive-browser input[type=file]')
	Object.defineProperty(input.element, 'files', {value: files, configurable: true})
	await input.trigger('change')
	await flushPromises()
}

function dropEvent(files: File[]) {
	const event = new Event('drop', {bubbles: true, cancelable: true})
	Object.defineProperty(event, 'dataTransfer', {value: {
		items: files.map(item => ({kind: 'file', type: item.type})),
		files,
		dropEffect: 'none',
	}})
	return event
}

function statusText() {
	return wrapper!.find('.drive-upload-status').text()
}

async function openDetails(name = 'Details and usages') {
	await wrapper!.find('.drive-card').findAll('button').filter(button => button.text() === name)[0].trigger('click')
	await flushPromises()
}

describe('DriveBrowser uploads and details', () => {
	beforeEach(() => {
		sdk.driveList.mockResolvedValue(emptyList)
		sdk.driveUsages.mockResolvedValue({data: []})
	})

	it('asks the image question once for the whole selection and sends every file with that answer', async () => {
		sdk.driveUpload.mockImplementation(async () => uploaded(9))
		await mountBrowser()
		await flushPromises()

		await chooseFiles([imageFile('a.png'), imageFile('b.png'), textFile('c.txt')])
		expect(imagePrompt.value?.files.map(item => item.name)).toEqual(['a.png', 'b.png'])
		imagePrompt.value!.resolve({mode: 'original', quality: 0.8, maxSide: 0})
		await flushPromises()

		expect(imagePrompt.value).toBeNull()
		expect(sdk.driveUpload).toHaveBeenCalledTimes(3)
		for (const [options] of sdk.driveUpload.mock.calls) expect(options.headers).toHaveProperty(UPLOAD_CHOICE_HEADER)
		expect(statusText()).toContain('Uploaded 3 of 3 files')
	})

	it('uploads nothing after the image question is cancelled and says so', async () => {
		await mountBrowser()
		await flushPromises()

		await chooseFiles([imageFile('a.png'), textFile('c.txt')])
		imagePrompt.value!.resolve(null)
		await flushPromises()

		expect(sdk.driveUpload).not.toHaveBeenCalled()
		expect(statusText()).toContain('Upload cancelled after 0 of 2 files')
	})

	it('names a file that failed without a toast and retries only that file', async () => {
		sdk.driveUpload
			.mockResolvedValueOnce(uploaded(1))
			.mockRejectedValueOnce({message: 'The file is too large.'})
			.mockResolvedValueOnce(uploaded(3))
		await mountBrowser()
		await flushPromises()

		await chooseFiles([textFile('one.txt'), textFile('two.txt'), textFile('three.txt')])
		await flushPromises()

		const failed = wrapper!.find('.drive-upload-failed')
		expect(failed.attributes('role')).toBe('alert')
		expect(failed.text()).toContain('1 file couldn\'t be uploaded:')
		expect(failed.text()).toContain('two.txt')
		expect(failed.text()).toContain('The file is too large.')
		expect(statusText()).toContain('Uploaded 2 of 3 files')
		expect(error).not.toHaveBeenCalled()

		sdk.driveUpload.mockResolvedValueOnce(uploaded(2))
		await buttonsNamed('Retry failed files')[0].trigger('click')
		await flushPromises()

		expect(sdk.driveUpload).toHaveBeenCalledTimes(4)
		expect(sdk.driveUpload.mock.calls[3][0].body.file.name).toBe('two.txt')
		expect(wrapper!.find('.drive-upload-failed').exists()).toBe(false)
		expect(statusText()).toContain('Uploaded 1 of 1 files')
	})

	it('keeps a search typed while files upload', async () => {
		const pending = deferred<unknown>()
		sdk.driveUpload.mockReturnValueOnce(pending.promise)
		await mountBrowser()
		await flushPromises()

		await chooseFiles([textFile('one.txt')])
		await wrapper!.find('input[type=search]').setValue('invoice')
		pending.resolve(uploaded(1))
		await flushPromises()

		expect((wrapper!.find('input[type=search]').element as HTMLInputElement).value).toBe('invoice')
	})

	it('keeps an open recycled file in recycle-bin mode when an upload switches the page back to the library', async () => {
		sdk.driveList.mockImplementation(async ({query}: {query: {trash?: boolean}}) => query.trash
			? {data: {files: [file(5, {trashed_at: '2026-10-31T09:00:00Z'})], total: 1, bytes: 1, categories: []}}
			: emptyList)
		const pending = deferred<unknown>()
		sdk.driveUpload.mockReturnValueOnce(pending.promise)
		await mountBrowser()
		await flushPromises()
		await buttonsNamed('Recycle bin')[0].trigger('click')
		await flushPromises()
		await openDetails()
		expect(buttonsNamed('Delete permanently')).toHaveLength(1)

		await chooseFiles([textFile('one.txt')])
		pending.resolve(uploaded(1))
		await flushPromises()

		// The page shows the library again (to reveal the upload); the dialog still treats its file as recycled.
		expect(buttonsNamed('Back to files')).toHaveLength(0)
		expect(wrapper!.find('.drive-details').exists()).toBe(true)
		expect(buttonsNamed('Delete permanently')).toHaveLength(1)
		expect(buttonsNamed('Save')).toHaveLength(0)
		expect(wrapper!.find('.drive-details input.input').attributes('disabled')).toBeDefined()
	})

	it('refreshes the fields another window changed and keeps the user\'s own change when saving fails', async () => {
		let revision = 1
		sdk.driveList.mockImplementation(async () => ({data: {
			files: [revision === 1 ? file(1) : file(1, {revision: 2, file: {id: 1, name: 'Contract.pdf', mime: 'application/pdf', size: 1, created: '2026-10-30T09:00:00Z'}})],
			total: 1,
			bytes: 1,
			categories: [],
		}}))
		sdk.driveChange.mockImplementationOnce(async () => {
			revision = 2
			throw {detail: 'drive_changed'}
		})
		await mountBrowser()
		await flushPromises()
		await openDetails()

		const [nameInput, categoryInput] = wrapper!.findAll('.drive-details input.input')
		await categoryInput.setValue('Work')
		await buttonsNamed('Save')[0].trigger('click')
		await flushPromises()

		expect((wrapper!.findAll('.drive-details input.input')[0].element as HTMLInputElement).value).toBe('Contract.pdf')
		expect((wrapper!.findAll('.drive-details input.input')[1].element as HTMLInputElement).value).toBe('Work')
		expect(nameInput.exists()).toBe(true)

		sdk.driveChange.mockResolvedValueOnce({data: file(1, {revision: 3})})
		await buttonsNamed('Save')[0].trigger('click')
		await flushPromises()
		expect(sdk.driveChange.mock.calls[1][0].body).toMatchObject({revision: 2, name: 'Contract.pdf', category: 'Work'})
	})

	it('keeps keyboard focus in Drive after a file was moved to the recycle bin', async () => {
		sdk.driveList.mockResolvedValueOnce({data: {files: [file(1)], total: 1, bytes: 1, categories: []}})
		sdk.driveChange.mockResolvedValue({data: file(1, {revision: 2, trashed_at: '2026-10-31T09:00:00Z'})})
		await mountBrowser()
		await flushPromises()

		const trigger = wrapper!.find('.drive-card').findAll('button').filter(button => button.text() === 'Move to recycle bin')[0]
		;(trigger.element as HTMLElement).focus()
		await trigger.trigger('click')
		await flushPromises()
		await wrapper!.find('.drive-detail-actions').findAll('button').filter(button => button.text() === 'Move to recycle bin')[0].trigger('click')
		await flushPromises()

		expect(wrapper!.find('.drive-details').exists()).toBe(false)
		expect(document.activeElement).toBe(wrapper!.find('.drive-summary').element)
	})

	it('shows no file count or storage total when the list fails to load', async () => {
		sdk.driveList.mockRejectedValue(new Error('offline'))
		await mountBrowser()
		await flushPromises()

		expect(wrapper!.text()).toContain('Could not load files')
		expect(wrapper!.find('.drive-summary').text()).toBe('')
	})

	it('asks before leaving while files upload and cancels them only when told to', async () => {
		const pending = deferred<unknown>()
		let signal: AbortSignal | undefined
		sdk.driveUpload.mockImplementationOnce(({signal: requestSignal}: {signal: AbortSignal}) => {
			signal = requestSignal
			return pending.promise
		})
		await mountBrowser()
		await flushPromises()
		await chooseFiles([textFile('one.txt'), textFile('two.txt')])

		await router.push('/elsewhere')
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/')
		expect(wrapper!.find('.drive-leave').text()).toContain('Uploads are still running')

		await buttonsNamed('Keep uploading')[0].trigger('click')
		await flushPromises()
		expect(wrapper!.find('.drive-leave').exists()).toBe(false)

		await router.push('/elsewhere')
		await flushPromises()
		await buttonsNamed('Leave and cancel uploads')[0].trigger('click')
		await flushPromises()
		expect(router.currentRoute.value.path).toBe('/elsewhere')
		expect(signal?.aborted).toBe(true)
	})

	it('says that files dropped during an upload were not added', async () => {
		const pending = deferred<unknown>()
		sdk.driveUpload.mockReturnValueOnce(pending.promise)
		await mountBrowser()
		await flushPromises()
		await chooseFiles([textFile('one.txt')])

		wrapper!.find('.drive-browser').element.dispatchEvent(dropEvent([textFile('late.txt')]))
		await flushPromises()
		expect(wrapper!.text()).toContain('Files dropped during an upload weren\'t added.')

		pending.resolve(uploaded(1))
		await flushPromises()
		expect(sdk.driveUpload).toHaveBeenCalledTimes(1)
	})
})
