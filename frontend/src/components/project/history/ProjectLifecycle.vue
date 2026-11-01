<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, shallowRef, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'

import ProjectStatusBadges from '@/components/project/partials/ProjectStatusBadges.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import type {ProjectHistory} from '@/client/generated'
import {projectHistoryQuery} from '@/client/queries/projectHistory'
import {useProjects} from '@/composables/useProjects'
import {projectCalendar} from '@/helpers/projectCalendar'
import {
	HEAT_LEVELS,
	HISTORY_KIND_FILTERS,
	calendarDayFormatter,
	formatCalendarDay,
	formatCalendarMonth,
	formatInstantDate,
	heatLevel,
	historyEventIcon,
	parseCalendarDay,
	parseHistoryEventKind,
	parseHistoryKind,
} from '@/helpers/projectHistoryFormat'
import {isRealProject} from '@/helpers/projectStatus'
import {resolveUserTimezone} from '@/helpers/time/userTimezone'
import {useAuthStore} from '@/stores/auth'

const DAY_HEADING_FORMAT: Intl.DateTimeFormatOptions = {
	weekday: 'short',
	year: 'numeric',
	month: 'short',
	day: 'numeric',
}

const {t, locale} = useI18n({useScope: 'global'})
const route = useRoute()
const router = useRouter()
const projects = useProjects()
const auth = useAuthStore()

const timezone = computed(() => resolveUserTimezone(auth.settings.timezone))
const currentYear = computed(() => Number(new Intl.DateTimeFormat('en', {
	year: 'numeric',
	timeZone: timezone.value,
}).format(new Date())))
const year = computed(() => Math.min(9998, Math.max(1970, Number(route.query.year) || currentYear.value)))
const project = computed(() => Math.max(0, Number(route.query.project) || 0))
const kind = computed(() => parseHistoryKind(route.query.kind))
const day = computed(() => parseCalendarDay(route.query.day, year.value))
const unknown = computed(() => route.query.unknown === 'true')
const page = computed(() => Math.max(1, Number(route.query.page) || 1))
const search = ref(String(route.query.q || ''))
watch(() => route.query.q, value => {
	search.value = String(value || '')
})

function select(values: Record<string, string | number | undefined>) {
	return router.replace({
		query: {
			...route.query,
			page: undefined,
			...values,
		},
	})
}

// A pending search must not navigate after the view is gone (another tab or page is showing by then).
let searchTimer: ReturnType<typeof setTimeout> | undefined
function updateSearch() {
	clearTimeout(searchTimer)
	searchTimer = setTimeout(() => select({
		q: search.value || undefined,
		day: undefined,
		unknown: undefined,
	}), 300)
}
onBeforeUnmount(() => clearTimeout(searchTimer))

const query = useQuery(computed(() => projectHistoryQuery({
	year: year.value,
	timezone: timezone.value,
	project: project.value,
	kind: kind.value,
	day: day.value || undefined,
	unknown: unknown.value,
	q: String(route.query.q || ''),
	page: page.value,
})))

// Filter changes have no placeholder data. Keep the previous result on screen, dimmed,
// instead of collapsing the page into a loading message on every change.
const lastHistory = shallowRef<ProjectHistory>()
watch(() => query.data.value, value => {
	if (value) lastHistory.value = value
}, {immediate: true})
const history = computed(() => query.data.value ?? (query.isFetching.value ? lastHistory.value : undefined))
const refreshing = computed(() => query.isPlaceholderData.value || (!query.data.value && history.value !== undefined))
const failed = computed(() => query.isError.value && !query.isFetching.value)

const projectOptions = computed(() => projects.projectsArray
	.filter(isRealProject)
	.map(p => ({
		id: p.id,
		label: p.is_archived ? t('projectHistory.projectOptionArchived', {title: p.title}) : p.title,
	})))

const days = computed(() => projectCalendar(year.value))
const months = computed(() => Array.from({length: 12}, (_, month) => ({
	name: formatCalendarMonth(year.value, month, locale.value),
	days: days.value.filter(d => d.month === month),
})))
const count = (date: string) => history.value?.days?.[date] || 0
const maxCount = computed(() => Math.max(1, ...Object.values(history.value?.days || {})))
const level = (date: string) => heatLevel(count(date), maxCount.value)
const monthCounts = computed(() => months.value.map(month => month.days.reduce((total, d) => total + count(d.date), 0)))

