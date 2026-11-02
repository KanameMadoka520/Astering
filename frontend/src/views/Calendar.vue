<script setup lang="ts">
import {computed, ref, shallowRef, watch} from 'vue'
import {useMediaQuery} from '@vueuse/core'
import {useRoute, useRouter, type LocationQuery, type LocationQueryRaw} from 'vue-router'
import {useI18n} from 'vue-i18n'

import CalendarAgenda from '@/components/calendar/CalendarAgenda.vue'
import CalendarCreateDialog from '@/components/calendar/CalendarCreateDialog.vue'
import CalendarMonthView from '@/components/calendar/CalendarMonthView.vue'
import CalendarTimeGrid from '@/components/calendar/CalendarTimeGrid.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {useCalendarTasksQuery, type CalendarTaskOptions} from '@/client/queries/calendar'
import {isRequestContextAbort} from '@/client/requestContext'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {useProjects} from '@/composables/useProjects'
import {useTitle} from '@/composables/useTitle'
import {
	addCalendarDays,
	addCalendarMonths,
	calendarDateAt,
	calendarDateLabel,
	calendarHourHeight,
	calendarRange,
	calendarSegments,
	clampCalendarDate,
	type CalendarView,
	type CalendarWeekDays,
} from '@/helpers/calendar'
import {resolveUserTimezone} from '@/helpers/time/userTimezone'
import {useAuthStore} from '@/stores/auth'

defineOptions({name: 'CalendarPage'})

const {t, locale} = useI18n({useScope: 'global'})
useTitle(() => t('calendar.title'))
const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const projects = useProjects()
const {now} = useGlobalNow()
const narrow = useMediaQuery('(max-width: 640px)')
const defaultView: CalendarView = narrow.value ? 'agenda' : 'week'
function initialSavedQuery(): LocationQuery {
	if (route.path === '/calendar') return {...route.query}
	const backdrop = window.history.state?.backdropView
	if (typeof backdrop !== 'string' || !backdrop.startsWith('/') || backdrop.startsWith('//')) return {}
	try {
		const resolved = router.resolve(backdrop)
		return resolved.path === '/calendar' ? {...resolved.query} : {}
	} catch {
		return {}
	}
}
const savedQuery = shallowRef<LocationQuery>(initialSavedQuery())
// The task modal changes useRoute() while this calendar remains its backdrop.
watch(() => route.fullPath, () => {
	if (route.path === '/calendar') savedQuery.value = {...route.query}
})
const timezone = computed(() => resolveUserTimezone(auth.settings.timezone))
const today = computed(() => calendarDateAt(now.value, timezone.value))
const queryValue = (name: string) => typeof savedQuery.value[name] === 'string' ? savedQuery.value[name] as string : ''
const date = computed(() => {
	return clampCalendarDate(queryValue('date')) || clampCalendarDate(today.value)!
})
const view = computed<CalendarView>(() => {
	const requested = queryValue('view')
	return requested === 'month' || requested === 'week' || requested === 'day' || requested === 'agenda'
		? requested
		: defaultView
})
const dayCount = computed<CalendarWeekDays>(() => {
	const value = Number(queryValue('days'))
	return value === 3 || value === 14 ? value : 7
})
const range = computed(() => calendarRange(view.value, date.value, auth.settings.week_start ?? 0, dayCount.value))
const projectId = computed(() => /^[1-9]\d*$/.test(queryValue('project')) ? Number(queryValue('project')) : undefined)
const hideDone = computed(() => queryValue('done') !== 'all')
const important = computed(() => queryValue('important') === '1')
const zoom = computed(() => {
	const raw = queryValue('zoom')
	const value = raw ? Number(raw) : 100
	return Number.isFinite(value) ? Math.min(250, Math.max(25, value)) : 100
})
const dense = computed(() => queryValue('density') === 'compact')
const query = useCalendarTasksQuery(computed<CalendarTaskOptions>(() => ({
	from: range.value.from,
	to: range.value.to,
	timezone: timezone.value,
	projectId: projectId.value,
	done: hideDone.value ? 'open' : 'all',
})))
const items = computed(() => (query.data.value?.items ?? []).filter(item => !important.value || (item.priority ?? 0) >= 3))
const days = computed(() => query.data.value?.days ?? [])
const segments = computed(() => calendarSegments(items.value, days.value))
const count = computed(() => new Set([...segments.value.values()].flatMap(events => events.map(event => event.taskId))).size)
const failed = computed(() => query.isError.value && !isRequestContextAbort(query.error.value))
const projectChoices = computed(() => projects.projectsArray.filter(project => project.id > 0 && !project.is_archived))
const createOpen = ref(false)
const periodLabel = computed(() => {
	if (view.value === 'month') return calendarDateLabel(date.value, locale.value, {year: 'numeric', month: 'long'})
	if (view.value === 'day') return calendarDateLabel(date.value, locale.value, {year: 'numeric', month: 'long', day: 'numeric'})
	const last = range.value.dates[range.value.dates.length - 1]
	return `${calendarDateLabel(range.value.from, locale.value, {month: 'short', day: 'numeric'})} – ${calendarDateLabel(
		last,
		locale.value,
		{year: 'numeric', month: 'short', day: 'numeric'},
	)}`
})

