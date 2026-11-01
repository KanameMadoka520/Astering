<template>
	<span
		class="compass-visibility-chip"
		:class="{'is-team': isTeam}"
		:title="hint"
	>
		<Icon
			:icon="isTeam ? 'users' : 'lock'"
			class="compass-visibility-chip__icon"
			aria-hidden="true"
		/>
		<span>{{ label }}</span>
		<span class="is-sr-only">{{ hint }}</span>
	</span>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'

import {useTeam} from '@/composables/useTeams'

// Says who can read an entry while writing and reading it, not only on the space page (PER-08).
const props = defineProps<{
	/** The space's team; 0 for a personal space. */
	teamId: number
}>()

const {t} = useI18n({useScope: 'global'})

const isTeam = computed(() => props.teamId > 0)
const team = useTeam(() => props.teamId)
const teamName = computed(() => team.data.value?.name || t('compass.space.teamFallback'))

const label = computed(() => isTeam.value
	? t('compass.space.team', {team: teamName.value})
	: t('compass.visibility.onlyYou'))
const hint = computed(() => isTeam.value
	? t('compass.space.teamHint', {team: teamName.value})
	: t('compass.space.personalHint'))
</script>

<style lang="scss" scoped>
.compass-visibility-chip {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
	max-inline-size: 100%;
	color: var(--compass-ink-faint, var(--text-secondary));
	font-size: var(--text-sm);
	line-height: var(--leading-tight);

	> span:not(.is-sr-only) {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	&.is-team {
		color: var(--compass-ink, var(--text-primary));
		font-weight: var(--weight-medium);
	}
}

.compass-visibility-chip__icon {
	flex: none;
}
</style>
