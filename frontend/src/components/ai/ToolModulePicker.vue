<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import Popup from '@/components/misc/Popup.vue'
import ToolModuleControls from './ToolModuleControls.vue'
import {effectiveModuleAccess, toolModuleIDs, type ToolModules} from '@/helpers/assistantProfiles'

const props = defineProps<{modules: ToolModules, mode: 'read' | 'write', disabled?: boolean, mcpSelected?: boolean}>()
const emit = defineEmits<{change: [selection: {tool_modules: ToolModules, mode: 'read' | 'write'}]}>()
const {t} = useI18n({useScope: 'global'})
const anchor = ref<HTMLButtonElement>()
const open = ref(false)
const count = computed(() => toolModuleIDs.filter(id => effectiveModuleAccess(props.modules, id, props.mode) !== 'off').length)
const summary = computed(() => toolModuleIDs.map(id => `${t(`toolModules.${id}`)}: ${t(`toolModules.${effectiveModuleAccess(props.modules, id, props.mode)}`)}`).join(' · '))
</script>

<template>
	<Popup
		v-model:open="open"
		:anchor="anchor"
		placement="top-start"
		sheet-on-mobile
		:sheet-title="t('toolModules.title')"
		surface
	>
		<template #trigger="{toggle}">
			<button
				ref="anchor"
				type="button"
				class="tool-module-trigger"
				:aria-label="t('toolModules.title')"
				:aria-expanded="open"
				:title="summary"
				@click="toggle"
			>
				<Icon
					icon="layer-group"
					aria-hidden="true"
				/>
				<span>{{ t('toolModules.shortTitle') }} · {{ count }}</span>
			</button>
		</template>
		<template #content="{close}">
			<section
				class="tool-module-picker"
				:aria-label="t('toolModules.title')"
				@keydown.esc.prevent.stop="close(); anchor?.focus()"
			>
				<h3>{{ t('toolModules.title') }}</h3>
				<p
					v-if="disabled"
					role="status"
				>
					{{ t('toolModules.locked') }}
				</p>
				<ToolModuleControls
					:modules="modules"
					:mode="mode"
					:disabled="disabled"
					:mcp-selected="mcpSelected"
					@change="emit('change', $event)"
				/>
			</section>
		</template>
	</Popup>
</template>

<style lang="scss" scoped>
.tool-module-trigger {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: 2.75rem;
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-full);
	background: var(--surface);
	color: var(--text-secondary);
	font: inherit;
	font-size: var(--text-xs);
	cursor: pointer;

	&:focus-visible {
		@include focus-ring;
	}
}

.tool-module-picker {
	inline-size: min(25rem, calc(100vw - var(--space-8)));
	max-inline-size: 100%;
	padding: var(--space-4);
	color: var(--text-primary);

	h3 {
		margin-block-end: var(--space-3);
		font-size: var(--text-md);

		@media (width <= 640px) {
			display: none;
		}
	}
}
</style>
