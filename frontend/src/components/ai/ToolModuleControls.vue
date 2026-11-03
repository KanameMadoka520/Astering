<script setup lang="ts">
import {ref, useId, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {changeModuleAccess, effectiveModuleAccess, toolModuleIDs, type ToolModuleAccess, type ToolModuleID, type ToolModules} from '@/helpers/assistantProfiles'

const props = defineProps<{modules: ToolModules, mode: 'read' | 'write', disabled?: boolean, mcpSelected?: boolean}>()
const emit = defineEmits<{change: [selection: {tool_modules: ToolModules, mode: 'read' | 'write'}]}>()
const {t} = useI18n({useScope: 'global'})
const id = useId()
const pending = ref<{module: ToolModuleID, access: ToolModuleAccess}>()
watch([() => props.modules, () => props.mode, () => props.disabled, () => props.mcpSelected], () => {pending.value = undefined})
function update(module: ToolModuleID, value: string) {
	if (props.disabled || !['off', 'read', 'write'].includes(value)) return
	if (value === 'write' && props.mode === 'read' && props.mcpSelected) {
		pending.value = {module, access: value}
		return
	}
	pending.value = undefined
	emit('change', changeModuleAccess(props.modules, props.mode, module, value as ToolModuleAccess))
}
function confirm() {
	if (!pending.value || props.disabled) return
	const {module, access} = pending.value
	pending.value = undefined
	emit('change', changeModuleAccess(props.modules, props.mode, module, access))
}
</script>

<template>
	<div
		class="tool-modules"
		role="group"
		:aria-label="t('toolModules.title')"
	>
		<p class="tool-modules__help">
			{{ t('toolModules.help') }}
		</p>
		<label
			v-for="module in toolModuleIDs"
			:key="module"
			class="tool-modules__row"
		>
			<span><strong>{{ t(`toolModules.${module}`) }}</strong><small :id="`${id}-${module}`">{{ t(`toolModules.${module}Help`) }}</small></span>
			<select
				:value="effectiveModuleAccess(modules, module, mode)"
				:aria-label="t(`toolModules.${module}`)"
				:aria-describedby="`${id}-${module}`"
				:disabled="disabled"
				class="input"
				@change="update(module, ($event.target as HTMLSelectElement).value)"
			>
				<option
					v-for="access in (['off', 'read', 'write'] as const)"
					:key="access"
					:value="access"
				>{{ t(`toolModules.${access}`) }}</option>
			</select>
		</label>
		<div
			v-if="pending"
			class="tool-modules__confirmation"
			role="group"
			:aria-label="t('toolModules.mcpWriteTitle')"
		>
			<p>{{ t('toolModules.mcpWriteHelp') }}</p>
			<div>
				<button
					type="button"
					class="button is-primary"
					:disabled="disabled"
					@click="confirm"
				>
					{{ t('toolModules.confirmWrite') }}
				</button>
				<button
					type="button"
					class="button"
					@click="pending = undefined"
				>
					{{ t('misc.cancel') }}
				</button>
			</div>
		</div>
		<p class="tool-modules__help">
			{{ t('toolModules.boundary') }}
		</p>
	</div>
</template>

<style lang="scss" scoped>
.tool-modules {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;
}

.tool-modules__row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(6rem, 8rem);
	align-items: center;
	gap: var(--space-3);
	padding-block: var(--space-2);
	border-block-end: 1px solid var(--border-subtle);

	span {
		min-inline-size: 0;
	}

	strong, small {
		display: block;
	}

	small {
		margin-block-start: var(--space-1);
		color: var(--text-secondary);
		font-size: var(--text-xs);
		line-height: var(--leading-normal);
	}

	select {
		min-block-size: 2.75rem;
		font-size: var(--text-sm);
	}
}

.tool-modules__help {
	color: var(--text-secondary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.tool-modules__confirmation {
	display: grid;
	gap: var(--space-3);
	padding: var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);

	> div {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
}
</style>
