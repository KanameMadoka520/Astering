import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent} from 'vue'
import {createPinia} from 'pinia'
import {mount} from '@vue/test-utils'
import {QueryClient, QueryObserver, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({
	projectCompletion: vi.fn(),
	projectHistory: vi.fn(),
	projectsList: vi.fn(),
	projectsRead: vi.fn(),
}))
vi.mock('@/client/generated', async importOriginal => ({
	...await importOriginal<typeof import('@/client/generated')>(),
	...sdk,
}))
const toast = vi.hoisted(() => ({success: vi.fn()}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: toast.success,
}))

import {projectKeys, type ProjectListResult, type ProjectResponse} from './projects'
import {useProjectCompletionMutation} from './projectHistory'

const PROJECT = {
	id: 4,
	title: 'Launch',
	is_completed: false,
} as ProjectResponse

describe('project completion', () => {
	let client: QueryClient
	let unsubscribe: (() => void)[] = []

	function completion() {
		let mutation!: ReturnType<typeof useProjectCompletionMutation>
		mount(defineComponent({
			setup() {
				mutation = useProjectCompletionMutation()
				return () => null
			},
		}), {global: {plugins: [[VueQueryPlugin, {queryClient: client}], createPinia()]}})
		return mutation
	}
	// The sidebar keeps the paged project list mounted.
	function observeList() {
		const observer = new QueryObserver(client, {
			queryKey: projectKeys.list(),
			queryFn: () => sdk.projectsList(),
			staleTime: Infinity,
		})
		unsubscribe.push(observer.subscribe(() => undefined))
	}

	beforeEach(() => {
		client = new QueryClient({defaultOptions: {queries: {retry: false}}})
		client.setQueryData<ProjectListResult>(projectKeys.list(), {
			projects: [PROJECT],
			favoriteProject: null,
			savedFilterProjects: [],
		})
		client.setQueryData(projectKeys.detail(PROJECT.id), PROJECT)
		// Every page of a large account takes long; nothing here should wait for it.
		sdk.projectsList.mockReset().mockImplementation(() => new Promise(() => undefined))
		sdk.projectsRead.mockReset().mockImplementation(() => new Promise(() => undefined))
		sdk.projectCompletion.mockReset().mockImplementation(async () => ({data: {...PROJECT, is_completed: true}}))
		toast.success.mockReset()
	})
	afterEach(() => {
		unsubscribe.forEach(stop => stop())
		unsubscribe = []
	})

	it('settles once saved, with the project marked in the list, and without reloading the list', async () => {
		observeList()
		const mutation = completion()
		let settled = false
		void mutation.mutateAsync({id: PROJECT.id, completed: true}).then(() => { settled = true })
		await vi.waitFor(() => expect(settled).toBe(true))

		expect(client.getQueryData<ProjectListResult>(projectKeys.list())?.projects[0]?.is_completed).toBe(true)
		expect(client.getQueryData<ProjectResponse>(projectKeys.detail(PROJECT.id))?.is_completed).toBe(true)
		expect(sdk.projectsList).not.toHaveBeenCalled()
		expect(client.getQueryState(projectKeys.list())?.isInvalidated).toBe(true)
		expect(toast.success).toHaveBeenCalledTimes(1)
	})
})
