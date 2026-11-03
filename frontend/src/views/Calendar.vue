<script setup lang="ts">
import {computed, nextTick, ref, shallowRef, watch} from 'vue'
import {useResizeObserver} from '@vueuse/core'
import {useRoute, useRouter, type LocationQuery, type LocationQueryRaw} from 'vue-router'
import {useI18n} from 'vue-i18n'

import CalendarAgenda from '@/components/calendar/CalendarAgenda.vue'
import CalendarCreateDialog from '@/components/calendar/CalendarCreateDialog.vue'
import CalendarMonthView from '@/components/calendar/CalendarMonthView.vue'
import CalendarTimeGrid from '@/components/calendar/CalendarTimeGrid.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import Popup from '@/components/misc/Popup.vue'
import {useIsMobile} from '@/composables/useIsMobile'
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
const narrow = useIsMobile()
const filtersExpanded = ref(false)
const displayOpen = ref(false)
const displayTrigger = ref<HTMLElement>()
const commandBar = ref<HTMLElement>()
const commandHeight = ref(0)
useResizeObserver(commandBar, ([entry]) => {
	if (!entry) return
	commandHeight.value = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
})
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
const selectedDate = computed(() => {
	const selected = clampCalendarDate(queryValue('selected'))
	return selected && range.value.dates.includes(selected) ? selected : date.value
})
const pickerDates = computed(() => calendarRange('month', selectedDate.value, auth.settings.week_start ?? 0).dates)
const showLunar = computed(() => queryValue('lunar') ? queryValue('lunar') === '1' : locale.value.startsWith('zh'))
const monthCollapsed = computed(() => queryValue('fold') === 'week')
const pickerExpanded = ref(false)
const projectId = computed(() => /^[1-9]\d*$/.test(queryValue('project')) ? Number(queryValue('project')) : undefined)
const hideDone = computed(() => queryValue('done') !== 'all')
const important = computed(() => queryValue('important') === '1')
const extraFilterCount = computed(() => Number(projectId.value !== undefined)
	+ Number(!hideDone.value)
	+ Number(important.value))