function updateQuery(patch: LocationQueryRaw) {
	if (route.path !== '/calendar') return
	void router.replace({
		path: '/calendar',
		query: {
			...savedQuery.value,
			view: view.value,
			date: date.value,
			...patch,
		},
	})
}

function selectDate(value: string) {
	const next = clampCalendarDate(value)
	if (next) updateQuery({date: next})
}

function navigate(direction: number) {
	const next = view.value === 'month'
		? addCalendarMonths(date.value, direction)
		: addCalendarDays(range.value.from, direction * range.value.dates.length)
	selectDate(next)
}

function created(taskId: number) {
	createOpen.value = false
	if (route.path !== '/calendar') return
	void router.push({
		name: 'task.detail',
		params: {id: taskId},
		state: {backdropView: route.fullPath},
	})
}
</script>

<template>
	<section class="calendar-page">
		<header class="calendar-heading">
			<div>
				<h1>{{ t('calendar.title') }}</h1>
				<p class="calendar-subtitle">
					{{ t('calendar.subtitle') }}
				</p>
			</div>
			<div class="calendar-heading-actions">
				<RouterLink
					class="calendar-control"
					:to="{name: 'tasks.range'}"
				>
					{{ t('calendar.tasksLink') }}
				</RouterLink>
				<button
					type="button"
					class="calendar-control is-primary"
					@click="createOpen = true"
				>
					{{ t('calendar.create.label') }}
				</button>
			</div>
		</header>

		<div class="calendar-toolbar">
			<div class="calendar-date-navigation">
				<button
					type="button"
					class="calendar-control calendar-icon-button"
					:aria-label="t('calendar.previous')"
					@click="navigate(-1)"
				>
					<Icon icon="angle-left" />
				</button>
				<button
					type="button"
					class="calendar-control"
					@click="selectDate(today)"
				>
					{{ t('calendar.today') }}
				</button>
				<button
					type="button"
					class="calendar-control calendar-icon-button"
					:aria-label="t('calendar.next')"
					@click="navigate(1)"
				>
					<Icon icon="angle-right" />
				</button>
				<input
					type="date"
					class="calendar-control calendar-date-input"
					:value="date"
					min="1971-01-01"
					max="9997-12-31"
					:aria-label="t('calendar.chooseDate')"
					@change="selectDate(($event.target as HTMLInputElement).value)"
				>
			</div>
			<label class="calendar-mode-picker">
				<span class="is-sr-only">{{ t('calendar.viewLabel') }}</span>
				<select
					class="calendar-control"
					:value="view"
					:aria-label="t('calendar.viewLabel')"
					@change="updateQuery({view: ($event.target as HTMLSelectElement).value})"
				>
					<option
						v-for="mode in ['month', 'week', 'day', 'agenda']"
						:key="mode"
						:value="mode"
					>{{ t(`calendar.views.${mode}`) }}</option>
				</select>
			</label>
		</div>

		<div class="calendar-period-heading">
			<h2>{{ periodLabel }}</h2>
			<span class="calendar-timezone">{{ timezone }}</span>
		</div>

		<div class="calendar-filters">
			<select
				class="calendar-control calendar-project-filter"
				:value="projectId ?? ''"
				:aria-label="t('calendar.projectFilter')"
				@change="updateQuery({project: ($event.target as HTMLSelectElement).value || undefined})"
			>
				<option value="">
					{{ t('calendar.allProjects') }}
				</option>
				<option
					v-for="project in projectChoices"
					:key="project.id"
					:value="project.id"
				>
					{{ project.title }}
				</option>
			</select>
			<label class="calendar-check">
				<input
					type="checkbox"
					:checked="hideDone"
					@change="updateQuery({done: ($event.target as HTMLInputElement).checked ? undefined : 'all'})"
				>
				{{ t('calendar.hideCompleted') }}
			</label>
			<label class="calendar-check">
				<input
					type="checkbox"
					:checked="important"
					@change="updateQuery({important: ($event.target as HTMLInputElement).checked ? '1' : undefined})"
				>
				{{ t('calendar.importantOnly') }}
			</label>
			<details class="calendar-display-options">
				<summary>{{ t('calendar.displayOptions') }}</summary>
				<div class="calendar-display-fields">
					<label v-if="view === 'week'">
						<span>{{ t('calendar.visibleDays') }}</span>
						<select
							class="calendar-control"
							:value="dayCount"
							:aria-label="t('calendar.visibleDays')"
							@change="updateQuery({days: ($event.target as HTMLSelectElement).value})"
						>
							<option
								v-for="amount in [3, 7, 14]"
								:key="amount"
								:value="amount"
							>{{ t('calendar.dayCount', {count: amount}) }}</option>
						</select>
					</label>
					<label v-if="view === 'week' || view === 'day'">
						<span>{{ t('calendar.zoom') }} · {{ zoom }}%</span>
						<input
							type="range"
							min="25"
							max="250"
							step="5"
							:value="zoom"
							:aria-label="t('calendar.zoom')"
							@input="updateQuery({zoom: ($event.target as HTMLInputElement).value})"
						>
					</label>
					<label
						v-if="view === 'month'"
						class="calendar-check"
					>
						<input
							type="checkbox"
							:checked="dense"
							@change="updateQuery({density: ($event.target as HTMLInputElement).checked ? 'compact' : undefined})"
						>
						{{ t('calendar.compactMonth') }}
					</label>
					<p>{{ t('calendar.displayHint') }}</p>
				</div>
			</details>
		</div>

		<div
			class="calendar-load-status"
			role="status"
			aria-live="polite"
		>
			{{ query.isFetching.value ? t(query.data.value ? 'calendar.refreshing' : 'calendar.loading') : t('calendar.itemCount', {count}) }}
		</div>
		<LoadError
			v-if="failed"
			:message="t('calendar.loadFailed')"
			:retry="() => query.refetch()"
		/>
		<div
			v-if="query.data.value"
			class="calendar-content"
			:class="{'is-month': view === 'month'}"
		>
			<template v-if="view === 'month'">
				<CalendarMonthView
					:dates="range.dates"
					:anchor="date"
					:selected-date="date"
					:today="today"
					:segments="segments"
					:timezone="timezone"
					:dense="dense"
					@select="selectDate"
				/>
				<CalendarAgenda
					:dates="[date]"
					:segments="segments"
					:timezone="timezone"
					:today="today"
					show-empty
				/>
			</template>
			<template v-else-if="view === 'week' || view === 'day'">
				<CalendarTimeGrid
					:days="days"
					:segments="segments"
					:timezone="timezone"
					:today="today"
					:selected-date="date"
					:hour-height="calendarHourHeight(zoom)"
					:now="now"
					@select="selectDate"
				/>
				<div class="calendar-selected-agenda">
					<CalendarAgenda
						:dates="[date]"
						:segments="segments"
						:timezone="timezone"
						:today="today"
						show-empty
					/>
				</div>
			</template>
			<template v-else>
				<CalendarAgenda
					:dates="range.dates"
					:segments="segments"
					:timezone="timezone"
					:today="today"
				/>
				<p
					v-if="count === 0"
					class="calendar-empty"
				>
					{{ t('calendar.emptyRange') }}
				</p>
			</template>
		</div>
		<p class="calendar-footnote">
			{{ t('calendar.dateSemantics') }}
		</p>
		<CalendarCreateDialog
			v-if="createOpen"
			:date="date"
			:timezone="timezone"
			:project-id="projectId"
			@close="createOpen = false"
			@created="created"
		/>
	</section>
