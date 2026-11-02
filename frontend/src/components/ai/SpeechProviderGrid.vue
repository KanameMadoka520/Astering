<script setup lang="ts">
import {useId} from 'vue'
import {useI18n} from 'vue-i18n'
import type {SpeechProviderPreset} from '@/helpers/speechProviders'

export interface SpeechProviderGroup {
	provider: SpeechProviderPreset
	count: number
	enabled: boolean
	dirty: boolean
	defaultModel?: string
}

defineProps<{groups: SpeechProviderGroup[]}>()
const emit = defineEmits<{open: [provider: SpeechProviderPreset]}>()
const {t} = useI18n({useScope: 'global'})
const statusId = useId()

function providerName(group: SpeechProviderGroup) {
	return group.provider.labelKey ? t(group.provider.labelKey) : group.provider.name
}
function statusLabel(group: SpeechProviderGroup) {
	if (group.enabled) return t('speechSettings.enabled')
	return t(group.count ? 'speechSettings.disabled' : 'speechSettings.notConfigured')
}
function modelLabel(group: SpeechProviderGroup) {
	if (group.dirty) return t('settingsDraft.unsaved')
	if (group.defaultModel) return group.defaultModel
	return group.count
		? t('speechSettings.connections', {count: group.count})
		: t('speechSettings.clickToConfigure')
}
</script>

<template>
	<div class="speech-provider-grid">
		<button
			v-for="group in groups"
			:key="group.provider.id"
			type="button"
			class="speech-provider-card"
			:class="[`is-${group.provider.tone}`, {'is-configured': group.count > 0}]"
			:aria-label="t('speechSettings.configureProvider', {provider: providerName(group)})"
			:aria-describedby="`${statusId}-${group.provider.id}`"
			@click="emit('open', group.provider)"
		>
			<span class="speech-provider-card__heading">
				<span
					class="speech-provider-mark"
					aria-hidden="true"
				>{{ group.provider.mark }}</span>
				<span class="speech-provider-card__name">{{ providerName(group) }}</span>
				<span
					v-if="group.provider.local"
					class="speech-provider-card__tag"
				>{{ t('speechSettings.local') }}</span>
				<span
					class="speech-provider-card__indicator"
					:class="{'is-enabled': group.enabled}"
					:title="statusLabel(group)"
					aria-hidden="true"
				/>
				<span
					:id="`${statusId}-${group.provider.id}`"
					class="is-sr-only"
				>{{ statusLabel(group) }}</span>
			</span>
			<span class="speech-provider-card__footer">
				<span>
					{{ modelLabel(group) }}
				</span>
				<Icon
					icon="chevron-right"
					aria-hidden="true"
				/>
			</span>
		</button>
	</div>
</template>

<style lang="scss" scoped>
.speech-provider-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-4);

	@media (width <= 640px) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.speech-provider-card {
	display: flex;
	flex-direction: column;
	gap: var(--space-5);
	min-inline-size: 0;
	padding: var(--space-5);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);
	color: var(--text-primary);
	font: inherit;
	text-align: start;
	cursor: pointer;
	transition: border-color 150ms ease, background-color 150ms ease;

	&:hover {
		border-color: var(--primary);
		background: var(--surface-raised);
	}

	&:focus-visible {
		@include focus-ring;
	}

	@media (prefers-reduced-motion: reduce) {
		transition: none;
	}
}

.speech-provider-card__heading {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	min-inline-size: 0;
}

.speech-provider-mark {
	display: grid;
	flex: 0 0 2.5rem;
	place-items: center;
	block-size: 2.5rem;
	border-radius: var(--radius-md);
	background: var(--surface-active);
	color: var(--primary);
	font-size: var(--text-lg);
	font-weight: var(--weight-bold);
}

.is-ink .speech-provider-mark,
.is-navy .speech-provider-mark {
	background: var(--text-primary);
	color: var(--surface);
}

.is-violet .speech-provider-mark {
	background: color-mix(in srgb, #7862f6 10%, var(--surface));
	color: #7862f6;
}

.is-orange .speech-provider-mark {
	background: color-mix(in srgb, #d65d16 10%, var(--surface));
	color: #d65d16;
}

.speech-provider-card__name {
	min-inline-size: 0;
	font-weight: var(--weight-semibold);
	overflow-wrap: anywhere;
}

.speech-provider-card__tag {
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.speech-provider-card__indicator {
	flex: 0 0 .625rem;
	block-size: .625rem;
	margin-inline-start: auto;
	border-radius: 50%;
	background: var(--border-strong);

	&.is-enabled {
		background: var(--success);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 16%, transparent);
	}
}

.speech-provider-card__footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--border-subtle);
	color: var(--text-secondary);
	font-size: var(--text-sm);

	span {
		min-inline-size: 0;
		overflow-wrap: anywhere;
	}

	svg {
		flex-shrink: 0;
	}
}
</style>
