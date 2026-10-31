<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'

import ProjectStatusBadges from '@/components/project/partials/ProjectStatusBadges.vue'
import type {ProjectTimelineDeadline} from '@/client/generated'
import type {ProjectTimelineRow} from '@/client/queries/projectTimeline'
import {colorFromHex} from '@/helpers/color/colorFromHex'
import {calendarDayFormatter, formatCalendarMonth} from '@/helpers/projectHistoryFormat'
import {
	domainTicks,
	futureSpans,
	placeDay,
	placeSpans,
	progressPercent,
	type TimelineDomain,
} from '@/helpers/projectTimeline'

const props = defineProps<{
	items: ProjectTimelineRow[]
	domain: TimelineDomain
	year: number
	today?: string
	selectedDay: string
	/** Hides the per-lane "only this project" action while a project filter is active. */
	focusedProject?: number
}>()

const emit = defineEmits<{
	focusProject: [id: number]
}>()

const {t, locale} = useI18n({useScope: 'global'})

const shortDay = computed(() => calendarDayFormatter(locale.value, {
	month: 'short',
	day: 'numeric',
}))
const fullDay = computed(() => calendarDayFormatter(locale.value, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
}))

// Dates outside the selected year carry their year so a span reaching into another year reads right.
function formatDay(date: string) {
	return date.startsWith(`${props.year}-`) ? shortDay.value(date) : fullDay.value(date)
}

function formatRange(start: string | undefined, end: string | undefined) {
	if (!start || !end) return ''
	return start === end
		? formatDay(start)
		: t('projectTimeline.lanes.range', {
			start: formatDay(start),
			end: formatDay(end),
		})
}

const ticks = computed(() => domainTicks(props.domain).map(tick => ({
	...tick,
	label: props.domain.length > 31
		? formatCalendarMonth(props.year, tick.value, locale.value)
		: String(tick.value),
})))

const todayAt = computed(() => placeDay(props.today, props.domain))
const selectedAt = computed(() => placeDay(props.selectedDay || undefined, props.domain))

function laneColor(hex: string | undefined) {
	const color = colorFromHex(hex ?? '')
	return /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : undefined
}

type DeadlineState = 'done' | 'open' | 'overdue'

function deadlineState(node: ProjectTimelineDeadline): DeadlineState {
	if (!node.open) return 'done'
	return props.today && node.date! < props.today ? 'overdue' : 'open'
}

// Every due date of the year as its own node: a date, never scheduled time.
function deadlineNodes(item: ProjectTimelineRow) {
	return item.deadline_days.flatMap(node => {
		const left = placeDay(node.date, props.domain)
		if (left === null || !node.date) return []
		const state = deadlineState(node)
		const count = node.count ?? 0
		return [{
			date: node.date,
			left,
			state,
			title: t(`projectTimeline.lanes.node.${state}`, {
				date: formatDay(node.date),
				count,
				done: node.done ?? 0,
				open: node.open ?? 0,
			}, count),
		}]
	})
}

const lanes = computed(() => props.items.map(item => {
	const scheduled = placeSpans(item.scheduled_spans ?? [], props.domain).map(box => ({
		...box,
		title: t('projectTimeline.lanes.spanTitle', {range: formatRange(box.start, box.end)}),
	}))
	const deadlines = deadlineNodes(item)
	const percent = progressPercent(item.progress)
	return {
		item,
		color: laneColor(item.hex_color),
		scheduled,
		elapsed: placeSpans(item.elapsed_spans ?? [], props.domain),
		planned: placeSpans(futureSpans(item.scheduled_spans ?? [], props.today), props.domain),
		deadlines,
		outside: scheduled.length === 0 && deadlines.length === 0,
		// Only due dates this year (or a range that lies in another year): no span to describe.
		deadlinesOnly: !item.ranged_tasks && item.deadline_days.length > 0,
		percent,
		range: formatRange(item.start_date, item.end_date),
		days: t('projectTimeline.lanes.days', {
			elapsed: item.elapsed_days ?? 0,
			scheduled: item.scheduled_days ?? 0,
			year: props.year,
		}),
	}
}))

const outsideLabel = computed(() => props.domain.length > 31
	? ''
	: t('projectTimeline.lanes.outside', {
		month: formatCalendarMonth(props.year, Number(props.domain.start.slice(5, 7)) - 1, locale.value, {month: 'long'}),
	}))
</script>

