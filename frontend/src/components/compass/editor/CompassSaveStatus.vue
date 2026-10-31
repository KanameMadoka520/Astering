<template>
	<p
		class="compass-save-status"
		:class="`is-${state}`"
		role="status"
		aria-live="polite"
	>
		<Icon
			v-if="icon"
			:icon="icon"
			class="compass-save-status__icon"
			aria-hidden="true"
		/>
		<span
			v-else
			class="compass-save-status__dot"
			aria-hidden="true"
		/>
		<span class="compass-save-status__text">{{ text }}</span>
	</p>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'
import Icon from '@/components/misc/Icon'
import {formatDate} from '@/helpers/time/formatDate'

export type CompassSaveState =
	// A new entry nobody has written in yet.
	| 'new'
	| 'saved'
	// Changed, not yet on this device.
	| 'dirty'
	// Changed, and kept on this device.
	| 'stored'
	| 'saving'
	// The last save failed; the changes are kept on this device.
	| 'failed'
	// The browser refused to store the draft: it only lives in this tab.
	| 'unstored'

const props = withDefaults(defineProps<{
	state: CompassSaveState
	savedAt?: Date | null
}>(), {
	savedAt: null,
})

const ICONS: Partial<Record<CompassSaveState, IconProp>> = {
	saved: 'check',
	stored: 'save',
	failed: 'exclamation-circle',
	unstored: 'exclamation-circle',
}

const {t} = useI18n({useScope: 'global'})

const text = computed(() => props.state === 'saved' && props.savedAt
	? t('compass.editor.status.savedAt', {time: formatDate(props.savedAt, 'LT')})
	: t(`compass.editor.status.${props.state}`))

const icon = computed(() => ICONS[props.state])
</script>

<style lang="scss" scoped>
.compass-save-status {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: 1.35;
}

.compass-save-status__text {
	min-inline-size: 0;
	overflow-wrap: anywhere;
}

.compass-save-status__icon {
	flex: none;
	inline-size: .95em;
	block-size: .95em;
}

// A small mark beside the words; the words carry the meaning.
.compass-save-status__dot {
	flex: none;
	inline-size: .5rem;
	block-size: .5rem;
	border: 1.5px solid currentColor;
	border-radius: var(--radius-full);
}

.is-saved,
.is-stored {
	.compass-save-status__icon {
		color: var(--compass-accent);
	}
}

.is-dirty .compass-save-status__dot {
	border-color: var(--warning);
	background: var(--warning);
}

.is-saving .compass-save-status__dot {
	border-color: var(--compass-accent);
	background: var(--compass-accent);
}

.is-failed,
.is-unstored {
	color: var(--text-primary);

	.compass-save-status__icon {
		color: var(--danger);
	}
}
</style>