</template>

<style scoped lang="scss">
.calendar-page {
	display: grid;
	gap: var(--space-4);
	min-inline-size: 0;
	max-inline-size: 100%;
	color: var(--text-primary);
}

.calendar-heading,
.calendar-heading-actions,
.calendar-toolbar,
.calendar-date-navigation,
.calendar-period-heading,
.calendar-filters {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
}

.calendar-heading,
.calendar-toolbar {
	justify-content: space-between;
}

.calendar-heading h1 {
	margin: 0;
	font-size: var(--text-2xl);
	font-weight: var(--weight-bold);
}

.calendar-subtitle {
	margin-block: var(--space-1) 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.calendar-control {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-inline-size: 0;
	max-inline-size: 100%;
	min-block-size: 2.75rem;
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	background: var(--surface);
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-sm);
	text-decoration: none;
	cursor: pointer;

	&:hover {
		background: var(--surface-hover);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 2px;
	}

	&.is-primary {
		border-color: var(--primary);
		background: var(--primary);
		color: var(--text-on-accent);
	}
}

.calendar-icon-button {
	inline-size: 2.75rem;
	padding: 0;
}

.calendar-date-input {
	inline-size: 10rem;
}

.calendar-period-heading h2 {
	margin: 0;
	font-size: var(--text-xl);
	font-weight: var(--weight-semibold);
}

