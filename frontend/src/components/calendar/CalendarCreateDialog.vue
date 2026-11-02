<template>
	<Modal
		:aria-label="t('calendar.create.title')"
		:loading="saving"
		@close="close"
	>
		<form
			class="calendar-create"
			@submit.prevent="save"
		>
			<header>
				<h2>{{ t('calendar.create.title') }}</h2>
				<XButton
					type="button"
					variant="tertiary"
					icon="times"
					:aria-label="t('misc.close')"
					@click="close"
				/>
			</header>
			<p class="calendar-create__hint">
				{{ t('calendar.create.timezoneHint', {timezone}) }}
			</p>
			<p
				v-if="projectStore.isLoading"
				role="status"
			>
				{{ t('misc.loading') }}
			</p>
			<LoadError
				v-else-if="projectStore.isError"
				:retry="projectStore.refetch"
			/>
			<p
				v-else-if="!projects.length"
				role="status"
			>
				{{ t('calendar.create.noWritableProject') }}
				<RouterLink :to="{name: 'project.create'}">
					{{ t('project.create.header') }}
				</RouterLink>
			</p>
			<template v-else>
				<label>
					{{ t('task.attributes.title') }}
					<input
						v-model="title"
						class="input"
						required
						autofocus
						maxlength="250"
						:readonly="saving"
						:placeholder="t('calendar.create.titlePlaceholder')"
					>
				</label>
				<label>
					{{ t('calendar.create.project') }}
					<select
						class="input"
						:value="selectedProjectId"
						:aria-disabled="saving"
						@change="selectProject"
					>
						<option
							v-for="project in projects"
							:key="project.id"
							:value="project.id"
						>{{ project.title }}</option>
					</select>
				</label>
				<section class="calendar-create__time-section">
					<label class="calendar-create__all-day">
						<span>{{ t('calendar.allDay') }}</span>
						<input
							:checked="allDay"
							type="checkbox"
							role="switch"
							:aria-disabled="saving || undefined"
							@change="toggleAllDay"
						>
					</label>
					<div
						v-if="allDay"
						class="calendar-create__dates"
					>
						<label>
							{{ t('calendar.create.firstDay') }}
							<input
								v-model="allDayDates.start"
								:aria-label="t('calendar.create.firstDay')"
								class="input"
								type="date"
								required
								min="1970-01-01"
								max="9998-12-30"
								:readonly="saving"
							>
						</label>
						<label>
							{{ t('calendar.create.lastDay') }}
							<input
								v-model="allDayDates.end"
								:aria-label="t('calendar.create.lastDay')"
								class="input"
								type="date"
								required
								:min="allDayDates.start"
								max="9998-12-30"
								:readonly="saving"
							>
						</label>
					</div>
					<div
						v-else
						class="calendar-create__dates"
					>
						<label
							v-for="field in ['start', 'end'] as const"
							:key="field"
						>
							{{ t(`calendar.create.${field}`) }}
							<input
								v-model="dates[field]"
								:aria-label="t(`calendar.create.${field}`)"
								class="input"
								type="datetime-local"
								required
								:readonly="saving"
								min="1970-01-01T00:00"
								max="9998-12-31T23:59"
							>
							<template v-if="resolutions[field].kind === 'ambiguous'">
								<span class="calendar-create__hint">{{ t('calendar.create.ambiguousTime') }}</span>
								<select
									v-model="choices[field]"
									class="input"
									:aria-label="t('calendar.create.chooseOffset')"
									required
								>
									<option value="">{{ t('calendar.create.chooseOffset') }}</option>
									<option
										v-for="candidate in candidates(field)"
										:key="candidate"
										:value="candidate"
									>{{ offsetLabel(candidate) }}</option>
								</select>
							</template>
						</label>
					</div>
					<p
						v-if="allDay"
						class="calendar-create__hint"
					>
						{{ t('calendar.create.allDayHint') }}
					</p>
				</section>
				<details class="calendar-create__section">
					<summary>{{ t('calendar.create.additional') }}</summary>
					<label>
						{{ t('calendar.create.due') }}
						<input
							v-model="dates.due"
							:aria-label="t('calendar.create.due')"
							class="input"
							type="datetime-local"
							:readonly="saving"
							min="1970-01-01T00:00"
							max="9998-12-31T23:59"
						>
						<template v-if="resolutions.due.kind === 'ambiguous'">
							<span class="calendar-create__hint">{{ t('calendar.create.ambiguousTime') }}</span>
							<select
								v-model="choices.due"
								class="input"
								:aria-label="t('calendar.create.chooseOffset')"
								required
							>
								<option value="">{{ t('calendar.create.chooseOffset') }}</option>
								<option
									v-for="candidate in candidates('due')"
									:key="candidate"
									:value="candidate"
								>{{ offsetLabel(candidate) }}</option>
							</select>
						</template>
					</label>
					<label>
						{{ t('task.attributes.priority') }}
						<PrioritySelect
							v-model="priority"
							:disabled="saving"
						/>
					</label>
				</details>
				<details class="calendar-create__section">
					<summary>{{ t('calendar.create.notes') }}</summary>
					<label>
						<span class="is-sr-only">{{ t('calendar.create.notes') }}</span>
						<textarea
							v-model="notes"
							class="textarea"
							rows="3"
							:aria-label="t('calendar.create.notes')"
							:placeholder="t('calendar.create.notesPlaceholder')"
							:readonly="saving"
						/>
					</label>
					<p class="calendar-create__hint">
						{{ t('calendar.create.notesHint') }}
					</p>
				</details>
				<details class="calendar-create__section">
					<summary>
						{{ t('task.attributes.reminders') }} <span
							v-if="reminders.length"
							class="calendar-create__optional"
						>{{ reminders.length }}</span>
					</summary>
					<p class="calendar-create__hint">
						{{ t(allDay ? 'calendar.create.allDayReminderHint' : 'calendar.create.reminderHint') }}
					</p>
					<Reminders
						v-if="reminderAnchor"
						v-model="relativeReminders"
						:default-relative-to="reminderAnchor"
						:disabled="saving"
						:allow-absolute="false"
					/>
					<ul
						v-else-if="relativeReminders.length"
						class="calendar-create__reminders"
					>
						<li
							v-for="(reminder, index) in relativeReminders"
							:key="index"
						>
							<span>{{ t('calendar.create.reminderNeedsAnchor') }}</span>
							<button
								type="button"
								:aria-label="t('task.removeReminder')"
								:aria-disabled="saving"
								@click="removeRelative(reminder)"
							>
								<Icon icon="times" />
							</button>
						</li>
					</ul>
					<ul
						v-if="absoluteReminders.length"
						class="calendar-create__reminders"
					>
						<li
							v-for="(reminder, index) in absoluteReminders"
							:key="index"
						>
							<span>{{ absoluteLabel(reminder.reminder!) }}</span>
							<button
								type="button"
								:aria-label="t('task.removeReminder')"
								:aria-disabled="saving"
								@click="removeAbsolute(index)"
							>
								<Icon icon="times" />
							</button>
						</li>
					</ul>
					<label>
						{{ t('calendar.create.absoluteReminder') }}
						<input
							v-model="absoluteReminder"
							:aria-label="t('calendar.create.absoluteReminder')"
							type="datetime-local"
							class="input"
							:readonly="saving"
							min="1970-01-01T00:00"
							max="9998-12-31T23:59"
						>
						<select
							v-if="absoluteResolution.kind === 'ambiguous'"
							v-model="absoluteChoice"
							class="input"
							:aria-label="t('calendar.create.chooseOffset')"
						>
							<option value="">{{ t('calendar.create.chooseOffset') }}</option>
							<option
								v-for="candidate in absoluteResolution.instants"
								:key="candidate"
								:value="candidate"
							>{{ offsetLabel(candidate) }}</option>
						</select>
					</label>
					<button
						type="button"
						class="calendar-create__clear-repeat"
						:aria-disabled="saving || !absoluteReminder"
						@click="addAbsoluteReminder"
					>
						{{ t('task.addReminder') }}
					</button>
				</details>
				<details class="calendar-create__section">
					<summary>{{ t('task.attributes.repeat') }}</summary>
					<p class="calendar-create__hint">
						{{ t('calendar.create.repeatHint') }}
					</p>
					<RepeatAfter
						v-model="repeat"
						:disabled="saving"
					/>
					<button
						v-if="repeat?.repeat_after || repeat?.repeat_mode"
						type="button"
						class="calendar-create__clear-repeat"
						:aria-disabled="saving"
						@click="clearRepeat"
					>
						{{ t('calendar.create.removeRepeat') }}
					</button>
				</details>
				<p
					v-if="validation"
					role="alert"
					class="help is-danger"
				>
					{{ validation }}
				</p>
				<p class="calendar-create__hint">
					{{ t('calendar.create.moreHint') }}
				</p>
			</template>
			<footer>
				<XButton
					type="button"
					variant="secondary"
					:shadow="false"
					@click="close"
				>
					{{ t('calendar.create.close') }}
				</XButton>
				<XButton
					v-if="projects.length"
					type="submit"
					icon="plus"
					:loading="saving"
					:aria-disabled="saving"
				>
					{{ t('calendar.create.save') }}
				</XButton>
			</footer>
		</form>
	</Modal>
	<UnsavedLeaveDialog
		:open="discarding || leaveTarget !== null"
		@stay="discarding = false; stay()"
		@discard="discard"
	/>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, reactive, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import Modal from '@/components/misc/Modal.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import XButton from '@/components/input/Button.vue'