<template>
	<div class="timeline-lanes">
		<ul class="lanes-legend">
			<li>
				<i class="legend-mark is-elapsed" />{{ t('projectTimeline.legend.elapsed') }}
			</li>
			<li>
				<i class="legend-mark is-planned" />{{ t('projectTimeline.legend.planned') }}
			</li>
			<li>
				<i class="legend-mark is-unelapsed" />{{ t('projectTimeline.legend.unelapsed') }}
			</li>
			<li>
				<i class="legend-mark is-deadline is-open" />{{ t('projectTimeline.lanes.legendOpen') }}
			</li>
			<li>
				<i class="legend-mark is-deadline is-done" />{{ t('projectTimeline.lanes.legendDone') }}
			</li>
			<li>
				<i class="legend-mark is-deadline is-overdue" />{{ t('projectTimeline.lanes.legendOverdue') }}
			</li>
			<li>
				<i class="legend-mark is-today" />{{ t('projectTimeline.legend.today') }}
			</li>
			<li>
				<i class="legend-mark is-progress" />{{ t('projectTimeline.legend.progress') }}
			</li>
		</ul>
		<div
			class="lanes-axis"
			aria-hidden="true"
		>
			<span class="lanes-axis-spacer" />
			<div class="lanes-axis-track">
				<span
					v-for="tick in ticks"
					:key="tick.date"
					class="lanes-axis-tick"
					:style="{insetInlineStart: `${tick.left}%`}"
				>{{ tick.label }}</span>
			</div>
		</div>
		<ol class="lanes-list">
			<li
				v-for="lane in lanes"
				:key="lane.item.id"
				class="lane"
				:class="{'is-outside': lane.outside}"
				:style="lane.color ? {'--lane-color': lane.color} : undefined"
				:data-project-id="lane.item.id"
			>
				<div class="lane-meta">
					<div class="lane-title-row">
						<span
							class="lane-swatch"
							aria-hidden="true"
						/>
						<RouterLink
							class="lane-title"
							:to="{name: 'project.index', params: {projectId: lane.item.id}}"
						>
							{{ lane.item.title }}
						</RouterLink>
						<ProjectStatusBadges
							:is-completed="lane.item.is_completed"
							:is-archived="lane.item.is_archived"
						/>
						<button
							v-if="focusedProject !== lane.item.id"
							type="button"
							class="lane-focus"
							:aria-label="t('projectTimeline.lanes.focus', {title: lane.item.title})"
							:title="t('projectTimeline.lanes.focus', {title: lane.item.title})"
							@click="emit('focusProject', lane.item.id!)"
						>
							<Icon
								icon="filter"
								class="lane-focus-icon"
							/>
						</button>
					</div>
					<div class="lane-progress">
						<span
							class="lane-progress-bar"
							role="progressbar"
							aria-valuemin="0"
							aria-valuemax="100"
							:aria-valuenow="lane.percent"
							:aria-valuetext="t('projectTimeline.lanes.progress', {percent: lane.percent})"
							:aria-label="t('projectTimeline.lanes.progressName', {title: lane.item.title})"
						>
							<span
								class="lane-progress-fill"
								:style="{inlineSize: `${lane.percent}%`}"
							/>
						</span>
						<span
							class="lane-progress-text"
							aria-hidden="true"
						>{{ t('projectTimeline.lanes.progress', {percent: lane.percent}) }}</span>
						<span class="lane-fact">{{ t('projectTimeline.lanes.tasks', {done: lane.item.done_tasks ?? 0, total: lane.item.task_count ?? 0, year}) }}</span>
						<span
							v-if="lane.item.overdue_tasks"
							class="lane-fact is-overdue"
						>{{ t('projectTimeline.lanes.overdue', {n: lane.item.overdue_tasks}) }}</span>
					</div>
					<p class="lane-facts">
						<template v-if="lane.deadlinesOnly">
							<span class="lane-fact">{{ t('projectTimeline.lanes.deadlinesOnly', {year}) }}</span>
						</template>
						<template v-else>
							<span class="lane-fact">{{ lane.range }}</span>
							<span class="lane-fact">{{ lane.days }}</span>
							<span
								v-if="lane.item.deadline_only_tasks"
								class="lane-fact"
							>{{ t('projectTimeline.lanes.deadlineOnlyTasks', {n: lane.item.deadline_only_tasks}, lane.item.deadline_only_tasks) }}</span>
						</template>
						<span
							v-if="lane.item.overdue_since"
							class="lane-fact is-overdue"
						>{{ t('projectTimeline.lanes.overdueSince', {date: formatDay(lane.item.overdue_since)}) }}</span>
						<span
							v-else-if="lane.item.next_deadline"
							class="lane-fact"
						>{{ t('projectTimeline.lanes.nextDeadline', {date: formatDay(lane.item.next_deadline)}) }}</span>
					</p>
				</div>
				<div
					class="lane-track"
					aria-hidden="true"
				>
					<span
						v-for="tick in ticks"
						:key="tick.date"
						class="lane-gridline"
						:style="{insetInlineStart: `${tick.left}%`}"
					/>
					<span
						v-for="box in lane.scheduled"
						:key="`s-${box.start}`"
						class="lane-span is-scheduled"
						:style="{insetInlineStart: `${box.left}%`, inlineSize: `${box.width}%`}"
						:title="box.title"
					/>
					<span
						v-for="box in lane.elapsed"
						:key="`e-${box.start}`"
						class="lane-span is-elapsed"
						:style="{insetInlineStart: `${box.left}%`, inlineSize: `${box.width}%`}"
					/>
					<span
						v-for="box in lane.planned"
						:key="`p-${box.start}`"
						class="lane-span is-planned"
						:style="{insetInlineStart: `${box.left}%`, inlineSize: `${box.width}%`}"
					/>
					<i
						v-for="node in lane.deadlines"
						:key="node.date"
						class="lane-deadline"
						:class="`is-${node.state}`"
						:style="{insetInlineStart: `${node.left}%`}"
						:title="node.title"
					/>
					<i
						v-if="todayAt !== null"
						class="lane-today"
						:style="{insetInlineStart: `${todayAt}%`}"
					/>
					<i
						v-if="selectedAt !== null"
						class="lane-selected"
						:style="{insetInlineStart: `${selectedAt}%`}"
					/>
					<span
						v-if="lane.outside && outsideLabel"
						class="lane-outside"
					>{{ outsideLabel }}</span>
				</div>
			</li>
		</ol>
	</div>
