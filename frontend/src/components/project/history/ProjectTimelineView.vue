<script setup lang="ts">
import {computed, onBeforeUnmount, ref, shallowRef, watch} from 'vue'
import {useRoute, useRouter, type LocationQueryRaw} from 'vue-router'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'

import SegmentedControl from '@/components/input/SegmentedControl.vue'
import EmptyState from '@/components/misc/state/EmptyState.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import Message from '@/components/misc/Message.vue'
import TimelineLanes from '@/components/project/history/TimelineLanes.vue'
import TimelineOccupancy from '@/components/project/history/TimelineOccupancy.vue'
import {
	projectTimelineQuery,
	type ProjectTimelineQuery,
	type ProjectTimelineResponse,
} from '@/client/queries/projectTimeline'
import {useProjects} from '@/composables/useProjects'
import {calendarDayFormatter, parseCalendarDay} from '@/helpers/projectHistoryFormat'
import {isRealProject} from '@/helpers/projectStatus'
import {
	TIMELINE_STATUSES,
	parseTimelineMonth,
	parseTimelineStatus,
	timelineDomain,
	type TimelineStatus,
} from '@/helpers/projectTimeline'

const props = defineProps<{
	year: number
	timezone: string
}>()

const emit = defineEmits<{
	years: [years: number[]]
	changeYear: [year: number]
}>()

const {t, locale} = useI18n({useScope: 'global'})
const route = useRoute()
const router = useRouter()
const projects = useProjects()

const status = computed(() => parseTimelineStatus(route.query.status))
const project = computed(() => Math.max(0, Number(route.query.project) || 0))
const q = computed(() => String(route.query.q || '').slice(0, 250))
const day = computed(() => parseCalendarDay(route.query.day, props.year))
const month = computed(() => parseTimelineMonth(route.query.month))
const page = computed(() => Math.max(1, Number(route.query.page) || 1))

function select(values: LocationQueryRaw) {
	return router.replace({
		query: {
			...route.query,
			page: undefined,
			...values,
		},
	})
}

const search = ref(String(route.query.q || ''))
watch(q, value => {
	search.value = value
})
// A pending search must not navigate after the view is gone (another tab or page is showing by then).
let searchTimer: ReturnType<typeof setTimeout> | undefined
function updateSearch() {
	clearTimeout(searchTimer)
	searchTimer = setTimeout(() => select({
		q: search.value.trim() || undefined,
		day: undefined,
	}), 300)
}
onBeforeUnmount(() => clearTimeout(searchTimer))

const timelineQuery = computed<ProjectTimelineQuery>(() => ({
	year: props.year,
	timezone: props.timezone,
	status: status.value,
	project: project.value || undefined,
	q: q.value || undefined,
	day: day.value || undefined,
	page: page.value,
}))

const query = useQuery(computed(() => projectTimelineQuery(timelineQuery.value)))

// A new year or filter has no placeholder: keep the previous result on screen, dimmed,
// rather than collapsing the page. Background refreshes after task edits swap in silently.
const lastTimeline = shallowRef<ProjectTimelineResponse>()
watch(() => query.data.value, value => {
	if (value) lastTimeline.value = value
}, {immediate: true})
const timeline = computed(() => query.data.value ?? (query.isFetching.value ? lastTimeline.value : undefined))
const refreshing = computed(() => query.isPlaceholderData.value || (!query.data.value && timeline.value !== undefined))
const failed = computed(() => query.isError.value && !query.isFetching.value)

watch(() => [timeline.value?.first_year, timeline.value?.last_year] as const, ([first, last]) => {
	if (!first || !last || last < first) return
	emit('years', Array.from({length: Math.min(last - first + 1, 60)}, (_, index) => first + index))
}, {immediate: true})

watch(() => query.data.value?.total_pages, total => {
	if (total !== undefined && page.value > Math.max(1, total)) void select({page: Math.max(1, total)})
})