const dayLabels = computed(() => {
	const format = calendarDayFormatter(locale.value)
	return new Map(days.value.map(d => {
		const total = count(d.date)
		return [d.date, t('projectHistory.dayLabel', {date: format(d.date), count: total}, total)] as const
	}))
})
const monthLabels = computed(() => monthCounts.value.map((total, index) => t('projectHistory.monthLabel', {
	month: formatCalendarMonth(year.value, index, locale.value, {
		month: 'long',
		year: 'numeric',
	}),
	count: total,
}, total)))
const weekDays = computed(() => Array.from({length: 7}, (_, index) => new Intl.DateTimeFormat(locale.value, {
	weekday: 'narrow',
	timeZone: 'UTC',
}).format(new Date(Date.UTC(2024, 0, 1 + index)))))

const pickedMonth = ref<number | null>(null)
watch(year, () => {
	pickedMonth.value = null
})
const shownMonth = computed(() => {
	if (pickedMonth.value !== null) return pickedMonth.value
	if (day.value) return Number(day.value.slice(5, 7)) - 1
	if (year.value === currentYear.value) {
		return Number(new Intl.DateTimeFormat('en', {
			month: 'numeric',
			timeZone: timezone.value,
		}).format(new Date())) - 1
	}
	return Math.max(0, monthCounts.value.findIndex(total => total > 0))
})

function chooseMonth(index: number) {
	pickedMonth.value = index
	void select({day: undefined, unknown: undefined})
}

function chooseDay(date: string) {
	void select({day: day.value === date ? undefined : date, unknown: undefined})
}

async function keyboardDay(event: KeyboardEvent, date: string, monthly = false) {
	const steps: Record<string, number> = {
		ArrowRight: monthly ? 1 : 7,
		ArrowLeft: monthly ? -1 : -7,
		ArrowDown: monthly ? 7 : 1,
		ArrowUp: monthly ? -7 : -1,
	}
	const step = steps[event.key]
	if (!step) return
	event.preventDefault()
	const index = days.value.findIndex(d => d.date === date)
	const next = days.value[Math.min(days.value.length - 1, Math.max(0, index + step))]
	if (monthly) {
		pickedMonth.value = next.month
		await nextTick()
	}
	const container = (event.target as HTMLElement).closest(monthly ? '.month-grid' : '.year-grid')
	container?.querySelector<HTMLButtonElement>(`button[data-date="${next.date}"]`)?.focus()
}

const recordsHeading = computed(() => {
	if (unknown.value) return t('projectHistory.unknownHeading')
	if (day.value) return formatCalendarDay(day.value, locale.value, DAY_HEADING_FORMAT)
	return t('projectHistory.yearRecords', {year: year.value})
})
const recordsCount = computed(() => {
	const total = history.value?.total ?? 0
	return t('projectHistory.recordsCount', {n: total}, total)
})

// Nothing recorded for the whole year: explain what this page records instead of only saying it is empty.
const explainEmpty = computed(() => !search.value.trim() && !day.value && !unknown.value && (kind.value === 'milestones' || kind.value === 'all'))
const scope = computed(() => ({
	projects: history.value?.scope?.projects ?? 0,
	completed: history.value?.scope?.completed ?? 0,
	archived: history.value?.scope?.archived ?? 0,
}))
// The timeline counts tasks by their dates; it keeps this page's year, project and search.
const timelineLink = computed(() => ({
	name: 'projects.history',
	query: {
		year: route.query.year,
		project: route.query.project,
		q: route.query.q,
	},
}))

const records = computed(() => (history.value?.items || []).map(item => {
	const eventKind = parseHistoryEventKind(item.kind)
	return {
		...item,
		eventLabel: eventKind ? t(`projectHistory.kinds.${eventKind}`) : item.kind,
		occurredOn: formatInstantDate(item.occurred_at, locale.value, timezone.value),
		createdOn: formatInstantDate(item.created, locale.value, timezone.value),
	}
}))

watch(() => query.data.value?.total_pages, total => {
	if (total !== undefined && page.value > Math.max(1, total)) void select({page: Math.max(1, total)})
})
</script>