watch([view, narrow], () => {
	displayOpen.value = false
})
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
const createSequence = ref(0)
type CreateSelection = {
	date: string
	start?: string
	end?: string
	allDay?: boolean
}
const initialCreateSelection = () => ({date: date.value})
const createSelection = shallowRef<CreateSelection>(initialCreateSelection())
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
	return router.replace({
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
	if (!next) return
	const sameMonth = view.value !== 'month' || next.slice(0, 7) === date.value.slice(0, 7)
	if (view.value !== 'day' && sameMonth && range.value.dates.includes(next)) return updateQuery({selected: next})
	return updateQuery({date: next, selected: undefined})
}

function jumpToDate(value: string) {
	const next = clampCalendarDate(value)
	if (next) updateQuery({date: next, selected: undefined})
}

async function revealDay(value: string) {
	await selectDate(value)
	await nextTick()
	if (view.value === 'agenda') {
		document.querySelector<HTMLElement>(`[data-agenda-date="${value}"]`)?.scrollIntoView({block: 'nearest'})
	} else {
		document.getElementById('calendar-selected-day')?.scrollIntoView({block: 'nearest'})
	}
}

function openCreate(selection: string | CreateSelection = selectedDate.value) {
	createSelection.value = typeof selection === 'string' ? {date: selection} : {...selection}
	createSequence.value++
	createOpen.value = true
}

function navigate(direction: number) {
	const next = view.value === 'month'
		? addCalendarMonths(date.value, direction)
		: addCalendarDays(range.value.from, direction * range.value.dates.length)
	jumpToDate(next)
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
	<section
		class="calendar-page"
		:style="{'--calendar-command-height': `${commandHeight}px`}"
	>
		<header
			ref="commandBar"
			class="calendar-command-bar"
			:class="{'has-expanded-filters': filtersExpanded}"
		>
			<div class="is-sr-only">
				<h1>{{ t('calendar.title') }}</h1>
				<p>{{ t('calendar.subtitle') }}</p>
			</div>
			<div class="calendar-primary-controls">
				<div class="calendar-period-heading">
					<h2>{{ periodLabel }}</h2>
					<span class="calendar-timezone">{{ timezone }}</span>
				</div>
				<div class="calendar-view-controls">
					<div
						class="calendar-presentation"
						role="group"
						:aria-label="t('calendar.presentation')"
					>
						<button
							v-for="mode in ['agenda', 'week', 'month'] as const"
							:key="mode"
							type="button"
							:aria-pressed="mode === 'week' ? view === 'week' || view === 'day' : view === mode"
							@click="updateQuery({view: mode, date: selectedDate, selected: undefined})"
						>
							{{ t(`calendar.presentations.${mode}`) }}
						</button>
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
				<div
					v-show="!narrow || filtersExpanded"
					id="calendar-secondary-actions"
					class="calendar-heading-actions"
				>
					<RouterLink
						class="calendar-control"
						:to="{name: 'tasks.range'}"
					>
						{{ t('calendar.tasksLink') }}
					</RouterLink>
					<button
						type="button"
						class="calendar-control is-primary"
						@click="openCreate()"
					>
						{{ t('calendar.create.label') }}
					</button>
				</div>
			</div>
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
					class="calendar-control calendar-today-control"
					@click="jumpToDate(today)"
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
					:value="selectedDate"
					min="1971-01-01"
					max="9997-12-31"
					:aria-label="t('calendar.chooseDate')"
					@change="jumpToDate(($event.target as HTMLInputElement).value)"
				>
			</div>
			<button
				type="button"
				class="calendar-control calendar-filter-toggle"
				:title="t('calendar.filterOptions')"
				:aria-expanded="filtersExpanded"
				aria-controls="calendar-filter-fields calendar-secondary-actions"
				@click="filtersExpanded = !filtersExpanded"
			>
				<Icon icon="filter" />
				<span :class="{'is-sr-only': narrow}">{{ t('calendar.filterOptions') }}</span>
				<span
					v-if="extraFilterCount"
					class="calendar-filter-count"
				>{{ extraFilterCount }}</span>
			</button>
			<div
				v-show="!narrow || filtersExpanded"
				id="calendar-filter-fields"
				class="calendar-filters"
			>
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
				<Popup
					v-model:open="displayOpen"
					:anchor="displayTrigger"
					placement="bottom-end"
					surface
					sheet-on-mobile
					:sheet-title="t('calendar.displayOptions')"
				>
					<template #trigger="{toggle, isOpen}">
						<button
							ref="displayTrigger"
							type="button"
							class="calendar-control calendar-display-trigger"
							:aria-expanded="isOpen"
							aria-controls="calendar-display-fields"
							@click="toggle()"
						>
							<Icon icon="sliders" />
							{{ t('calendar.displayOptions') }}
						</button>
					</template>
					<template #content>
						<div
							id="calendar-display-fields"
							class="calendar-display-fields"
						>
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
							<label class="calendar-check">
								<input
									type="checkbox"
									:checked="showLunar"
									@change="updateQuery({lunar: ($event.target as HTMLInputElement).checked ? '1' : '0'})"
								>
								{{ t('calendar.showLunar') }}
							</label>
							<p>{{ t('calendar.displayHint') }}</p>
						</div>
					</template>
				</Popup>
			</div>
			<div
				class="calendar-load-status"
				:class="{'is-sr-only': narrow && !filtersExpanded}"
				role="status"
				aria-live="polite"
			>
				{{ query.isPaused.value ? t('network.waitingForConnection') : query.isFetching.value || query.isPending.value ? t(query.data.value ? 'calendar.refreshing' : 'calendar.loading') : failed ? t('calendar.loadFailed') : t('calendar.itemCount', {count}) }}
			</div>
		</header>

		<LoadError
			v-if="failed"
			:message="t('calendar.loadFailed')"
			:retry="() => query.refetch()"
		/>
		<p
			v-if="query.isPaused.value"
			class="calendar-connection-status"
			role="status"
		>
			{{ t('network.waitingForConnection') }}
		</p>
		<div
			v-if="query.data.value || query.isPending.value"
			class="calendar-content"
			:class="{'is-month': view === 'month'}"
		>
			<template v-if="view === 'month'">
				<div class="calendar-month-panel">
					<div class="calendar-date-panel-header">
						<span>{{ t('calendar.chooseDayHint') }}</span>
						<button
							type="button"
							class="calendar-control"
							:aria-expanded="!monthCollapsed"
							@click="updateQuery({fold: monthCollapsed ? undefined : 'week'})"
						>
							{{ t(monthCollapsed ? 'calendar.expandMonth' : 'calendar.collapseMonth') }}
						</button>
					</div>
					<CalendarMonthView
						:dates="range.dates"
						:anchor="date"
						:selected-date="selectedDate"
						:today="today"
						:segments="segments"
						:timezone="timezone"
						:dense="dense"
						:show-lunar="showLunar"
						:collapsed="monthCollapsed"
						@select="selectDate"
						@create="openCreate"
					/>
				</div>
				<div id="calendar-selected-day">
					<CalendarAgenda
						:dates="[selectedDate]"
						:segments="segments"
						:timezone="timezone"
						:today="today"
						show-empty
						:loading="query.isPending.value"
						allow-create
						@create="openCreate"
					/>
				</div>
			</template>
			<template v-else-if="view === 'week' || view === 'day'">
				<CalendarTimeGrid
					:days="days"
					:segments="segments"
					:timezone="timezone"
					:today="today"
					:selected-date="selectedDate"
					:show-lunar="showLunar"
					:hour-height="calendarHourHeight(zoom)"
					:now="now"
					@select="selectDate"
					@showDay="revealDay"
					@create="openCreate"
				/>
				<div
					id="calendar-selected-day"
					class="calendar-selected-agenda"
				>
					<CalendarAgenda
						:dates="[selectedDate]"
						:segments="segments"
						:timezone="timezone"
						:today="today"
						show-empty
						:loading="query.isPending.value"
						allow-create
						@create="openCreate"
					/>
				</div>
			</template>
			<template v-else>
				<div class="calendar-date-panel">
					<div class="calendar-date-panel-header">
						<strong>{{ calendarDateLabel(selectedDate, locale, {year: 'numeric', month: 'long'}) }}</strong>
						<button
							type="button"
							class="calendar-control"
							:aria-expanded="pickerExpanded"
							@click="pickerExpanded = !pickerExpanded"
						>
							{{ t(pickerExpanded ? 'calendar.collapseMonth' : 'calendar.expandMonth') }}
						</button>
					</div>
					<CalendarMonthView
						:dates="pickerDates"
						:anchor="selectedDate"
						:selected-date="selectedDate"
						:today="today"
						:segments="segments"
						:timezone="timezone"
						:show-lunar="showLunar"
						:collapsed="!pickerExpanded"
						:dense="true"
						picker
						@select="revealDay"
						@create="openCreate"
					/>
				</div>
				<CalendarAgenda
					:dates="range.dates"
					:segments="segments"
					:timezone="timezone"
					:today="today"
					allow-create
					:loading="query.isPending.value"
					@create="openCreate"
				/>
				<p
					v-if="count === 0 && !query.isPending.value && !query.isFetching.value"
					class="calendar-empty"
				>
					{{ t('calendar.emptyRange') }}
				</p>
			</template>
		</div>
		<p class="calendar-footnote">
			{{ t('calendar.dateSemantics') }}
		</p>
		<nav
			class="calendar-mobile-actions"
			:aria-label="t('calendar.quickActions')"
		>
			<button
				type="button"
				class="calendar-control"
				@click="jumpToDate(today)"
			>
				{{ t('calendar.today') }}
			</button>
			<button
				type="button"
				class="calendar-control is-primary"
				@click="openCreate()"
			>
				<Icon icon="plus" />{{ t('calendar.create.label') }}
			</button>
		</nav>
		<CalendarCreateDialog
			v-if="createOpen"
			:key="createSequence"
			:date="createSelection.date"
			:initial-start="createSelection.start"
			:initial-end="createSelection.end"
			:initial-all-day="createSelection.allDay"
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
	gap: var(--space-3);
	min-inline-size: 0;
	max-inline-size: 100%;
	color: var(--text-primary);
}

.calendar-presentation {
	display: inline-flex;
	justify-self: start;
	gap: var(--space-1);
	max-inline-size: 100%;
	padding: var(--space-1);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-full);
	background: var(--surface-sunken);

	button {
		min-block-size: 2.25rem;
		padding-inline: var(--space-3);
		border: 0;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;

		&[aria-pressed='true'] {
			background: var(--surface);
			color: var(--text-primary);
			box-shadow: var(--shadow-sm);
		}

		&:focus-visible { outline: 2px solid var(--focus-ring-color); }
	}
}

