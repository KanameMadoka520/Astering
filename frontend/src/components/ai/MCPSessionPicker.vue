<script setup lang="ts">
import {
	computed,
	onBeforeUnmount,
	ref,
	useId,
	watch,
} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
} from '@/client/requestContext'
import {mcpSettingsQuery} from '@/client/queries/tcyMcp'
import Popup from '@/components/misc/Popup.vue'
import LoadError from '@/components/misc/state/LoadError.vue'

const props = withDefaults(defineProps<{
	modelValue: string[]
	disabled?: boolean
	writeScoped?: boolean
}>(), {
	disabled: false,
	writeScoped: false,
})
const emit = defineEmits<{'update:modelValue': [ids: string[]]}>()
const {t} = useI18n({useScope: 'global'})
const trigger = ref<HTMLButtonElement>()
const open = ref(false)
const panelID = useId()
const notice = ref('')
const owner = captureClientRequestContext()
let disposed = false
const current = () => !disposed && isClientRequestContextCurrent(owner)
const settings = useQuery({
	...mcpSettingsQuery(),
	enabled: computed(() => open.value || props.modelValue.length > 0),
})
const connections = computed(() => settings.data.value?.connections ?? [])
const selected = computed(() => new Set(props.modelValue))
const available = computed(() => new Set(connections.value
	.filter(connection => connection.enabled && connection.has_key).map(connection => connection.id)))

watch([
	() => settings.data.value,
	() => settings.isFetching.value,
	() => props.modelValue,
], ([value, fetching]) => {
	if (!value || fetching || settings.isError.value || !current()) return
	const ids = props.modelValue.filter(id => available.value.has(id))
	if (ids.length === props.modelValue.length) return
	notice.value = t('tcy.mcp.removedUnavailable')
	emit('update:modelValue', ids)
}, {immediate: true})
onBeforeUnmount(() => { disposed = true })

function toggle(id: string, enabled: boolean) {
	if (!current() || props.disabled || (enabled && !available.value.has(id))) return
	notice.value = ''
	emit('update:modelValue', enabled
		? [...new Set([...props.modelValue, id])]
		: props.modelValue.filter(value => value !== id))
}
</script>

<template>
	<Popup
		v-model:open="open"
		:anchor="trigger"
		placement="top-start"
		sheet-on-mobile
		:sheet-title="t('tcy.mcp.sessionTitle')"
		surface
	>
		<template #trigger="{toggle: toggleOpen}">
			<button
				ref="trigger"
				type="button"
				class="mcp-session-trigger"
				:class="{'has-selection': modelValue.length > 0}"
				:aria-label="t('tcy.mcp.sessionButton', {count: modelValue.length})"
				:aria-expanded="open"
				:aria-controls="panelID"
				:title="t('tcy.mcp.sessionTitle')"
				@click="toggleOpen"
			>
				<Icon
					icon="code"
					aria-hidden="true"
				/>
				<span>MCP</span>
				<span
					v-if="modelValue.length"
					class="mcp-session-trigger__count"
					aria-hidden="true"
				>{{ modelValue.length }}</span>
			</button>
		</template>
		<template #content="{close}">
			<div
				:id="panelID"
				class="mcp-session-picker"
				role="group"
				:aria-label="t('tcy.mcp.sessionTitle')"
				@keydown.esc.prevent.stop="close(); trigger?.focus()"
			>
				<p class="mcp-session-picker__title">
					{{ t('tcy.mcp.sessionTitle') }}
				</p>
				<p>{{ t('tcy.mcp.sessionHelp') }}</p>
				<p
					v-if="disabled"
					role="status"
				>
					{{ t('tcy.mcp.selectionLocked') }}
				</p>
				<LoadError
					v-if="settings.isError.value"
					:message="t('tcy.mcp.loadFailed')"
					:retry="() => settings.refetch()"
				/>
				<p
					v-else-if="settings.isPending.value"
					role="status"
				>
					{{ t('tcy.mcp.loading') }}
				</p>
				<div
					v-else-if="connections.length"
					class="mcp-session-picker__connections"
				>
					<label
						v-for="connection in connections"
						:key="connection.id"
						class="mcp-session-picker__connection"
					>
						<input
							type="checkbox"
							:checked="selected.has(connection.id)"
							:aria-label="connection.name"
							:aria-describedby="`${panelID}-${connection.id}`"
							:aria-disabled="disabled || !available.has(connection.id)"
							@click="(disabled || !available.has(connection.id)) && $event.preventDefault()"
							@change="toggle(connection.id, ($event.target as HTMLInputElement).checked)"
						>
						<span>
							<strong>{{ connection.name }}</strong>
							<small :id="`${panelID}-${connection.id}`">
								{{ t(!connection.enabled ? 'tcy.mcp.disabled' : !connection.has_key
									? 'tcy.mcp.needsKey' : connection.allow_write ? 'tcy.mcp.writeWithReview' : 'tcy.mcp.readOnly') }}
							</small>
						</span>
					</label>
				</div>
				<p v-else>
					{{ t('tcy.mcp.sessionEmpty') }}
				</p>
				<p
					v-if="notice"
					role="status"
				>
					{{ notice }}
				</p>
				<p v-if="writeScoped">
					{{ t('tcy.mcp.projectScopeHelp') }}
				</p>
				<RouterLink
					:to="{name: 'user.settings.ai', query: {tab: 'mcp'}}"
					@click="close"
				>
					{{ t('tcy.mcp.manageConnections') }}
				</RouterLink>
			</div>
		</template>
	</Popup>
</template>

<style scoped lang="scss">
.mcp-session-trigger {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	gap: var(--space-1);
	min-block-size: 44px;
	padding: var(--space-1) var(--space-2);
	border: 0;
	border-radius: var(--radius-full);
	background: transparent;
	color: var(--text-secondary);
	font: inherit;
	font-size: var(--text-sm);
	cursor: pointer;

	&:hover,
	&.has-selection {
		background: var(--surface-selected);
		color: var(--accent-text);
	}

	&:focus-visible { @include focus-ring; }
}

.mcp-session-trigger__count { font-variant-numeric: tabular-nums; }

.mcp-session-picker {
	display: grid;
	gap: var(--space-3);
	inline-size: min(21rem, calc(100vw - 2rem));
	max-inline-size: 100%;
	padding: var(--space-4);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;

	p { margin: 0; }

	@media (width <= 640px) {
		inline-size: 100%;
		padding: var(--space-2);
	}
}

.mcp-session-picker__title {
	color: var(--text-primary);
	font-weight: 600;
}

.mcp-session-picker__connections {
	display: grid;
	gap: var(--space-1);
	max-block-size: 45dvh;
	overflow-y: auto;
}

.mcp-session-picker__connection {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	min-block-size: 44px;
	padding-block: var(--space-2);
	cursor: pointer;

	input { flex-shrink: 0; }

	span {
		display: grid;
		gap: var(--space-1);
		min-inline-size: 0;
	}

	small { color: var(--text-secondary); }
}
</style>