<template>
	<section
		class="project-lifecycle"
		:aria-busy="query.isFetching.value"
	>
		<div class="history-filters">
			<label class="history-filter">
				<span class="filter-label">{{ t('projectHistory.project') }}</span>
				<select
					class="history-field"
					:value="project"
					:aria-label="t('projectHistory.project')"
					@change="select({
						project: ($event.target as HTMLSelectElement).value,
						day: undefined,
						unknown: undefined,
					})"
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
			<label class="history-filter">
				<span class="filter-label">{{ t('projectHistory.type') }}</span>
				<select
					class="history-field"
					:value="kind"
					:aria-label="t('projectHistory.type')"
					@change="select({
						kind: ($event.target as HTMLSelectElement).value,
						day: undefined,
						unknown: undefined,
					})"
				>
					<option
						v-for="k in HISTORY_KIND_FILTERS"
						:key="k"
						:value="k"
					>
						{{ t(`projectHistory.kinds.${k}`) }}
					</option>
				</select>
			</label>
			<label class="history-filter filter-search">
				<span class="filter-label">{{ t('projectHistory.search') }}</span>
				<input
					v-model="search"
					class="history-field"
					:aria-label="t('projectHistory.search')"
					type="search"
					maxlength="250"
					:placeholder="t('projectHistory.searchPlaceholder')"
					@input="updateSearch()"
				>
			</label>
		</div>

		<span
			class="is-sr-only"
			role="status"
		>{{ refreshing ? t('projectHistory.loading') : '' }}</span>

		<!-- Like the timeline: a failed refresh keeps the records that are already on screen and says so above them. -->
		<div
			v-if="query.isError.value && !history"
			class="history-state"
			role="alert"
		>
			<p>{{ t('projectHistory.loadError') }}</p>
			<button
				type="button"
				class="history-button"
				@click="query.refetch()"
			>
				{{ t('projectHistory.retry') }}
			</button>
		</div>
		<template v-else-if="history">
			<LoadError
				v-if="failed"
				class="history-stale-error"
				:message="t('projectHistory.loadError')"
				:retry="() => query.refetch()"
			/>
			<p
				class="history-stats"
				:class="{'is-refreshing': refreshing}"
				aria-live="polite"
			>
				<i18n-t
					keypath="projectHistory.projectsCount"
					:plural="history.projects ?? 0"
					scope="global"
					tag="span"
					class="history-stat"
				>
					<template #n>
						<strong>{{ history.projects ?? 0 }}</strong>
					</template>
				</i18n-t>
				<i18n-t
					keypath="projectHistory.milestonesCount"
					:plural="history.milestones ?? 0"
					scope="global"
					tag="span"
					class="history-stat"
				>
					<template #n>
						<strong>{{ history.milestones ?? 0 }}</strong>
					</template>
				</i18n-t>
				<i18n-t
					keypath="projectHistory.activeDays"
					:plural="history.active_days ?? 0"
					scope="global"
					tag="span"
					class="history-stat"
				>
					<template #n>
						<strong>{{ history.active_days ?? 0 }}</strong>
					</template>
				</i18n-t>
			</p>

			<section
				class="calendar-card"
				:class="{'is-refreshing': refreshing}"
				:aria-label="t('projectHistory.calendar')"
			>
				<div class="year-calendar">
					<div
						class="month-labels"
						aria-hidden="true"
					>
						<span
							v-for="month in months"
							:key="month.name"
							:style="{gridColumn: String(month.days[0].week + 1)}"
						>{{ month.name }}</span>
					</div>
					<div class="year-grid">
						<button
							v-for="d in days"
							:key="d.date"
							type="button"
							:data-date="d.date"
							:data-level="level(d.date)"
							:aria-label="dayLabels.get(d.date)"
							:title="dayLabels.get(d.date)"
							:aria-pressed="day === d.date && !unknown"
							:tabindex="d.date === (day || days[0].date) ? 0 : -1"
							:style="{gridColumn: d.week + 1, gridRow: d.weekday + 1}"
							@click="chooseDay(d.date)"
							@keydown="keyboardDay($event, d.date)"
						/>
					</div>
				</div>
				<div class="month-picker">
					<button
						v-for="(month, index) in months"
						:key="month.name"
						type="button"
						class="history-button month-button"
						:aria-pressed="shownMonth === index"
						:aria-label="monthLabels[index]"
						@click="chooseMonth(index)"
					>
						{{ month.name }}
						<span
							v-if="monthCounts[index]"
							class="month-count"
						>{{ monthCounts[index] }}</span>
					</button>
				</div>
				<div class="month-grid">
					<section
						v-for="(month, index) in months"
						v-show="index === shownMonth"
						:key="month.name"
						class="mini-month"
					>
						<h3>{{ month.name }}</h3>
						<div
							class="month-weekdays"
							aria-hidden="true"
						>
							<span
								v-for="(weekday, weekIndex) in weekDays"
								:key="weekIndex"
							>{{ weekday }}</span>
						</div>
						<div class="month-days">
							<button
								v-for="d in month.days"
								:key="d.date"
								type="button"
								:data-date="d.date"
								:data-level="level(d.date)"
								:title="dayLabels.get(d.date)"
								:aria-label="dayLabels.get(d.date)"
								:aria-pressed="day === d.date && !unknown"
								:tabindex="d.date === (day || month.days[0].date) ? 0 : -1"
								:style="{gridColumn: d.weekday + 1}"
								@click="chooseDay(d.date)"
								@keydown="keyboardDay($event, d.date, true)"
							>
								{{ d.day }}
							</button>
						</div>
					</section>
				</div>
				<div class="calendar-legend">
					<span
						class="legend-scale"
						aria-hidden="true"
					>
						<span>{{ t('projectHistory.less') }}</span>
						<i
							v-for="n in HEAT_LEVELS"
							:key="n"
							:data-level="n"
						/>
						<span>{{ t('projectHistory.more') }}</span>
					</span>
					<span>{{ t('projectHistory.legendShading') }}</span>
					<span>{{ t('projectHistory.timezoneNote', {timezone}) }}</span>
				</div>
				<p class="calendar-help">
					{{ t('projectHistory.calendarHelp') }}
				</p>
			</section>

			<div class="records-heading">
				<h2>
					{{ recordsHeading }}
					<small class="records-count">{{ recordsCount }}</small>
				</h2>
				<div class="record-actions">
					<button
						v-if="day || unknown"
						type="button"
						class="history-button"
						@click="select({day: undefined, unknown: undefined})"
					>
						{{ t('projectHistory.clearDay') }}
					</button>
					<button
						v-if="history.unknown"
						type="button"
						class="history-button"
						:aria-pressed="unknown"
						@click="select({unknown: unknown ? undefined : 'true', day: undefined})"
					>
						{{ t('projectHistory.unknownRecords', {count: history.unknown}) }}
					</button>
				</div>
			</div>
			<p
				v-if="unknown"
				class="calendar-help unknown-help"
			>
				{{ t('projectHistory.unknownHelp') }}
			</p>
			<div
				v-if="!records.length"
				class="history-state"
				:class="{'is-refreshing': refreshing}"
			>
				<Icon
					icon="calendar"
					class="history-state-icon"
				/>
				<template v-if="explainEmpty">
					<h3>{{ t('projectHistory.emptyYear', {year}) }}</h3>
					<p class="history-state-text">
						{{ t('projectHistory.emptyWhat') }}
					</p>
					<dl
						class="history-scope"
						:aria-label="t('projectHistory.scope.label')"
					>
						<div>
							<dt>{{ t('projectHistory.scope.projects') }}</dt>
							<dd>{{ scope.projects }}</dd>
						</div>
						<div>
							<dt>{{ t('projectHistory.scope.completed') }}</dt>
							<dd>{{ scope.completed }}</dd>
						</div>
						<div>
							<dt>{{ t('projectHistory.scope.archived') }}</dt>
							<dd>{{ scope.archived }}</dd>
						</div>
					</dl>
					<p
						v-if="scope.completed || scope.archived"
						class="history-state-text"
					>
						{{ t('projectHistory.emptyOtherYears') }}
					</p>
					<p class="history-state-text">
						{{ t('projectHistory.emptyHow') }}
					</p>
					<div class="history-state-links">
						<RouterLink
							class="history-button"
							:to="{name: 'projects.index'}"
						>
							{{ t('projectHistory.goToProjects') }}
						</RouterLink>
						<RouterLink
							class="history-button"
							:to="timelineLink"
						>
							{{ t('projectHistory.goToTimeline') }}
						</RouterLink>
					</div>
				</template>
				<template v-else>
					<h3>{{ t('projectHistory.empty') }}</h3>
					<p>{{ t('projectHistory.emptyHelp') }}</p>
				</template>
			</div>
			<ol
				v-else
				class="history-records"
				:class="{'is-refreshing': refreshing}"
			>
				<li
					v-for="item in records"
					:key="item.id"
					class="history-record"
				>
					<p class="record-event">
						<span
							class="event-badge"
							:data-kind="item.kind"
						>
							<Icon
								:icon="historyEventIcon(item.kind)"
								class="event-icon"
							/>
							{{ item.eventLabel }}
						</span>
						<time
							v-if="item.occurredOn"
							class="record-date"
							:datetime="item.occurred_at"
						>{{ item.occurredOn }}</time>
						<span
							v-else
							class="record-date"
						>{{ t('projectHistory.unknownDate') }}</span>
					</p>
					<RouterLink
						class="record-title"
						:to="{name: 'project.index', params: {projectId: item.project_id}}"
					>
						{{ item.title }}
					</RouterLink>
					<p
						v-if="item.createdOn"
						class="record-created"
					>
						{{ t('projectHistory.createdOn', {date: item.createdOn}) }}
					</p>
					<p class="record-now">
						<span class="record-now-label">{{ t('projectHistory.now') }}</span>
						<ProjectStatusBadges
							:is-completed="item.is_completed"
							:is-archived="item.is_archived"
							show-active
						/>
					</p>
				</li>
			</ol>
			<nav
				v-if="(history.total_pages || 0) > 1"
				class="history-pagination"
				:aria-label="t('projectHistory.pagination')"
			>
				<button
					type="button"
					class="history-button"
					:disabled="page <= 1"
					@click="select({page: page - 1})"
				>
					{{ t('projectHistory.previous') }}
				</button>
				<span>{{ page }} / {{ history.total_pages }}</span>
				<button
					type="button"
					class="history-button"
					:disabled="page >= (history.total_pages || 1)"
					@click="select({page: page + 1})"
				>
					{{ t('projectHistory.next') }}
				</button>
			</nav>
		</template>
		<div
			v-else
			class="history-state"
			role="status"
		>
			{{ t('projectHistory.loading') }}
		</div>

		<details class="history-explanation">
			<summary>{{ t('projectHistory.explanation') }}</summary>
			<p>{{ t('projectHistory.explanationText') }}</p>
			<p>{{ t('projectHistory.archiveHelp') }}</p>
		</details>
	</section>