const statusOptions = computed(() => TIMELINE_STATUSES.map(value => ({
	value,
	label: t(`projectTimeline.status.${value}`),
})))

const projectOptions = computed(() => projects.projectsArray
	.filter(isRealProject)
	.map(p => ({
		id: p.id,
		label: p.is_archived ? t('projectHistory.projectOptionArchived', {title: p.title}) : p.title,
	})))

const domain = computed(() => timelineDomain(props.year, month.value))

const formatDate = computed(() => calendarDayFormatter(locale.value, {
	weekday: 'short',
	year: 'numeric',
	month: 'short',
	day: 'numeric',
}))

// Rows and their total span the year (or the selected day); a month zoom only narrows the drawing.
const lanesHeading = computed(() => day.value
	? t('projectTimeline.lanes.dayHeading', {date: formatDate.value(day.value)})
	: t('projectTimeline.lanes.heading', {year: props.year}))

const filtered = computed(() => status.value !== 'all' || !!project.value || !!q.value)

const stats = computed(() => {
	const data = timeline.value
	if (!data) return []
	return [
		{
			key: 'projects',
			value: String(data.projects ?? 0),
		},
		{
			key: 'scheduledDays',
			value: t('projectTimeline.stats.daysValue', {n: data.scheduled_days ?? 0}, data.scheduled_days ?? 0),
			note: t('projectTimeline.stats.scheduledDaysNote'),
		},
		{
			key: 'elapsedDays',
			value: t('projectTimeline.stats.daysValue', {n: data.elapsed_days ?? 0}, data.elapsed_days ?? 0),
		},
		{
			key: 'tasksDone',
			value: t('projectTimeline.stats.doneValue', {
				done: data.done_tasks ?? 0,
				total: data.dated_tasks ?? 0,
			}),
		},
		{
			key: 'deadlineOnly',
			value: String(data.deadline_only_tasks ?? 0),
		},
		{
			key: 'overdue',
			value: String(data.overdue_tasks ?? 0),
			alert: (data.overdue_tasks ?? 0) > 0,
		},
	]
})

// Why tasks are missing, one reason per line, each with the date that would bring them in.
const missing = computed(() => {
	const data = timeline.value
	if (!data) return []
	const lines: {key: string, n: number}[] = []
	const undated = data.undated_tasks ?? 0
	const incomplete = data.incomplete_tasks ?? 0
	if (undated) lines.push({key: 'undated', n: undated})
	if (incomplete) lines.push({key: 'incomplete', n: incomplete})
	// An older server only sends the total.
	const rest = (data.excluded_tasks ?? 0) - undated - incomplete
	if (rest > 0) lines.push({key: 'excluded', n: rest})
	if (data.invalid_tasks) lines.push({key: 'invalid', n: data.invalid_tasks})
	return lines
})

const otherYears = computed(() => {
	const data = timeline.value
	if (!data?.first_year || !data.last_year) return []
	return [...new Set([data.first_year, data.last_year])].filter(y => y !== props.year)
})

function monthOf(date: string) {
	return Number(date.slice(5, 7)) - 1
}

function selectDay(date: string) {
	if (date === day.value) {
		void select({day: undefined})
		return
	}
	void select({
		day: date,
		month: month.value !== null && month.value !== monthOf(date) ? monthOf(date) + 1 : route.query.month,
	})
}

function selectMonth(value: number | null) {
	void select({
		month: value === null ? undefined : value + 1,
		day: value !== null && day.value && monthOf(day.value) !== value ? undefined : route.query.day,
		page: route.query.page,
	})
}

function selectStatus(value: TimelineStatus) {
	void select({
		status: value === 'all' ? undefined : value,
		day: undefined,
	})
}

function selectProject(id: number) {
	void select({
		project: id || undefined,
		day: undefined,
	})
}

function clearFilters() {
	search.value = ''
	void select({
		status: undefined,
		project: undefined,
		q: undefined,
		day: undefined,
	})
}

