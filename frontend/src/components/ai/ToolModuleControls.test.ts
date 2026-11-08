import {describe, expect, it, vi} from 'vitest'
import {mount} from '@vue/test-utils'

vi.mock('vue-i18n', () => ({useI18n: () => ({t: (key: string) => key})}))
import ToolModuleControls from './ToolModuleControls.vue'

describe('tool capability permission changes', () => {
	it('raises only Notes after explicit MCP confirmation and rejects changes while execution is locked', async () => {
		const wrapper = mount(ToolModuleControls, {props: {
			modules: {project_tasks: 'write', compass: 'write', notes: 'off'},
			mode: 'read', mcpSelected: true,
		}})
		await wrapper.get('select[aria-label="toolModules.notes"]').setValue('write')
		expect(wrapper.emitted('change')).toBeUndefined()
		await wrapper.get('.tool-modules__confirmation .is-primary').trigger('click')
		expect(wrapper.emitted('change')).toEqual([[{
			tool_modules: {project_tasks: 'read', compass: 'read', notes: 'write'}, mode: 'write',
		}]])
		await wrapper.setProps({disabled: true})
		await wrapper.get('select[aria-label="toolModules.notes"]').setValue('off')
		expect(wrapper.emitted('change')).toHaveLength(1)
		wrapper.unmount()
	})
	it('requires an explicit confirmation before raising the write ceiling of selected MCP connections', async () => {
		const wrapper = mount(ToolModuleControls, {props: {
			modules: {project_tasks: 'write', compass: 'off', notes: 'off'}, mode: 'read', mcpSelected: true,
		}})
		await wrapper.get('select[aria-label="toolModules.compass"]').setValue('write')
		expect(wrapper.emitted('change')).toBeUndefined()
		expect(wrapper.text()).toContain('toolModules.mcpWriteHelp')
		await wrapper.get('.tool-modules__confirmation .is-primary').trigger('click')
		expect(wrapper.emitted('change')).toEqual([[{
			tool_modules: {project_tasks: 'read', compass: 'write', notes: 'off'}, mode: 'write',
		}]])
		wrapper.unmount()
	})
	it('cancels the proposal if the running turn locks settings before confirmation', async () => {
		const wrapper = mount(ToolModuleControls, {props: {
			modules: {project_tasks: 'write', compass: 'off', notes: 'off'}, mode: 'read', mcpSelected: true,
		}})
		await wrapper.get('select[aria-label="toolModules.compass"]').setValue('write')
		await wrapper.setProps({disabled: true})
		expect(wrapper.find('.tool-modules__confirmation').exists()).toBe(false)
		await wrapper.get('select[aria-label="toolModules.project_tasks"]').setValue('off')
		expect(wrapper.emitted('change')).toBeUndefined()
		wrapper.unmount()
	})
	it('applies a local write choice directly when no MCP connections are selected', async () => {
		const wrapper = mount(ToolModuleControls, {props: {
			modules: {project_tasks: 'write', compass: 'off', notes: 'off'}, mode: 'read',
		}})
		await wrapper.get('select[aria-label="toolModules.compass"]').setValue('write')
		expect(wrapper.find('.tool-modules__confirmation').exists()).toBe(false)
		expect(wrapper.emitted('change')).toEqual([[{
			tool_modules: {project_tasks: 'read', compass: 'write', notes: 'off'}, mode: 'write',
		}]])
		wrapper.unmount()
	})
})