</template>

<style scoped lang="scss">
.project-lifecycle {
	// Heatmap ramp. Light: more activity is darker; dark (overridden below): more is brighter.
	--history-heat-0: var(--grey-100);
	--history-heat-0-text: var(--text);
	--history-heat-1: #c6e9c9;
	--history-heat-1-text: #14432a;
	--history-heat-2: #7cc896;
	--history-heat-2-text: #10391f;
	--history-heat-3: #237e4b;
	--history-heat-3-text: #ffffff;
	--history-heat-4: #11522f;
	--history-heat-4-text: #ffffff;
}

// Scoped :global() rewrites the whole selector, so the page class has to sit inside it.
@media screen {
	:global(:root.dark .project-lifecycle) {
		--history-heat-1: #0e4429;
		--history-heat-1-text: #d3f5df;
		--history-heat-2: #006d32;
		--history-heat-2-text: #ffffff;
		--history-heat-3: #26a641;
		--history-heat-3-text: #04260f;
		--history-heat-4: #39d353;
		--history-heat-4-text: #04260f;

		color-scheme: dark;
	}
}

h2 {
	color: var(--text-strong);
	font-size: 1.125rem;
	font-weight: 600;
}

.history-button,
.history-field {
	min-block-size: var(--control-height);
	padding: .3rem .7rem;
	border: 1px solid var(--input-border-color);
	border-radius: $radius;
	background: var(--surface);
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-md);

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 2px;
	}

	@media (pointer: coarse) {
		min-block-size: 2.75rem;
	}
}