</template>

<style scoped lang="scss">
.timeline-lanes {
	--lane-meta: 19rem;
	--lane-gap: var(--space-4);
	--lane-track-height: 1.25rem;

	container-type: inline-size;
}

.lanes-legend {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-4);
	margin: 0 0 var(--space-2);
	padding: 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
	list-style: none;

	li {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}
}

.legend-mark {
	--lane-color: var(--primary);
	--lane-ink: color-mix(in srgb, var(--lane-color) 72%, var(--text-primary));

	position: relative;
	display: inline-block;
	inline-size: 1rem;
	block-size: .625rem;
	border-radius: var(--radius-xs);

	&.is-elapsed {
		background: var(--lane-color);
		box-shadow: inset 0 0 0 1px var(--lane-ink);
	}

	&.is-planned {
		background:
			repeating-linear-gradient(135deg, color-mix(in srgb, var(--lane-ink) 45%, transparent) 0 2px, transparent 2px 6px),
			color-mix(in srgb, var(--lane-color) 22%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lane-ink) 55%, transparent);
	}

	&.is-unelapsed {
		background: color-mix(in srgb, var(--lane-color) 22%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lane-ink) 55%, transparent);
	}

	&.is-deadline {
		inline-size: .5rem;
		block-size: .5rem;
		margin-inline: .125rem;
		border: 1.5px solid var(--text-primary);
		border-radius: 0;
		background: var(--text-primary);
		transform: rotate(45deg);

		&.is-done {
			border-color: var(--success);
			background: var(--surface);
		}

		&.is-overdue {
			border-color: var(--danger-text);
			background: var(--danger-text);
		}
	}

	&.is-today {
		inline-size: 2px;
		block-size: .875rem;
		border-radius: 0;
		background: var(--text-primary);
	}

	&.is-progress {
		inline-size: 1.25rem;
		block-size: .375rem;
		border-radius: var(--radius-full);
		background: linear-gradient(to right, var(--success) 60%, var(--surface-sunken) 60%);
		box-shadow: inset 0 0 0 1px var(--border-subtle);

		&:dir(rtl) {
			background: linear-gradient(to left, var(--success) 60%, var(--surface-sunken) 60%);
		}
	}
}

.lanes-axis,
.lane {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-2) var(--lane-gap);

	@container (min-width: 46rem) {
		grid-template-columns: var(--lane-meta) minmax(0, 1fr);
		align-items: center;
	}
}

.lanes-axis {
	position: sticky;
	inset-block-start: calc(var(--header-height) + env(safe-area-inset-top, 0px));
	z-index: var(--layer-sticky);
	padding-block: var(--space-1);
	border-block-end: 1px solid var(--border-subtle);
	background: var(--surface);
}

.lanes-axis-spacer {
	display: none;

	@container (min-width: 46rem) {
		display: block;
	}
}

.lanes-axis-track {
	position: relative;
	block-size: 1rem;
	overflow: hidden;
}

.lanes-axis-tick {
	position: absolute;
	inset-block-start: 0;
	padding-inline-start: 3px;
	border-inline-start: 1px solid var(--border-default);
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
	line-height: 1rem;
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}