const announcement = computed(() => {
	if (refreshing.value || (query.isPending.value && !timeline.value)) return t('projectTimeline.loading')
	if (!timeline.value) return ''
	return `${lanesHeading.value}: ${t('projectTimeline.lanes.count', {n: timeline.value.total ?? 0}, timeline.value.total ?? 0)}`
})
</script>

<template>
	<div
		class="project-timeline"
		:aria-busy="query.isFetching.value"
	>
		<div class="timeline-filters">
			<SegmentedControl
				class="timeline-status"
				:model-value="status"
				:options="statusOptions"
				:label="t('projectTimeline.status.label')"
				@update:modelValue="selectStatus"
			/>
			<label class="timeline-filter">
				<span class="is-sr-only">{{ t('projectHistory.project') }}</span>
				<select
					class="timeline-field"
					:value="project"
					:aria-label="t('projectHistory.project')"
					@change="selectProject(Number(($event.target as HTMLSelectElement).value))"
				>
					<option :value="0">
						{{ t('projectHistory.allProjects') }}
					</option>
					<option
						v-for="option in projectOptions"
						:key="option.id"
						:value="option.id"
					>
						{{ option.label }}
					</option>
				</select>
			</label>
			<label class="timeline-filter timeline-search">
				<span class="is-sr-only">{{ t('projectHistory.search') }}</span>
				<Icon
					icon="search"
					class="timeline-search-icon"
				/>
				<input
					v-model="search"
					class="timeline-field"
					type="search"
					maxlength="250"
					:aria-label="t('projectHistory.search')"
					:placeholder="t('projectHistory.searchPlaceholder')"
					@input="updateSearch()"
				>
			</label>
		</div>

		<span
			class="is-sr-only"
			role="status"
		>{{ announcement }}</span>

		<LoadError
			v-if="failed && !timeline"
			:message="t('projectTimeline.loadError')"
			:retry="() => query.refetch()"
		/>

		<div
			v-else-if="!timeline"
			class="timeline-skeleton"
			aria-hidden="true"
		>
			<div class="skeleton-stats" />
			<div class="skeleton-grid" />
			<div
				v-for="n in 4"
				:key="n"
				class="skeleton-lane"
			/>
		</div>

		<template v-else>
			<LoadError
				v-if="failed"
				class="timeline-stale-error"
				:message="t('projectTimeline.loadError')"
				:retry="() => query.refetch()"
			/>

			<!-- Own container: the stats pick their columns from their own width, not the viewport's. -->
			<div class="timeline-stats-frame">
				<dl
					class="timeline-stats"
					:aria-label="t('projectTimeline.stats.label')"
					:class="{'is-refreshing': refreshing && !query.isPlaceholderData.value}"
				>
					<div
						v-for="stat in stats"
						:key="stat.key"
						class="timeline-stat"
						:class="{'is-alert': stat.alert}"
					>
						<dt>
							{{ t(`projectTimeline.stats.${stat.key}`) }}
							<span
								v-if="stat.note"
								class="timeline-stat-note"
							>{{ stat.note }}</span>
						</dt>
						<dd>{{ stat.value }}</dd>
					</div>
				</dl>
			</div>

			<Message
				v-if="missing.length"
				variant="info"
				class="timeline-missing"
			>
				<p
					v-for="line in missing"
					:key="line.key"
				>
					{{ t(`projectTimeline.missing.${line.key}`, {n: line.n}, line.n) }}
				</p>
				<p class="timeline-missing-scope">
					{{ t('projectTimeline.missing.scope') }}
				</p>
			</Message>

			<TimelineOccupancy
				:class="{'is-refreshing': refreshing && !query.isPlaceholderData.value}"
				:year="year"
				:days="timeline.days"
				:today="timeline.today"
				:selected-day="day"
				:month="month"
				@selectDay="selectDay"
				@selectMonth="selectMonth"
			/>

			<section
				class="timeline-projects"
				aria-labelledby="timeline-projects-heading"
			>
				<header class="timeline-projects-header">
					<h2 id="timeline-projects-heading">
						{{ lanesHeading }}
					</h2>
					<span class="timeline-projects-count">
						{{ t('projectTimeline.lanes.count', {n: timeline.total ?? 0}, timeline.total ?? 0) }}
					</span>
					<button
						v-if="day"
						type="button"
						class="timeline-chip"
						@click="select({day: undefined})"
					>
						<Icon
							icon="times"
							class="timeline-chip-icon"
						/>
						{{ t('projectTimeline.lanes.clearDay') }}
					</button>
				</header>

				<div
					class="timeline-projects-body"
					:class="{'is-refreshing': refreshing}"
				>
					<TimelineLanes
						v-if="timeline.items.length"
						:items="timeline.items"
						:domain="domain"
						:year="year"
						:today="timeline.today"
						:selected-day="day"
						:focused-project="project || undefined"
						@focusProject="selectProject"
					/>

					<EmptyState
						v-else-if="day"
						icon="calendar"
						:title="t('projectTimeline.empty.day')"
					>
						<button
							type="button"
							class="timeline-chip"
							@click="select({day: undefined})"
						>
							{{ t('projectTimeline.lanes.clearDay') }}
						</button>
					</EmptyState>

					<EmptyState
						v-else-if="filtered"
						icon="filter"
						:title="t('projectTimeline.empty.filters', {year})"
					>
						<button
							type="button"
							class="timeline-chip"
							@click="clearFilters"
						>
							{{ t('projectTimeline.empty.clearFilters') }}
						</button>
					</EmptyState>

					<EmptyState
						v-else-if="otherYears.length"
						icon="chart-gantt"
						:title="t('projectTimeline.empty.year', {year})"
						:description="timeline.first_year === timeline.last_year
							? t('projectTimeline.empty.otherYear', {year: timeline.first_year})
							: t('projectTimeline.empty.otherYears', {first: timeline.first_year, last: timeline.last_year})"
					>
						<button
							v-for="y in otherYears"
							:key="y"
							type="button"
							class="timeline-chip"
							@click="emit('changeYear', y)"
						>
							{{ t('projectTimeline.empty.goTo', {year: y}) }}
						</button>
					</EmptyState>

					<EmptyState
						v-else
						icon="chart-gantt"
						:title="t('projectTimeline.empty.none')"
						:description="t('projectTimeline.empty.noneHelp')"
					/>
				</div>

				<nav
					v-if="(timeline.total_pages ?? 1) > 1"
					class="timeline-pagination"
					:aria-label="t('projectTimeline.pagination')"
				>
					<button
						type="button"
						class="timeline-chip"
						:disabled="page <= 1"
						@click="select({page: page - 1 > 1 ? page - 1 : undefined})"
					>
						<Icon
							icon="angle-left"
							class="timeline-page-icon"
						/>
						{{ t('projectHistory.previous') }}
					</button>
					<span class="timeline-page">{{ t('projectTimeline.pageOf', {page, total: timeline.total_pages}) }}</span>
					<button
						type="button"
						class="timeline-chip"
						:disabled="page >= (timeline.total_pages ?? 1)"
						@click="select({page: page + 1})"
					>
						{{ t('projectHistory.next') }}
						<Icon
							icon="angle-right"
							class="timeline-page-icon"
						/>
					</button>
				</nav>
			</section>

			<details class="timeline-explanation">
				<summary>{{ t('projectTimeline.explanation') }}</summary>
				<p>{{ t('projectTimeline.explanationSpans') }}</p>
				<p>{{ t('projectTimeline.explanationDeadlines') }}</p>
				<p>{{ t('projectTimeline.explanationElapsed') }}</p>
				<p>{{ t('projectTimeline.explanationProgress') }}</p>
				<p>{{ t('projectTimeline.legend.note') }}</p>
			</details>
		</template>
	</div>
