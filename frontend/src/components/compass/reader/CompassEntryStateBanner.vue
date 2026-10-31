<template>
	<div
		v-if="state !== 'active'"
		class="compass-state-banner d-print-none"
		:class="`is-${state}`"
	>
		<Icon
			class="compass-state-banner__icon"
			:icon="state === 'archived' ? 'archive' : 'trash-alt'"
			aria-hidden="true"
		/>
		<p class="compass-state-banner__text">
			{{ state === 'archived' ? t('compass.reader.archivedBanner') : t('compass.reader.trashedBanner') }}
		</p>
		<div
			v-if="canWrite"
			class="compass-state-banner__actions"
		>
			<XButton
				variant="secondary"
				:shadow="false"
				:icon="state === 'archived' ? 'book-open' : 'undo'"
				:loading="busy === 'state'"
				:aria-disabled="busy !== null"
				@click="restore"
			>
				{{ state === 'archived' ? t('compass.actions.unarchive') : t('compass.reader.restore') }}
			</XButton>
			<XButton
				v-if="state === 'trashed' && canAdmin"
				variant="tertiary"
				danger
				:shadow="false"
				icon="trash-alt"
				:aria-disabled="busy !== null"
				@click="requestDelete"
			>
				{{ t('compass.actions.deletePermanently') }}
			</XButton>
		</div>
	</div>
</template>

<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import Icon from '@/components/misc/Icon'
import type {CompassEntryState} from '@/helpers/compass/constants'
import {useCompassEntryCommands} from './useCompassEntryCommands'

defineProps<{
	state: CompassEntryState
}>()

const {t} = useI18n({useScope: 'global'})

const {
	busy,
	canWrite,
	canAdmin,
	setState,
	requestDelete,
} = useCompassEntryCommands()

function restore() {
	if (busy.value !== null) return
	setState('active')
}
</script>

<style lang="scss" scoped>
.compass-state-banner {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	padding: var(--space-3) var(--space-4);
	border: 1px solid var(--compass-rule-strong);
	border-inline-start-width: 3px;
	border-radius: var(--radius-md);
	background: var(--surface);
	color: var(--compass-ink);
	font-size: var(--text-md);

	&.is-archived {
		border-inline-start-color: var(--compass-accent);
		background: var(--compass-accent-tint);
	}

	&.is-trashed {
		border-color: hsla(var(--danger-h), var(--danger-s), var(--danger-l), .4);
		border-inline-start-color: var(--danger);
		background: var(--tint-danger);
	}
}

.compass-state-banner__icon {
	flex: none;
	color: var(--compass-ink-soft);
}

.compass-state-banner__text {
	flex: 1 1 14rem;
	min-inline-size: 0;
	margin: 0;
	line-height: var(--leading-normal);
}

.compass-state-banner__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}
</style>