import PrioritySelect from '@/components/tasks/partials/PrioritySelect.vue'
import Reminders from '@/components/tasks/partials/Reminders.vue'
import RepeatAfter from '@/components/tasks/partials/RepeatAfter.vue'
import UnsavedLeaveDialog from '@/components/misc/UnsavedLeaveDialog.vue'
import {useProjects} from '@/composables/useProjects'
import {useUnsavedLeaveGuard} from '@/composables/useUnsavedLeaveGuard'
import {useCreateTaskMutation} from '@/client/queries/taskMutations'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {PERMISSIONS} from '@/constants/permissions'
import {addCalendarDays, parseCalendarDate, resolveCalendarWallTime} from '@/helpers/calendar'
import {createTaskDraft} from '@/helpers/task'
import type {Task, TaskReminder} from '@/client/generated'
import {REMINDER_PERIOD_RELATIVE_TO_TYPES} from '@/types/IReminderPeriodRelativeTo'

const props = defineProps<{
	date: string
	timezone: string
	projectId?: number
	initialStart?: string
	initialEnd?: string
	initialAllDay?: boolean
}>()
const emit = defineEmits<{
	close: []
	created: [taskID: number]
}>()
const {t, locale} = useI18n({useScope: 'global'})
const projectStore = useProjects()
const projects = computed(() => projectStore.projectsArray.filter(project =>
	project.id > 0 && !project.is_archived && (project.max_permission ?? PERMISSIONS.READ) >= PERMISSIONS.READ_WRITE,
))
const title = ref('')
const notes = ref('')
// Each mounted dialog owns one draft; later parent changes must not overwrite it.
const initialProject = () => props.projectId ?? 0
const selectedProjectId = ref(initialProject())
const baselineProject = ref<number | null>(null)
watch(projects, available => {
	if (!available.some(project => project.id === selectedProjectId.value)) selectedProjectId.value = available[0]?.id ?? 0
	if (baselineProject.value === null && selectedProjectId.value > 0) baselineProject.value = selectedProjectId.value
}, {immediate: true})
const dateFields = ['start', 'end', 'due'] as const
type DateField = typeof dateFields[number]
const initialDates = () => ({
	start: props.initialStart || `${props.date}T09:00`,
	end: props.initialEnd || `${props.date}T10:00`,
	due: '',
})
const initial = initialDates()
const dates = reactive({...initial})
const initialAllDay = () => props.initialAllDay === true
const initialAllDayValue = initialAllDay()
const allDay = ref(initialAllDayValue)
const initialAllDayDates = () => ({start: props.date, end: props.date})
const allDayInitial = initialAllDayDates()
const allDayDates = reactive({...allDayInitial})
const repeat = ref<Task | undefined>(createTaskDraft())
const reminders = ref<TaskReminder[]>([])
const absoluteReminder = ref('')
const absoluteChoice = ref('')
const absoluteResolution = computed(() => resolveCalendarWallTime(absoluteReminder.value, props.timezone))
const absoluteReminders = computed(() => reminders.value.filter(reminder => !reminder.relative_to))
const relativeReminders = computed({
	get: () => reminders.value.filter(reminder => Boolean(reminder.relative_to)),
	set: (value: TaskReminder[]) => { reminders.value = [...value, ...absoluteReminders.value] },
})
const priority = ref(0)
const reminderAnchor = computed(() => allDay.value
	? (dates.due ? REMINDER_PERIOD_RELATIVE_TO_TYPES.DUEDATE : null)
	: REMINDER_PERIOD_RELATIVE_TO_TYPES.STARTDATE)