.history-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: .375rem;
	cursor: pointer;
	transition: background-color var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard);

	&:hover:not(:disabled) {
		border-color: var(--input-hover-border-color);
		background: var(--surface-hover);
	}

	&:disabled {
		cursor: default;
		opacity: .45;
	}

	&[aria-pressed="true"] {
		border-color: hsla(var(--primary-hsl), .5);
		background: var(--surface-selected);
		color: var(--accent-text);
		font-weight: var(--weight-semibold);
	}
}

.history-filters {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: .75rem 1rem;
	margin-block-end: 1.25rem;
}

.history-filter {
	display: flex;
	flex-direction: column;
	gap: .25rem;
	min-inline-size: 0;
}

.filter-label {
	color: var(--text-muted);
	font-size: .8125rem;
	font-weight: 600;
}

.history-filter .history-field {
	inline-size: 100%;
	min-inline-size: 0;
}

.history-stats {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: .25rem 1.5rem;
	margin-block-end: 1rem;
	color: var(--text-muted);
	font-size: .875rem;
	// .app-content breaks anywhere; a stat label must never split mid-word ("project / s").
	overflow-wrap: normal;
}

.history-stat {
	white-space: nowrap;

	strong {
		color: var(--text-strong);
		font-size: 1.375rem;
		font-variant-numeric: tabular-nums;
		font-weight: 700;
	}
}

