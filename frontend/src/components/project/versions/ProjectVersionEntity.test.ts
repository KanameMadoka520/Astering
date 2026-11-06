// @vitest-environment jsdom
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
import {createI18n} from 'vue-i18n'
import en from '@/i18n/lang/en.json'
import ProjectVersionEntity from './ProjectVersionEntity.vue'
import {projectVersionKeys} from '@/client/queries/projectVersions'

const entity = vi.hoisted(() => ({
	content: {} as Record<string, unknown>,
	current_content: {} as Record<string, unknown>,
}))
vi.mock('@/client/generated', () => ({
	projectVersionEntityRead: vi.fn(async () => ({data: entity})),
}))
const clients: QueryClient[] = []
afterEach(() => clients.splice(0).forEach(client => client.clear()))
async function inspect(kind = 'view', changedFields?: string[]) {
	const client = new QueryClient()
	clients.push(client)
	client.setQueryData(projectVersionKeys.entity(1, 2, kind, '3'), entity)
	const wrapper = mount(ProjectVersionEntity, {
		props: {
			project: 1,
			version: 2,
			kind,
			entity: '3',
			changedFields,
		},
		global: {
			plugins: [createI18n({
				legacy: false,
				locale: 'en',
				messages: {en},
			}), [VueQueryPlugin, {queryClient: client}]],
			stubs: {
				ProjectVersionFile: true,
				XButton: {template: '<button><slot /></button>'},
			},
		},
	})
	await flushPromises()
	return wrapper
}

describe('historical content presentation', () => {
	it('defaults to actual changed fields and lets the reader switch to all available fields', async () => {
		entity.content = {title: 'Saved title', description: '<p>Unchanged body</p>'}
		entity.current_content = {title: 'Current title', description: '<p>Unchanged body</p>'}
		const wrapper = await inspect('task', ['title'])
		expect(wrapper.text()).toContain('Saved title')
		expect(wrapper.text()).toContain('Current title')
		expect(wrapper.text()).not.toContain('Unchanged body')
		expect(wrapper.get('button').text()).toBe('View all fields')
		await wrapper.get('button').trigger('click')
		expect(wrapper.text()).toContain('Unchanged body')
		expect(wrapper.get('button').text()).toBe('Only show changes')
		await wrapper.get('button').trigger('click')
		expect(wrapper.text()).not.toContain('Unchanged body')
		wrapper.unmount()
	})

	it('keeps nested bucket filters visible alongside their rule names', async () => {
		entity.content = {
			bucket_configuration: [{
				title: 'Ready',
				filter: {
					filter: 'done = false',
					s: 'launch',
				},
			}],
		}
		entity.current_content = {
			bucket_configuration: [{
				title: 'Ready',
				filter: {
					filter: 'priority = 5',
					s: 'current',
				},
			}],
		}
		const wrapper = await inspect()
		expect(wrapper.text()).toContain('done = false')
		expect(wrapper.text()).toContain('priority = 5')
		expect(wrapper.text()).toContain('Search: launch')
		wrapper.unmount()
	})

	it('renders readable body text without executing scripts or loading external body images', async () => {
		entity.content = {description: '<p>Saved body</p><script>window.compromised=true</script><img src="https://external.invalid/image.png">'}
		entity.current_content = {description: '<p>Current body</p><img src="https://external.invalid/current.png">'}
		const wrapper = await inspect('task')
		expect(wrapper.text()).toContain('Saved body')
		expect(wrapper.text()).toContain('Current body')
		expect(wrapper.find('script').exists()).toBe(false)
		expect(wrapper.find('img').exists()).toBe(false)
		wrapper.unmount()
	})
})