.calendar-timezone {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.calendar-project-filter {
	max-inline-size: 15rem;
	text-overflow: ellipsis;
}

.calendar-check {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: 2.75rem;
	font-size: var(--text-sm);
	cursor: pointer;

	input {
		margin: 0;
		accent-color: var(--primary);
	}
}

.calendar-display-options {
	min-inline-size: 0;

	summary {
		display: list-item;
		min-block-size: 2.75rem;
		padding: var(--space-3) var(--space-2);
		color: var(--text-secondary);
		font-size: var(--text-sm);
		cursor: pointer;
	}
}

.calendar-display-fields {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-3);
	max-inline-size: 100%;
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);

	> label {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
	}

	p {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}

	input[type='range'] {
		inline-size: 10rem;
		max-inline-size: 100%;
		min-block-size: 2.75rem;
	}
}

.calendar-load-status,
.calendar-footnote {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.calendar-load-status {
	min-block-size: 1rem;
}

.calendar-content {
	display: grid;
	gap: var(--space-4);
	min-inline-size: 0;

	&.is-month {
		align-items: start;

		@media (width >= 1400px) {
			grid-template-columns: minmax(0, 1fr) 18rem;
		}
	}
}

.calendar-selected-agenda {
	display: none;
}

.calendar-empty {
	margin: 0;
	padding: var(--space-8) var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);
	color: var(--text-secondary);
	text-align: center;
}

@media (width <= 640px) {
	.calendar-page {
		gap: var(--space-3);
	}

	.calendar-heading {
		align-items: flex-start;
	}

	.calendar-heading h1 {
		font-size: var(--text-xl);
	}

	.calendar-subtitle {
		max-inline-size: 26rem;
	}

	.calendar-date-navigation {
		flex: 1 1 100%;
	}

	.calendar-date-input {
		flex: 1;
		inline-size: 8rem;
	}

	.calendar-mode-picker {
		flex: 1;

		select {
			inline-size: 100%;
		}
	}

	.calendar-project-filter {
		flex: 1 1 100%;
		max-inline-size: 100%;
	}

	.calendar-display-options {
		flex: 1 1 100%;
	}

	.calendar-period-heading h2 {
		font-size: var(--text-base);
	}

	.calendar-selected-agenda {
		display: block;
	}
}
</style>