.calendar-date-panel-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
	min-inline-size: 0;
	margin-block-end: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);

	> span { min-inline-size: 0; }
	> button { flex-shrink: 0; }
}

.calendar-month-panel,
.calendar-date-panel,
#calendar-selected-day {
	min-inline-size: 0;
	scroll-margin-block-start: var(--space-4);
}

.calendar-mobile-actions { display: none; }

.calendar-heading-actions,
.calendar-date-navigation,
.calendar-period-heading,
.calendar-filters {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
}

.calendar-control {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-inline-size: 0;
	max-inline-size: 100%;
	min-block-size: 2.25rem;
	padding: var(--space-1) var(--space-2);
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
	inline-size: 2.25rem;
	padding: 0;
}

.calendar-date-input {
	inline-size: 9rem;
}

.calendar-period-heading h2 {
	margin: 0;
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
}

.calendar-timezone {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.calendar-project-filter {
	inline-size: 12rem;
	max-inline-size: 12rem;
	text-overflow: ellipsis;
}

.calendar-check {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: 2.25rem;
	font-size: var(--text-sm);
	cursor: pointer;

	input {
		margin: 0;
		accent-color: var(--primary);
	}
}

.calendar-display-fields {
	inline-size: min(32rem, calc(100vw - 2rem));
	color: var(--text-primary);
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
	grid-area: status;
	justify-self: end;
	min-inline-size: 0;
	max-inline-size: 11rem;
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
	display: block;
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
.calendar-command-bar {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr) auto;
	grid-template-areas:
		'primary primary primary'
		'navigation filters status';
	align-items: center;
	gap: var(--space-2) var(--space-3);
	min-inline-size: 0;
}
.calendar-primary-controls {
	grid-area: primary;
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto auto;
	grid-template-areas: 'period views actions';
	align-items: center;
	gap: var(--space-3);
	min-inline-size: 0;
}
.calendar-period-heading { grid-area: period; }
.calendar-heading-actions {
	grid-area: actions;
	flex-wrap: nowrap;
	justify-content: end;
}
.calendar-view-controls {
	grid-area: views;
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
}
.calendar-date-navigation {
	grid-area: navigation;
	flex-wrap: nowrap;
	> button {
		flex-shrink: 0;
		white-space: nowrap;
	}
}
.calendar-filters { grid-area: filters; }
.calendar-filter-toggle { display: none; }
.calendar-filter-count {
	display: inline-grid;
	min-inline-size: 1.25rem;
	block-size: 1.25rem;
	padding-inline: var(--space-1);
	border-radius: var(--radius-full);
	background: var(--surface-selected-strong);
	color: var(--accent-text);
	font-size: var(--text-xs);
	place-items: center;
}
.calendar-display-trigger {
	gap: var(--space-2);
	white-space: nowrap;
}
@media (769px <= width <= 1100px) {
	.calendar-primary-controls { display: contents; }
	.calendar-presentation { display: none; }
	.calendar-command-bar {
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'period actions'
			'navigation views'
			'filters status';
	}
	.calendar-view-controls { justify-content: end; }
}
@media (width <= 768px) {
	.calendar-page {
		padding-block-end: 5rem;
	}
	.calendar-command-bar {
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'primary primary'
			'navigation filter-toggle';
		&.has-expanded-filters {
			grid-template-areas:
				'primary primary'
				'navigation filter-toggle'
				'status status'
				'filters filters';
			.calendar-primary-controls {
				grid-template-areas:
					'period views'
					'actions actions';
			}
		}
	}
	.calendar-primary-controls {
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas: 'period views';
	}
	.calendar-period-heading {
		gap: var(--space-1) var(--space-2);
		h2 { font-size: var(--text-base); }
	}
	.calendar-view-controls { justify-content: end; }
	.calendar-presentation,
	.calendar-heading-actions .is-primary,
	.calendar-today-control { display: none; }
	.calendar-control,
	.calendar-check,
	.calendar-presentation button { min-block-size: 2.75rem; }
	.calendar-control { padding-inline: var(--space-3); }
	.calendar-icon-button { inline-size: 2.75rem; }
	.calendar-date-input {
		flex: 1;
		inline-size: 8rem;
	}
	.calendar-filter-toggle {
		grid-area: filter-toggle;
		position: relative;
		display: inline-flex;
		justify-self: end;
		inline-size: 2.75rem;
		padding: 0;
	}
	.calendar-filter-count {
		position: absolute;
		inset-block-start: 1px;
		inset-inline-end: 1px;
		min-inline-size: 1rem;
		block-size: 1rem;
	}
	.calendar-project-filter {
		flex: 1 1 100%;
		max-inline-size: 100%;
	}
	.calendar-heading-actions { justify-content: start; }
	.calendar-display-fields {
		box-sizing: border-box;
		inline-size: 100%;
		padding: 0 var(--space-4) var(--space-4);
		border: 0;
		border-radius: 0;
		> label { inline-size: 100%; }
		input[type='range'] {
			flex: 1;
			min-inline-size: 0;
		}
	}
	.calendar-mobile-actions {
		position: fixed;
		z-index: 25;
		inset-inline: var(--space-3) 4.75rem;
		inset-block-end: calc(env(safe-area-inset-bottom, 0px) + var(--space-3));
		display: flex;
		gap: var(--space-2);
		padding: var(--space-2);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-full);
		background: var(--surface);
		box-shadow: var(--shadow-md);

		.calendar-control {
			flex: 1;
			gap: var(--space-2);
			border-radius: var(--radius-full);
		}
	}

}
</style>