.lanes-list {
	margin: 0;
	padding: 0;
	list-style: none;
}

.lane {
	--lane-color: var(--primary);
	--lane-ink: color-mix(in srgb, var(--lane-color) 72%, var(--text-primary));

	padding-block: var(--space-3);
	border-block-end: 1px solid var(--border-subtle);

	&:last-child {
		border-block-end: 0;
	}

	&.is-outside .lane-meta {
		opacity: .7;
	}
}

.lane-meta {
	display: grid;
	gap: var(--space-1);
	min-inline-size: 0;
}

.lane-title-row {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
}

.lane-swatch {
	flex: none;
	inline-size: .625rem;
	block-size: .625rem;
	border-radius: var(--radius-xs);
	background: var(--lane-color);
	box-shadow: inset 0 0 0 1px var(--lane-ink);
}

.lane-title {
	flex: 0 1 auto;
	min-inline-size: 0;
	overflow: hidden;
	color: var(--text-primary);
	font-weight: var(--weight-semibold);
	text-overflow: ellipsis;
	white-space: nowrap;

	&:hover {
		color: var(--accent-text);
		text-decoration: underline;
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 2px;
		border-radius: var(--radius-xs);
	}
}

.lane-focus {
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	inline-size: 1.75rem;
	block-size: 1.75rem;
	margin-inline-start: auto;
	padding: 0;
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-tertiary);
	cursor: pointer;
	transition: background-color var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: 1px;
	}

	@media (pointer: coarse) {
		inline-size: var(--target-min);
		block-size: var(--target-min);
		margin-block: calc((1.75rem - var(--target-min)) / 2);
	}
}

.lane-focus-icon {
	font-size: var(--text-xs);
}

.lane-progress,
.lane-facts {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}

.lane-facts {
	color: var(--text-tertiary);
}

// Progress is the share of task work done; it is drawn apart from the calendar track on purpose.
.lane-progress-bar {
	position: relative;
	flex: 0 0 4.5rem;
	block-size: .375rem;
	overflow: hidden;
	border-radius: var(--radius-full);
	background: var(--surface-sunken);
	box-shadow: inset 0 0 0 1px var(--border-subtle);
}

.lane-progress-fill {
	position: absolute;
	inset-block: 0;
	inset-inline-start: 0;
	border-radius: inherit;
	background: var(--success);
}

.lane-progress-text {
	color: var(--text-primary);
	font-weight: var(--weight-medium);
}

.lane-fact.is-overdue {
	color: var(--danger-text);
	font-weight: var(--weight-medium);
}

.lane-track {
	position: relative;
	block-size: var(--lane-track-height);
	border-radius: var(--radius-xs);
	background: var(--surface-sunken);
}

.lane-gridline {
	position: absolute;
	inset-block: 0;
	inline-size: 1px;
	background: var(--border-subtle);
}

.lane-span {
	position: absolute;
	inset-block: 0;
	min-inline-size: 3px;
	border-radius: var(--radius-xs);

	&.is-scheduled {
		background: color-mix(in srgb, var(--lane-color) 22%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lane-ink) 55%, transparent);
	}

	&.is-elapsed {
		inset-block: 3px;
		background: var(--lane-color);
		box-shadow: inset 0 0 0 1px var(--lane-ink);
		pointer-events: none;
	}

	&.is-planned {
		background: repeating-linear-gradient(
			135deg,
			color-mix(in srgb, var(--lane-ink) 45%, transparent) 0 2px,
			transparent 2px 6px
		);
		pointer-events: none;
	}
}

// Open: solid. Overdue: solid red. All done: hollow, in the success colour.
.lane-deadline {
	position: absolute;
	inset-block-start: 50%;
	z-index: 1;
	inline-size: .5625rem;
	block-size: .5625rem;
	border: 1.5px solid var(--surface);
	background: var(--text-primary);
	box-shadow: 0 0 0 1px var(--text-primary);
	transform: translate(-50%, -50%) rotate(45deg);

	&:dir(rtl) {
		transform: translate(50%, -50%) rotate(45deg);
	}

	&.is-overdue {
		background: var(--danger-text);
		box-shadow: 0 0 0 1px var(--danger-text);
	}

	&.is-done {
		border-color: var(--success);
		background: var(--surface);
		box-shadow: none;
	}
}

.lane-today,
.lane-selected {
	position: absolute;
	inset-block: -3px;
	inline-size: 2px;
	margin-inline-start: -1px;
	pointer-events: none;
}

.lane-today {
	background: var(--text-primary);
}

.lane-selected {
	inline-size: 0;
	border-inline-start: 2px dashed var(--focus-ring-color);
}

.lane-outside {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	padding-inline: var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-2xs);
}
</style>