const choices = reactive({start: '', end: '', due: ''})
const resolutions = computed(() => ({
	start: resolveCalendarWallTime(dates.start, props.timezone),
	end: resolveCalendarWallTime(dates.end, props.timezone),
	due: resolveCalendarWallTime(dates.due, props.timezone),
}))
const saving = ref(false)
const validation = ref('')
const completed = ref(false)
const discarding = ref(false)
const dirty = computed(() => !completed.value && (
	title.value !== ''
	|| notes.value !== ''
	|| dateFields.some(field => dates[field] !== initial[field])
	|| allDay.value !== initialAllDayValue
	|| allDayDates.start !== allDayInitial.start
	|| allDayDates.end !== allDayInitial.end
	|| reminders.value.length > 0
	|| absoluteReminder.value !== ''
	|| Boolean(repeat.value?.repeat_after || repeat.value?.repeat_mode)
	|| priority.value !== 0
	|| (baselineProject.value !== null && selectedProjectId.value !== baselineProject.value)
))
const {leaveTarget, stay, discardAndLeave} = useUnsavedLeaveGuard(dirty)
const owner = captureClientRequestContext()
const createTask = useCreateTaskMutation(owner)
let mounted = true
onBeforeUnmount(() => { mounted = false })

function candidates(field: DateField) {
	const result = resolutions.value[field]
	return result.kind === 'ambiguous' ? result.instants : []
}

