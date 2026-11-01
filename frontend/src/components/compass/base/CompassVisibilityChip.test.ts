import {afterEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount, type VueWrapper} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'

const sdk = vi.hoisted(() => ({teamsRead: vi.fn()}))
vi.mock('@/client/generated', async original => ({...await original<typeof import('@/client/generated')>(), ...sdk}))
vi.mock('vue-i18n', async original => ({
	...await original<typeof import('vue-i18n')>(),
	useI18n: () => ({t: (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key}),
}))

import CompassVisibilityChip from './CompassVisibilityChip.vue'

let wrapper: VueWrapper | undefined

async function setup(teamId: number) {
	wrapper = mount(CompassVisibilityChip, {
		props: {teamId},
		global: {
			plugins: [[VueQueryPlugin, {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}]],
			stubs: {Icon: true},
		},
	})
	await flushPromises()
	return wrapper
}

afterEach(() => {
	wrapper?.unmount()
	wrapper = undefined
	sdk.teamsRead.mockReset()
})

describe('CompassVisibilityChip', () => {
	it('says only you can read a personal space', async () => {
		const chip = await setup(0)
		expect(chip.text()).toContain('compass.visibility.onlyYou')
		expect(chip.attributes('title')).toBe('compass.space.personalHint')
		expect(sdk.teamsRead).not.toHaveBeenCalled()
	})

	it('names the team that can read a team space', async () => {
		sdk.teamsRead.mockResolvedValue({data: {id: 4, name: 'Family'}})
		const chip = await setup(4)
		expect(chip.text()).toContain('compass.space.team {"team":"Family"}')
		expect(chip.attributes('title')).toContain('compass.space.teamHint')
	})
})
