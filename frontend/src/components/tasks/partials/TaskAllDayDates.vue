<script setup lang="ts">
import {computed, onBeforeUnmount, reactive, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Task} from '@/client/generated'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {addCalendarDays, calendarDateAt, calendarTimeLabel, parseCalendarDate, resolveCalendarWallTime} from '@/helpers/calendar'
import XButton from '@/components/input/Button.vue'

const props = defineProps<{
	task: Task
	canWrite: boolean
	timezone: string
	save: (changes: Partial<Task>, id: number) => Promise<'saved' | 'failed' | 'none'>
}>()
const emit = defineEmits<{'dirty': [id: number, dirty: boolean]}>()
const {t, locale} = useI18n({useScope: 'global'})
const owner = captureClientRequestContext()
const open = ref(false)
const saving = ref(false)
const validation = ref('')
const mode = ref<'all-day' | 'timed'>('all-day')
const dates = reactive({start: '', lastDay: '', timedStart: '', timedEnd: ''})
const choices = reactive({timedStart: '', timedEnd: ''})
let alive = true
let baseline = ''
const emptyTime = '0001-01-01T00:00:00Z'
const timezone = computed(() => props.timezone || 'UTC')
const formValue = () => JSON.stringify({mode: mode.value, ...dates, ...choices})
const dirty = computed(() => open.value && (saving.value || formValue() !== baseline))
watch(dirty, value => emit('dirty', props.task.id ?? 0, value))
onBeforeUnmount(() => {
	alive = false
	emit('dirty', props.task.id ?? 0, false)
})
const hasRelativeTimeReminders = computed(() => props.task.reminders?.some(reminder =>
	reminder.relative_to === 'start_date' || reminder.relative_to === 'end_date'))
const lastDay = computed(() => parseCalendarDate(props.task.all_day_end)
	? addCalendarDays(props.task.all_day_end!, -1) : '')
const resolutions = computed(() => ({
	timedStart: resolveCalendarWallTime(dates.timedStart, timezone.value),
	timedEnd: resolveCalendarWallTime(dates.timedEnd, timezone.value),
}))
watch(() => dates.timedStart, () => { choices.timedStart = '' })
watch(() => dates.timedEnd, () => { choices.timedEnd = '' })
watch(timezone, () => {
	choices.timedStart = ''
	choices.timedEnd = ''
})

function edit() {
	if (!props.canWrite || !isClientRequestContextCurrent(owner)) return
	mode.value = 'all-day'
	dates.start = props.task.all_day_start || calendarDateAt(props.task.start_date, timezone.value)
	dates.lastDay = props.task.all_day ? lastDay.value : calendarDateAt(props.task.end_date, timezone.value) || dates.start
	// Selecting a conversion does not invent a time the user has not chosen.
	dates.timedStart = ''
	dates.timedEnd = ''
	choices.timedStart = ''
	choices.timedEnd = ''
	validation.value = ''
	baseline = formValue()
	open.value = true
}
function close() {
	if (saving.value) return
	open.value = false
	validation.value = ''
}
function instant(field: 'timedStart' | 'timedEnd'): string | null {
	const resolution = resolutions.value[field]
	if (resolution.kind === 'valid') return resolution.instant
	if (resolution.kind === 'ambiguous' && resolution.instants.includes(choices[field])) return choices[field]
	validation.value = t(resolution.kind === 'ambiguous' ? 'calendar.create.ambiguousTime' : 'calendar.create.invalidTime')
	return null
}
async function persist(changes: Partial<Task>) {
	const id = props.task.id
	if (saving.value || !props.canWrite || !id || !isClientRequestContextCurrent(owner)) return
	saving.value = true
	validation.value = ''
	try {
		const outcome = await props.save(changes, id)
		if (!alive || props.task.id !== id || !isClientRequestContextCurrent(owner)) return
		if (outcome === 'saved') open.value = false
		else validation.value = t('task.allDay.saveFailed')
	} catch {
		if (alive && props.task.id === id && isClientRequestContextCurrent(owner)) validation.value = t('task.allDay.saveFailed')
	} finally {
		if (alive && props.task.id === id) saving.value = false
	}
}
async function submit() {
	if (mode.value === 'all-day') {
		if (!parseCalendarDate(dates.start) || !parseCalendarDate(dates.lastDay)
			|| dates.start < '1970-01-01' || dates.lastDay > '9998-12-30' || dates.lastDay < dates.start) {
			validation.value = t('task.allDay.invalidRange')
			return
		}
		await persist({all_day: true, all_day_start: dates.start, all_day_end: addCalendarDays(dates.lastDay, 1), start_date: emptyTime, end_date: emptyTime})
		return
	}
	if (!dates.timedStart || !dates.timedEnd) {
		validation.value = t('task.allDay.timedRequired')
		return
	}
	const start = instant('timedStart')
	if (!start) return
	const end = instant('timedEnd')
	if (!end) return
	if (end <= start) {
		validation.value = t('calendar.create.invalidRange')
		return
	}
	await persist({all_day: false, all_day_start: '', all_day_end: '', start_date: start, end_date: end})
}
function clearSchedule() {
	return persist({all_day: false, all_day_start: '', all_day_end: '', start_date: emptyTime, end_date: emptyTime})
}
</script>