.history-stats,
.calendar-card,
.history-records,
.history-state {
	transition: opacity $transition-duration ease;

	&.is-refreshing {
		opacity: .55;
		// Short fetches finish before the delay, so they never flash.
		transition: opacity .2s ease .15s;
	}

	@media (prefers-reduced-motion: reduce) {
		&,
		&.is-refreshing {
			transition: none;
		}
	}
}

.calendar-card {
	margin-block-end: 1.5rem;
	padding: 1.25rem;
	border: 1px solid var(--grey-200);
	border-radius: .75rem;
	background: var(--white);
}

.year-calendar {
	overflow-x: auto;
	padding: 4px;
}

.year-grid,
.month-labels {
	display: grid;
	grid-template-columns: repeat(54, minmax(11px, 1fr));
	gap: 3px;
	min-inline-size: 720px;
}

.month-labels {
	margin-block-end: .5rem;
	color: var(--text-muted);
	font-size: .7rem;

	span {
		white-space: nowrap;
	}
}

.year-grid {
	grid-template-rows: repeat(7, 13px);

	button {
		min-block-size: 0;
		padding: 0;
		border: 0;
		border-radius: 3px;
		cursor: pointer;
	}
}

@each $level in 0, 1, 2, 3, 4 {
	[data-level="#{$level}"] {
		background: var(--history-heat-#{$level});
		color: var(--history-heat-#{$level}-text);
	}
}

.year-grid button,
.month-days button {
	&:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

	// Selection is a neutral ring so it stays distinct from the primary focus ring.
	&[aria-pressed="true"] {
		box-shadow: 0 0 0 2px var(--white), 0 0 0 4px var(--text-strong);
	}
}

.month-picker,
.month-grid {
	display: none;
}

.month-button {
	flex-direction: column;
	gap: 0;
	min-block-size: 2.75rem;
	padding: .25rem .125rem;
	font-size: .8125rem;
	line-height: 1.2;
}

.month-count {
	color: var(--text-strong);
	font-size: .6875rem;
	font-variant-numeric: tabular-nums;
	font-weight: 700;

	[aria-pressed="true"] > & {
		color: inherit;
	}
}

.mini-month h3 {
	margin-block-end: .5rem;
	color: var(--text-strong);
	font-size: .875rem;
	font-weight: 600;
}

.month-weekdays,
.month-days {
	display: grid;
	grid-template-columns: repeat(7, minmax(0, 1fr));
}

.month-weekdays {
	margin-block-end: .25rem;
	color: var(--text-muted);
	font-size: .75rem;
	text-align: center;
}

.month-days {
	gap: 3px;

	button {
		min-block-size: 2.25rem;
		padding: 0;
		border: 0;
		border-radius: 4px;
		font: inherit;
		font-size: .8125rem;
		font-variant-numeric: tabular-nums;
		cursor: pointer;

		@media (pointer: coarse) {
			min-block-size: 2.75rem;
		}
	}
}

.calendar-legend {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: .375rem 1rem;
	margin-block: 1rem .375rem;
	color: var(--text-muted);
	font-size: .75rem;
}

.legend-scale {
	display: inline-flex;
	align-items: center;
	gap: .25rem;

	i {
		inline-size: 12px;
		block-size: 12px;
		border-radius: 3px;
	}
}

.calendar-help {
	color: var(--text-muted);
	font-size: .8125rem;
	line-height: 1.6;
}

.records-heading {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: .5rem 1rem;
	margin-block-end: .75rem;
}

.records-count {
	margin-inline-start: .5rem;
	color: var(--text-muted);
	font-size: .8125rem;
	font-weight: 400;
	white-space: nowrap;
}

.record-actions {
	display: flex;
	flex-wrap: wrap;
	gap: .5rem;
}

.unknown-help {
	margin-block-end: .75rem;
}

.history-records {
	display: grid;
	// Fixed-width tracks keep a lone record card the same size as in a full page of results.
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
	gap: .75rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

.history-record {
	display: flex;
	flex-direction: column;
	gap: .5rem;
	min-inline-size: 0;
	padding: .875rem 1rem;
	border: 1px solid var(--grey-200);
	border-radius: .75rem;
	background: var(--white);
}

.record-event {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: .25rem .5rem;
	font-size: .8125rem;
}

.record-date {
	color: var(--text-muted);
	font-variant-numeric: tabular-nums;
}

.event-badge {
	display: inline-flex;
	align-items: center;
	gap: .3rem;
	padding: .125rem .5rem;
	border: 1px solid var(--grey-300);
	border-radius: .375rem;
	background: var(--white);
	color: var(--text);
	font-size: .75rem;
	font-weight: 600;
	line-height: 1.5;
	white-space: nowrap;

	&[data-kind="completed"] {
		border-color: hsla(var(--success-h), var(--success-s), var(--success-l), .4);
		background: hsla(var(--success-h), var(--success-s), var(--success-l), .14);
		color: color-mix(in srgb, var(--success) 42%, var(--text-strong));
	}

	&[data-kind="archived"] {
		border-color: var(--grey-300);
		background: var(--grey-200);
		color: var(--text-strong);
	}

	&[data-kind="reopened"] {
		border-color: hsla(var(--primary-hsl), .4);
		background: hsla(var(--primary-hsl), .1);
		color: color-mix(in srgb, var(--primary) 70%, var(--text-strong));
	}
}

.event-icon {
	inline-size: .75rem;
	block-size: .75rem;
	flex-shrink: 0;
}

.record-title {
	font-size: 1rem;
	font-weight: 600;
	line-height: 1.35;
	overflow-wrap: anywhere;
}

.record-created {
	color: var(--text-muted);
	font-size: .8125rem;
}

.record-now {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: .375rem;
	margin-block-start: auto;
	padding-block-start: .5rem;
	border-block-start: 1px solid var(--grey-200);
}

.record-now-label {
	color: var(--text-muted);
	font-size: .75rem;
}

.history-pagination {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: .5rem;
	margin-block: 1.25rem;
	font-variant-numeric: tabular-nums;
}


.history-stale-error {
	margin-block-end: var(--space-3);
}
.history-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: .5rem;
	padding: 2.5rem 1rem;
	color: var(--text-muted);
	text-align: center;

	h3 {
		color: var(--text);
		font-size: 1rem;
		font-weight: 600;
	}
}

.history-state-text {
	max-inline-size: 60ch;
	margin: 0;
	line-height: var(--leading-normal);
}

// The current state of the projects in view; it does not depend on the year.
.history-scope {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: var(--space-2) var(--space-5);
	margin: var(--space-1) 0;

	div {
		display: flex;
		flex-direction: column-reverse;
		align-items: center;
	}

	dt {
		font-size: var(--text-xs);
	}

	dd {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-xl);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}
}

.history-state-links {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: var(--space-2);
	margin-block-start: var(--space-2);

	.history-button {
		text-decoration: none;
	}
}

.history-state-icon {
	inline-size: 1.25rem;
	block-size: 1.25rem;
}

.history-explanation {
	margin-block-start: 1.5rem;
	color: var(--text-muted);
	font-size: .875rem;
	line-height: 1.65;

	summary {
		padding-block: .25rem;
		color: var(--text);
		cursor: pointer;

		@media (pointer: coarse) {
			padding-block: .625rem;
		}
	}
}

@media (width <= 700px) {
	.history-filters {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: .5rem .75rem;
	}

	.filter-search {
		grid-column: 1 / -1;
	}

	.calendar-card {
		padding: .875rem;
	}

	.year-calendar {
		display: none;
	}

	.month-picker {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: .375rem;
		margin-block-end: 1rem;
	}

	.month-grid {
		display: grid;
	}

	// Keyboard focus scrolls controls clear of the fixed launcher instead of under it.
	button,
	select,
	input,
	a,
	summary {
		scroll-margin-block-end: var(--history-launcher-clearance);
	}
}
</style>