function offsetLabel(instant: string) {
	return new Intl.DateTimeFormat(locale.value, {
		timeZone: props.timezone,
		hour: '2-digit',
		minute: '2-digit',
		timeZoneName: 'shortOffset',
	}).format(new Date(instant))
}

function instant(field: DateField): string | undefined {
	if (!dates[field] && field === 'due') return undefined
	const result = resolutions.value[field]
	if (result.kind === 'valid') return result.instant
	if (result.kind === 'ambiguous' && result.instants.includes(choices[field])) return choices[field]
	validation.value = t(result.kind === 'ambiguous' ? 'calendar.create.ambiguousTime' : 'calendar.create.invalidTime')
	return undefined
}

function selectProject(event: Event) {
	const element = event.target as HTMLSelectElement
	if (!saving.value) selectedProjectId.value = Number(element.value)
	element.value = String(selectedProjectId.value)
}

function toggleAllDay(event: Event) {
	const element = event.target as HTMLInputElement
	if (!saving.value) allDay.value = element.checked
	element.checked = allDay.value
}

function descriptionFromNotes() {
	const holder = document.createElement('div')
	for (const line of notes.value.trim().split(/\r?\n/)) {
		const paragraph = document.createElement('p')
		paragraph.textContent = line
		if (!line) paragraph.append(document.createElement('br'))
		holder.append(paragraph)
	}
	return holder.innerHTML
}

function clearRepeat() {
	if (!saving.value) repeat.value = createTaskDraft()
}

