import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createPinia, setActivePinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({sharesList: vi.fn(), sharesCreate: vi.fn(), sharesDelete: vi.fn(), projectsRead: vi.fn()}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

import LinkSharing from './LinkSharing.vue'
import {linkShareKeys} from '@/client/queries/linkShares'
import {projectKeys, type ProjectResponse} from '@/client/queries/projects'
import en from '@/i18n/lang/en.json'

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})

const PROJECT = {id: 7, title: 'Project', views: []} as unknown as ProjectResponse

let client: QueryClient
let wrapper: VueWrapper | undefined

beforeEach(() => {
	vi.resetAllMocks()
	vi.useFakeTimers()
	setActivePinia(createPinia())
	client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
	client.setQueryData(linkShareKeys.list(7), [])
	client.setQueryData(projectKeys.detail(7), PROJECT)
	sdk.sharesList.mockResolvedValue({data: {items: [], total_pages: 1}})
})

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	vi.useRealTimers()
})

function buttonByText(text: string) {
	const button = wrapper!.findAll('button').find(candidate => candidate.text() === text)
	if (!button) throw new Error(`No button "${text}"`)
	return button
}

describe('LinkSharing', () => {
	it.each([
		['succeeds', () => sdk.sharesCreate.mockResolvedValue({data: {id: 1, hash: 'public-hash'}})],
		['fails', () => sdk.sharesCreate.mockRejectedValue(new Error('nope'))],
	])('keeps no password in the mutation cache after a create %s', async (_outcome, arrange) => {
		arrange()
		wrapper = mount(LinkSharing, {
			// Share submits the create form, which jsdom only does for a connected form.
			attachTo: document.body,
			props: {project: PROJECT},
			global: {
				plugins: [i18n, [VueQueryPlugin, {queryClient: client}]],
				stubs: {
					XButton: {template: '<button type="button" v-bind="$attrs"><slot /></button>'},
					Modal: true,
					Icon: true,
				},
				directives: {tooltip: {}},
			},
		})
		await buttonByText('Create a link share').trigger('click')
		await wrapper.get('#linkShareName').setValue('Client')
		await wrapper.get('#linkSharePassword').setValue('secret')
		await buttonByText('Share').trigger('click')
		await flushPromises()
		await vi.advanceTimersByTimeAsync(0)

		expect(sdk.sharesCreate).toHaveBeenCalledWith(expect.objectContaining({body: expect.objectContaining({password: 'secret'})}))
		expect(client.getMutationCache().getAll().some(mutation => JSON.stringify(mutation.state.variables ?? null).includes('secret'))).toBe(false)
	})
})

describe('LinkSharing: who a link lets in', () => {
	function mountWith(shares: unknown[]) {
		client.setQueryData(linkShareKeys.list(7), shares)
		wrapper = mount(LinkSharing, {
			attachTo: document.body,
			props: {project: PROJECT},
			global: {
				plugins: [i18n, [VueQueryPlugin, {queryClient: client}]],
				stubs: {
					XButton: {template: '<button type="button" v-bind="$attrs"><slot /></button>'},
					Modal: true,
					Icon: true,
				},
				directives: {tooltip: {}},
			},
		})
		return wrapper
	}

	it('marks which links need a password and which open for anyone', () => {
		mountWith([
			{id: 1, hash: 'a', name: 'Locked', permission: 0, sharing_type: 2},
			{id: 2, hash: 'b', name: 'Open', permission: 0, sharing_type: 1},
			{id: 3, hash: 'c', name: 'Unknown', permission: 0},
		])

		const rows = wrapper!.findAll('tbody tr')
		expect(rows[0].text()).toContain('Password protected')
		expect(rows[1].text()).toContain('No password: anyone with the link')
		// An unknown type claims neither.
		expect(rows[2].text()).not.toContain('Password protected')
		expect(rows[2].text()).not.toContain('No password')
	})

	it('warns that an admin link gives admin access without signing in', async () => {
		mountWith([])
		await buttonByText('Create a link share').trigger('click')
		const warning = 'Anyone with this link gets admin access to this project without signing in.'
		expect(wrapper!.text()).not.toContain(warning)

		const select = wrapper!.find('select')
		await select.setValue('2')

		expect(wrapper!.text()).toContain(warning)
		const help = wrapper!.find('.link-share-admin-warning')
		expect(select.attributes('aria-describedby')).toBe(help.attributes('id'))
	})
})