</template>

<style scoped lang="scss">
.project-timeline {
	display: grid;
	gap: var(--space-4);
	min-inline-size: 0;
}

.timeline-filters {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
}

.timeline-status {
	flex: none;
	max-inline-size: 100%;
}

.timeline-filter {
	position: relative;
	display: flex;
	flex: 1 1 12rem;
	min-inline-size: 0;
}

.timeline-search {
	flex-basis: 14rem;
}

.timeline-field {
	inline-size: 100%;
	min-inline-size: 0;
	min-block-size: var(--control-height);
	padding: .3rem .7rem;
	border: 1px solid var(--input-border-color);
	border-radius: $radius;
	background: var(--surface);
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-md);

	&:hover {
		border-color: var(--input-hover-border-color);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
	}
}

.timeline-search .timeline-field {
	padding-inline-start: 2rem;
}

.timeline-search-icon {
	position: absolute;
	inset-block: 0;
	inset-inline-start: .7rem;
	margin-block: auto;
	color: var(--text-tertiary);
	font-size: var(--text-sm);
	pointer-events: none;
}

.timeline-stats-frame {
	container: timeline-stats / inline-size;
}

// Two, three or six columns: six stats always fill whole rows, so no divider-coloured cell is left empty.
.timeline-stats {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 1px;
	margin: 0;
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--border-subtle);
}