function absoluteLabel(value: string) {
	return new Intl.DateTimeFormat(locale.value, {
		timeZone: props.timezone,
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(value))
}

function removeAbsolute(index: number) {
	if (saving.value) return
	const target = absoluteReminders.value[index]
	reminders.value = reminders.value.filter(reminder => reminder !== target)
}

function removeRelative(target: TaskReminder) {
	if (!saving.value) reminders.value = reminders.value.filter(reminder => reminder !== target)
}

function addAbsoluteReminder() {
	if (saving.value || !absoluteReminder.value) return
	const resolution = absoluteResolution.value
	const instant = resolution.kind === 'valid'
		? resolution.instant
		: resolution.kind === 'ambiguous' && resolution.instants.includes(absoluteChoice.value)
			? absoluteChoice.value
			: ''
	if (!instant) {
		validation.value = t(resolution.kind === 'ambiguous' ? 'calendar.create.ambiguousTime' : 'calendar.create.invalidTime')
		return
	}
	if (!reminders.value.some(reminder => reminder.reminder === instant && !reminder.relative_to)) {
		reminders.value = [...reminders.value, {reminder: instant, relative_to: '', relative_period: 0}]
	}
	absoluteReminder.value = ''
	absoluteChoice.value = ''
	validation.value = ''
}

function close() {
	if (saving.value) return
	if (dirty.value) discarding.value = true
	else emit('close')
}

async function discard() {
	if (saving.value) return
	if (leaveTarget.value !== null) await discardAndLeave()
	if (mounted && isClientRequestContextCurrent(owner)) emit('close')
}

async function save() {
	if (!isClientRequestContextCurrent(owner)) {
		emit('close')
		return
	}
	if (saving.value || !title.value.trim() || !projects.value.some(project => project.id === selectedProjectId.value)) return
	validation.value = ''
	if (absoluteReminder.value) addAbsoluteReminder()
	if (validation.value) return
	const start = allDay.value ? undefined : instant('start')
	const end = allDay.value ? undefined : instant('end')
	const due = instant('due')
	if (validation.value || (!allDay.value && (!start || !end))) return
	if (allDay.value && (!parseCalendarDate(allDayDates.start) || !parseCalendarDate(allDayDates.end))) {
		validation.value = t('calendar.create.invalidTime')
		return
	}
	if (allDay.value ? allDayDates.end < allDayDates.start : Date.parse(end!) <= Date.parse(start!)) {
		validation.value = t('calendar.create.invalidRange')
		return
	}
	if (allDay.value && repeat.value?.repeat_mode !== 1 && (repeat.value?.repeat_after ?? 0) % 86400 !== 0) {
		validation.value = t('calendar.create.allDayRepeatHint')
		return
	}
	if (allDay.value && reminders.value.some(reminder => reminder.relative_to === 'start_date' || reminder.relative_to === 'end_date')) {
		validation.value = t('calendar.create.allDayReminderHint')
		return
	}
	if (!due && reminders.value.some(reminder => reminder.relative_to === 'due_date')) {
		validation.value = t('calendar.create.reminderNeedsDue')
		return
	}
	saving.value = true
	try {
		const task = await createTask.mutateAsync({
			title: title.value.trim(),
			...(notes.value.trim() ? {description: descriptionFromNotes()} : {}),
			project_id: selectedProjectId.value,
			...(allDay.value ? {
				all_day: true,
				all_day_start: allDayDates.start,
				all_day_end: addCalendarDays(allDayDates.end, 1),
			} : {start_date: start, end_date: end}),
			...(due ? {due_date: due} : {}),
			...(priority.value ? {priority: priority.value} : {}),
			...(repeat.value?.repeat_after || repeat.value?.repeat_mode ? {
				repeat_after: repeat.value.repeat_after ?? 0,
				repeat_mode: repeat.value.repeat_mode ?? 0,
			} : {}),
			...(reminders.value.length ? {reminders: reminders.value} : {}),
		})
		if (!mounted || !isClientRequestContextCurrent(owner)) return
		completed.value = true
		if (task.id) emit('created', task.id)
	} catch {
		// The shared mutation reports errors and preserves the form for retry.
	} finally {
		saving.value = false
	}
}
</script>

<style scoped lang="scss">
.calendar-create {
	inline-size: min(38rem, calc(100vw - 2rem));
	max-inline-size: 100%;
	padding: var(--space-5);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	color: var(--text-primary);
	text-align: start;

	header, footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	h2 {
		margin: 0;
		font-size: var(--text-xl);
	}

	label {
		display: grid;
		gap: var(--space-2);
		min-inline-size: 0;
		margin-block: var(--space-4);
		font-weight: var(--weight-medium);
	}

	.input {
		min-inline-size: 0;
		inline-size: 100%;
		min-block-size: 2.75rem;
	}

	footer {
		justify-content: flex-end;
		margin-block-start: var(--space-5);
		flex-wrap: wrap;
	}

	&__hint, &__optional {
		color: var(--text-secondary);
		font-size: var(--text-sm);
		font-weight: normal;
	}

	&__dates {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 var(--space-4);
	}

	&__time-section {
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		background: var(--surface-sunken);
	}

	&__all-day {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-block-size: var(--target-min);
		margin: 0;
		padding-block-end: var(--space-2);
		border-block-end: 1px solid var(--border-subtle);

		input {
			inline-size: 1.25rem;
			block-size: 1.25rem;
			accent-color: var(--primary);
		}
	}

	&__section {
		padding: var(--space-3) 0;
		border-block-end: 1px solid var(--border-subtle);

		summary {
			min-block-size: var(--target-min);
			padding-block: var(--space-3);
			font-weight: var(--weight-medium);
			cursor: pointer;
		}
	}

	&__clear-repeat {
		min-block-size: var(--target-min);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface);
		color: var(--accent-text);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;

		&:focus-visible { outline: 2px solid var(--focus-ring-color); }
	}

	&__reminders {
		display: grid;
		gap: var(--space-2);
		padding: 0;
		list-style: none;

		li {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: var(--space-2);
			font-size: var(--text-sm);
		}

		button {
			flex-shrink: 0;
			inline-size: var(--target-min);
			block-size: var(--target-min);
			border: 0;
			border-radius: var(--radius-full);
			background: var(--surface-sunken);
			color: var(--text-secondary);
			cursor: pointer;
		}
	}

	@media (width <= 480px) {
		padding: var(--space-4);
		&__dates { grid-template-columns: 1fr; }
		footer {
			flex-direction: column-reverse;
			align-items: stretch;
		}
	}
}
</style>