<template>
	<section
		v-if="task.all_day || canWrite"
		class="task-all-day"
		:aria-label="t('task.allDay.title')"
	>
		<div class="task-all-day__summary">
			<div>
				<strong>{{ t('task.allDay.title') }}</strong>
				<p
					v-if="task.all_day"
					class="task-all-day__range"
				>
					{{ task.all_day_start }} — {{ lastDay }}
				</p>
			</div>
			<XButton
				v-if="canWrite && !open"
				variant="secondary"
				:shadow="false"
				@click="edit"
			>
				{{ t(task.all_day ? 'task.allDay.edit' : 'task.allDay.create') }}
			</XButton>
		</div>
		<p
			v-if="hasRelativeTimeReminders && ((task.all_day && !open) || (open && mode === 'all-day'))"
			class="task-all-day__hint"
			role="status"
		>
			{{ t('task.allDay.relativeRemindersPaused') }}
		</p>
		<form
			v-if="open"
			class="task-all-day__editor"
			:aria-busy="saving"
			@submit.prevent="submit"
		>
			<p class="task-all-day__hint">
				{{ t('task.allDay.civilHint') }}
			</p>
			<p
				v-if="hasRelativeTimeReminders && mode === 'timed'"
				class="task-all-day__hint"
				role="status"
			>
				{{ t('task.allDay.relativeRemindersResume') }}
			</p>
			<fieldset :disabled="saving || !canWrite">
				<div
					v-if="mode === 'all-day'"
					class="task-all-day__fields"
				>
					<label>{{ t('task.allDay.start') }}<input
						v-model="dates.start"
						type="date"
						class="input"
						min="1970-01-01"
						max="9998-12-30"
					></label>
					<label>{{ t('task.allDay.lastDay') }}<input
						v-model="dates.lastDay"
						type="date"
						class="input"
						min="1970-01-01"
						max="9998-12-30"
					></label>
				</div>
				<template v-else>
					<p class="task-all-day__hint">
						{{ t('calendar.create.timezoneHint', {timezone}) }}
					</p>
					<div class="task-all-day__fields">
						<label
							v-for="field in (['timedStart', 'timedEnd'] as const)"
							:key="field"
						>
							{{ t(field === 'timedStart' ? 'task.attributes.startDate' : 'task.attributes.endDate') }}
							<input
								v-model="dates[field]"
								type="datetime-local"
								class="input"
								min="1970-01-01T00:00"
								max="9998-12-31T23:59"
							>
							<select
								v-if="resolutions[field].kind === 'ambiguous'"
								v-model="choices[field]"
								class="input"
								:aria-label="t('calendar.create.chooseOffset')"
							>
								<option value="">{{ t('calendar.create.chooseOffset') }}</option>
								<option
									v-for="value in resolutions[field].kind === 'ambiguous' ? resolutions[field].instants : []"
									:key="value"
									:value="value"
								>{{ calendarTimeLabel(value, timezone, locale, false, true) }}</option>
							</select>
						</label>
					</div>
				</template>
				<p
					v-if="!task.all_day && mode === 'all-day'"
					class="task-all-day__hint"
				>
					{{ t('task.allDay.replaceHint') }}
				</p>
				<div class="task-all-day__actions">
					<XButton
						type="button"
						variant="secondary"
						:shadow="false"
						@click="mode = mode === 'all-day' ? 'timed' : 'all-day'"
					>
						{{ t(mode === 'all-day' ? 'task.allDay.toTimed' : 'task.allDay.toAllDay') }}
					</XButton>
					<XButton
						type="submit"
						:loading="saving"
					>
						{{ t('misc.save') }}
					</XButton>
					<XButton
						type="button"
						variant="tertiary"
						:shadow="false"
						@click="close"
					>
						{{ t('misc.cancel') }}
					</XButton>
				</div>
				<div
					v-if="task.all_day"
					class="task-all-day__clear"
				>
					<XButton
						type="button"
						variant="tertiary"
						:shadow="false"
						@click="clearSchedule"
					>
						{{ t('task.allDay.clear') }}
					</XButton>
					<small>{{ t('task.allDay.clearHint') }}</small>
					<small v-if="hasRelativeTimeReminders && mode === 'timed'">{{ t('task.allDay.relativeRemindersPaused') }}</small>
				</div>
			</fieldset>
			<p
				v-if="validation"
				class="help is-danger"
				role="alert"
			>
				{{ validation }}
			</p>
		</form>
	</section>
</template>

<style scoped lang="scss">
.task-all-day {
	padding: .85rem;
	margin-block-end: 1rem;
	border: 1px solid var(--grey-200);
	border-radius: .65rem;
	min-inline-size: 0;
}
.task-all-day__summary, .task-all-day__actions {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: .65rem;
	flex-wrap: wrap;
}
.task-all-day__range {
	margin-block-start: .3rem;
	font-variant-numeric: tabular-nums;
}
.task-all-day__hint {
	font-size: .85rem;
	color: var(--grey-600);
	margin-block: .7rem;
}
.task-all-day__fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: .75rem;
	label {
		display: grid;
		gap: .35rem;
		min-inline-size: 0;
	}
	input, select {
		min-inline-size: 0;
		inline-size: 100%;
	}
}
.task-all-day__actions {
	margin-block-start: .85rem;
	justify-content: flex-start;
}
.task-all-day__clear {
	margin-block-start: .75rem;
	display: grid;
	gap: .25rem;
	justify-items: start;
}
fieldset {
	padding: 0;
	border: 0;
	min-inline-size: 0;
}
@media (width <= 520px) {
	.task-all-day__fields {
	grid-template-columns: minmax(0, 1fr);
}
}
</style>
