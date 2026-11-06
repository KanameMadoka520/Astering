import {
	afterEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {
	flushPromises,
	mount,
} from '@vue/test-utils'
import {
	QueryClient,
	VueQueryPlugin,
} from '@tanstack/vue-query'
import ProjectVersionFile from './ProjectVersionFile.vue'

const sdk = vi.hoisted(() => ({projectVersionFileRead: vi.fn()}))
const download = vi.hoisted(() => vi.fn())
vi.mock('@/client/generated', () => sdk)
vi.mock('@/helpers/downloadBlob', () => ({downloadBlob: download}))
vi.mock('@/client/requestContext', () => ({
	captureClientRequestContext: () => 1,
	assertClientRequestContext: vi.fn(),
	isClientRequestContextCurrent: () => true,
	isRequestContextAbort: () => false,
}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
	getErrorText: () => 'Failed',
	translatedError: (text: string) => new Error(text),
}))
vi.mock('vue-i18n', async importOriginal => ({
	...await importOriginal<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string) => key}),
}))

const clients: QueryClient[] = []
afterEach(() => {
	clients.splice(0).forEach(client => client.clear())
	vi.clearAllMocks()
})
function file() {
	const client = new QueryClient()
	clients.push(client)
	return mount(ProjectVersionFile, {
		props: {
			project: 1,
			version: 2,
			file: 3,
			name: 'Original.png',
		},
		global: {
			plugins: [[VueQueryPlugin, {queryClient: client}]],
			stubs: {XButton: {template: '<button><slot /></button>'}},
		},
	})
}

describe('checkpoint file download lifetime', () => {
	it('aborts on unmount and never starts a browser download from a late transport response', async () => {
		let finish!: (value: unknown) => void
		sdk.projectVersionFileRead.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
		const wrapper = file()
		await wrapper.get('button').trigger('click')
		const signal = sdk.projectVersionFileRead.mock.calls[0][0].signal as AbortSignal
		wrapper.unmount()
		expect(signal.aborted).toBe(true)
		finish({data: new Blob(['bytes'], {type: 'image/png'})})
		await flushPromises()
		expect(download).not.toHaveBeenCalled()
	})

	it('a late response for the previous target cannot download or clear the new target’s pending state', async () => {
		const complete: ((value: unknown) => void)[] = []
		sdk.projectVersionFileRead.mockImplementation(() => new Promise(resolve => {complete.push(resolve)}))
		const wrapper = file()
		await wrapper.get('button').trigger('click')
		await wrapper.setProps({
			file: 4,
			name: 'Another.png',
		})
		await wrapper.get('button').trigger('click')
		expect(sdk.projectVersionFileRead).toHaveBeenCalledTimes(2)
		complete[0]({data: new Blob(['old bytes'], {type: 'image/png'})})
		await flushPromises()
		expect(download).not.toHaveBeenCalled()
		expect(wrapper.get('button').attributes('aria-disabled')).toBe('true')
		wrapper.unmount()
		complete[1]({data: new Blob(['new bytes'], {type: 'image/png'})})
		await flushPromises()
		expect(download).not.toHaveBeenCalled()
	})
})
