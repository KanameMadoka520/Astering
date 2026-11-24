<template>
	<section
		class="version-schedule"
		:aria-label="t('projectVersions.schedule.title')"
	>
		<div>
			<h2>{{ t('projectVersions.schedule.title') }}</h2>
			<LoadError
				v-if="isError"
				:retry="() => refetch()"
			/>
			<p
				v-else-if="!schedule"
				role="status"
			>
				{{ t('misc.loading') }}
			</p>
			<template v-else>
				<p>{{ t('projectVersions.schedule.help', {zone: schedule.time_zone}) }}</p>
				<p role="status">
					{{ status }}
				</p>
			</template>
		</div>
		<XButton
			v-if="schedule && !isError && (!archived || schedule.enabled)"
			variant="secondary"
			:loading="isPending"
			:disabled="isPending || isFetching"
			data-cy="version-schedule-toggle"
			@click="toggle"
		>
			{{ t(schedule.enabled ? 'projectVersions.schedule.disable' : 'projectVersions.schedule.enable') }}
		</XButton>
	</section>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {projectVersionScheduleQuery, useProjectVersionScheduleMutation} from '@/client/queries/projectVersions'
import {captureClientRequestContext} from '@/client/requestContext'

const props = defineProps<{
	projectId: number
	archived: boolean
}>()

const {t, locale} = useI18n({useScope: 'global'})
const {data: schedule, isError, isFetching, refetch} = useQuery(computed(() => projectVersionScheduleQuery(props.projectId)))
const {mutate, isPending} = useProjectVersionScheduleMutation(captureClientRequestContext())
const status = computed(() => {
	const current = schedule.value
	if (!current?.enabled) return t('projectVersions.schedule.disabled')
	if (props.archived) return t('projectVersions.schedule.paused')
	if (!current.next_run_at) return t('projectVersions.schedule.enabled')
	const date = new Date(current.next_run_at)
	const format = {dateStyle: 'medium', timeStyle: 'short'} as const
	let next: string
	try {
		next = new Intl.DateTimeFormat(locale.value, {...format, timeZone: current.time_zone}).format(date)
	} catch {
		next = date.toLocaleString(locale.value, format)
	}
	return t('projectVersions.schedule.next', {date: next})
})

function toggle() {
	if (!schedule.value || isError.value || isFetching.value || isPending.value) return
	mutate({project: props.projectId, enabled: !schedule.value.enabled})
}
</script>

<style scoped lang="scss">
.version-schedule {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: var(--space-3);
	padding: var(--space-4);
	margin-block-end: var(--space-4);
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface);

	h2 {
		font-size: var(--text-base);
		margin-block-end: var(--space-1);
	}

	p {
		color: var(--text-secondary);
		font-size: var(--text-sm);
		margin: 0;
	}
}
</style>
