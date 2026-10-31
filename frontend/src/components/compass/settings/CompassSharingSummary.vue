<template>
	<div class="compass-sharing-summary">
		<p class="compass-sharing-summary__line">
			<Icon
				class="compass-sharing-summary__icon"
				:icon="teamId > 0 ? 'users' : 'lock'"
			/>
			<span>{{ label }}</span>
		</p>
		<p
			v-if="teamId > 0"
			class="compass-sharing-summary__hint"
		>
			{{ t('compass.space.teamHint', {team: teamName}) }}
		</p>
		<p class="compass-sharing-summary__hint">
			{{ t('compass.sharing.permanent') }}
		</p>
	</div>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import Icon from '@/components/misc/Icon'
import {useTeam} from '@/composables/useTeams'

const props = defineProps<{
	// 0 for a personal space.
	teamId: number
}>()

const {t} = useI18n({useScope: 'global'})

const team = useTeam(() => props.teamId)
const teamName = computed(() => team.data.value?.name || t('compass.space.teamFallback'))

const label = computed(() => props.teamId > 0
	? t('compass.space.team', {team: teamName.value})
	: t('compass.sharing.summaryPersonal'))
</script>

<style lang="scss" scoped>
.compass-sharing-summary {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	min-inline-size: 0;
}

.compass-sharing-summary__line {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
	color: var(--compass-ink);
	font-weight: var(--weight-medium);
	overflow-wrap: anywhere;
}

.compass-sharing-summary__icon {
	flex: none;
	color: var(--compass-accent);
}

.compass-sharing-summary__hint {
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}
</style>
