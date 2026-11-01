import {afterEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'
import {useAronaLinks} from './useAronaLinks'

vi.mock('@/message', () => ({error: vi.fn()}))

let wrapper: VueWrapper | undefined
afterEach(() => wrapper?.unmount())

async function setup(base = '/') {
	const view = {render: () => null}
	const router = createRouter({history: createMemoryHistory(base), routes: [
		{path: '/ai', name: 'tcy-ai', component: view},
		{path: '/projects/:project/:view', name: 'project.view', component: view},
		{path: '/tasks/:id', name: 'task.detail', component: view},
		{path: '/p/:slug', name: 'tcy-public', component: view},
		{path: '/login', name: 'user.login', component: view},
		{path: '/:pathMatch(.*)*', name: 'not-found', component: view},
	]})
	await router.push('/ai?chat=kept')
	let follow!: ReturnType<typeof useAronaLinks>
	wrapper = mount(defineComponent({setup() {
		follow = useAronaLinks()
		return () => h('div')
	}}), {global: {plugins: [router]}})
	return {
		router,
		async click(href: string, options: MouseEventInit = {}, download = false, kind: 'a' | 'area' | 'svg' = 'a') {
			const root = document.createElement('div')
			const anchor = kind === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'a') : document.createElement(kind)
			anchor.setAttribute(kind === 'svg' ? 'xlink:href' : 'href', href)
			anchor.setAttribute('target', '_blank')
			if (download) anchor.setAttribute('download', '')
			const child = document.createElement('strong')
			anchor.append(child)
			root.append(anchor)
			const event = new MouseEvent('click', {cancelable: true, ...options})
			Object.defineProperties(event, {target: {value: child}, currentTarget: {value: root}})
			follow(event)
			await flushPromises()
			return event
		},
	}
}

describe('Arona link navigation', () => {
	it.each(['/projects/7/35?view=kanban#task', `${location.origin}/projects/7/35?view=kanban#task`])('routes %s inside the app, including clicks on nested text', async href => {
		const {router, click} = await setup()
		expect((await click(href)).defaultPrevented).toBe(true)
		expect(router.currentRoute.value.fullPath).toBe('/projects/7/35?view=kanban#task')
	})

	it('keeps the deployment base boundary and task modal backdrop', async () => {
		const {router, click} = await setup('/workspace/')
		expect((await click('/workspace/tasks/5?from=arona#comment-2')).defaultPrevented).toBe(true)
		expect(router.currentRoute.value.fullPath).toBe('/tasks/5?from=arona#comment-2')
		expect(router.options.history.state.backdropView).toBe('/ai?chat=kept')
	})

	it.each(['area', 'svg'] as const)('also routes internal %s links without a document navigation', async kind => {
		const {router, click} = await setup()
		expect((await click('/tasks/5', {}, false, kind)).defaultPrevented).toBe(true)
		expect(router.currentRoute.value.fullPath).toBe('/tasks/5')
	})

	it.each([
		'https://external.example/projects/7/35',
		'//external.example/projects/7/35',
		'/api/v2/files/12', '/assets/app.js', '/unrecognized', '/p/public', '/login',
		'mailto:friend@example.com', 'tel:+123456',
	])('leaves %s to the browser without replacing the app route', async href => {
		const {router, click} = await setup()
		expect((await click(href)).defaultPrevented).toBe(false)
		expect(router.currentRoute.value.fullPath).toBe('/ai?chat=kept')
	})

	it.each(['/tasks/5', '/workspace-other/tasks/5'])('does not route %s outside the deployed base', async href => {
		const {router, click} = await setup('/workspace/')
		expect((await click(href)).defaultPrevented).toBe(false)
		expect(router.currentRoute.value.fullPath).toBe('/ai?chat=kept')
	})

	it.each([{ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {altKey: true}, {button: 1}])('preserves browser modified/middle clicks %j', async options => {
		const {router, click} = await setup()
		expect((await click('/tasks/5', options)).defaultPrevented).toBe(false)
		expect(router.currentRoute.value.fullPath).toBe('/ai?chat=kept')
	})

	it('preserves downloads and respects a navigation cancelled by a route guard', async () => {
		const {router, click} = await setup()
		expect((await click('/tasks/5', {}, true)).defaultPrevented).toBe(false)
		router.beforeEach(() => false)
		expect((await click('/tasks/5')).defaultPrevented).toBe(true)
		expect(router.currentRoute.value.fullPath).toBe('/ai?chat=kept')
	})
})