@container timeline-stats (min-width: 32rem) {
	.timeline-stats {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
}

@container timeline-stats (min-width: 60rem) {
	.timeline-stats {
		grid-template-columns: repeat(6, minmax(0, 1fr));
	}
}

.timeline-stat {
	display: flex;
	flex-direction: column-reverse;
	gap: var(--space-1);
	padding: var(--space-3) var(--space-4);
	background: var(--surface);

	dt {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}

	dd {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-xl);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
		line-height: var(--leading-tight, 1.2);
	}

	&.is-alert dd {
		color: var(--danger-text);
	}
}

.timeline-stat-note {
	display: block;
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
}

.timeline-missing {
	:deep(.message) {
		display: grid;
		gap: var(--space-1);
	}

	p {
		margin: 0;
	}
}

.timeline-missing-scope {
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.timeline-projects {
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);
}

.timeline-projects-header {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--space-1) var(--space-3);
	margin-block-end: var(--space-2);

	h2 {
		margin: 0;
		font-size: var(--text-lg);
	}
}

.timeline-projects-count {
	color: var(--text-tertiary);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.timeline-chip {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: var(--control-height-sm);
	padding-inline: var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	background: var(--surface);
	color: var(--text-secondary);
	font: inherit;
	font-size: var(--text-sm);
	cursor: pointer;
	transition: background-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard);

	&:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 2px;
	}

	&:disabled {
		cursor: default;
		opacity: .45;
	}
}

.timeline-projects-header .timeline-chip {
	margin-inline-start: auto;
}

.timeline-chip-icon {
	font-size: var(--text-xs);
}

.timeline-page-icon:dir(rtl) {
	transform: scaleX(-1);
}

// Only content that is about to be replaced dims; a background refresh keeps full contrast.
.is-refreshing {
	opacity: .6;
	transition: opacity var(--motion-base) var(--ease-standard);
}

.timeline-pagination {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: center;
	gap: var(--space-3);
	margin-block-start: var(--space-3);
}

.timeline-page {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.timeline-explanation {
	color: var(--text-secondary);
	font-size: var(--text-sm);

	summary {
		inline-size: fit-content;
		border-radius: var(--radius-xs);
		color: var(--text-primary);
		font-weight: var(--weight-medium);
		cursor: pointer;

		&:focus-visible {
			outline: 2px solid var(--focus-ring-color);
			outline-offset: 2px;
		}
	}

	p {
		max-inline-size: 75ch;
		margin-block-start: var(--space-2);
	}
}

.timeline-skeleton {
	display: grid;
	gap: var(--space-3);

	> div {
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
	}
}

.skeleton-stats {
	block-size: 4.5rem;
}

.skeleton-grid {
	block-size: 12rem;
}

.skeleton-lane {
	block-size: 3.5rem;
}
</style>
