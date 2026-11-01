import {describe, it, expect} from 'vitest'
import {mount, flushPromises} from '@vue/test-utils'
import {createMemoryHistory, createRouter} from 'vue-router'
import PaginationItem from './PaginationItem.vue'

const mountItem = (props: Record<string, unknown>) => mount(PaginationItem, {
	props: {
		variant: 'previous',
		...props,
	},
	slots: {
		default: 'Previous',
	},
	global: {
		stubs: {
			RouterLink: {
				template: '<a :href="typeof to === \'string\' ? to : \'#\'"><slot /></a>',
				props: ['to'],
			},
		},
	},
})

describe('PaginationItem', () => {
	it('renders a link when enabled', () => {
		const wrapper = mountItem({to: '/projects/1/1?page=2'})
		expect(wrapper.find('a').exists()).toBe(true)
	})

	it('keeps a disabled link focusable but marks it disabled and does not follow it', async () => {
		const router = createRouter({history: createMemoryHistory(), routes: [{path: '/list', name: 'list', component: {template: '<div />'}}]})
		await router.push('/list?page=1')
		const wrapper = mount(PaginationItem, {
			props: {variant: 'previous', disabled: true, to: {name: 'list', query: {page: 0}}},
			slots: {default: 'Previous'},
			global: {plugins: [router]},
		})
		const link = wrapper.get('a')
		expect(link.attributes('aria-disabled')).toBe('true')
		expect(link.attributes('href')).toBeDefined()

		await link.trigger('click')
		await flushPromises()
		expect(router.currentRoute.value.query.page).toBe('1')
	})

	it('does not report a click on a disabled button', async () => {
		const wrapper = mountItem({disabled: true})
		await wrapper.get('button').trigger('click')
		expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
		expect(wrapper.emitted('click')).toBeUndefined()
	})

	it('marks only the current page with aria-current, although the router ignores the query', async () => {
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [{
				path: '/list',
				name: 'list',
				component: {template: '<div />'},
			}],
		})
		await router.push({
			name: 'list',
			query: {page: 2},
		})
		const mountLink = (page: number, isCurrent: boolean) => mount(PaginationItem, {
			props: {
				variant: 'link',
				isCurrent,
				to: {
					name: 'list',
					query: {page},
				},
			},
			slots: {default: String(page)},
			global: {plugins: [router]},
		})

		const current = mountLink(2, true)
		const other = mountLink(3, false)
		await flushPromises()

		expect(current.find('a').attributes('aria-current')).toBe('page')
		expect(other.find('a').attributes('aria-current')).toBe('false')
	})
})
