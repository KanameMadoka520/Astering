<script setup lang="ts">
import {computed, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import RoutineTimezonePicker from './RoutineTimezonePicker.vue'
import type {RoutinePeriod, TaskRoutineSchedule} from '@/helpers/taskRoutine'

const props = defineProps<{
	modelValue: TaskRoutineSchedule
	saving: boolean
}>()
const emit = defineEmits<{'update:modelValue': [schedule: TaskRoutineSchedule]}>()
const {t, locale} = useI18n({useScope: 'global'})
const hintId = useId()
const resetTime = computed(() => [props.modelValue.reset_hour, props.modelValue.reset_minute]
	.map(value => String(value).padStart(2, '0')).join(':'))
const weekdays = computed(() => Array.from({length: 7}, (_, day) => ({
	day,
	name: new Intl.DateTimeFormat(locale.value, {
		weekday: 'long',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(2024, 0, 7 + day))),
})))

function update(patch: Partial<TaskRoutineSchedule>) {
	if (props.saving) return
	emit('update:modelValue', {...props.modelValue, ...patch})
}
function value(event: Event) {
	return (event.target as HTMLInputElement).value
}
function changeTime(event: Event) {
	const [hour, minute] = value(event).split(':').map(Number)
	update({reset_hour: hour, reset_minute: minute})
}
</script>

<template>
	<div class="routine-schedule-editor">
		<label class="routine-schedule-field">
			<span>{{ t('routineSchedule.period') }}</span>
			<span class="select is-fullwidth">
				<select
					:value="modelValue.period"
					:aria-label="t('routineSchedule.period')"
					:aria-disabled="saving"
					@change="update({period: value($event) as RoutinePeriod})"
				>
					<option
						v-for="period in ['daily', 'weekly', 'monthly']"
						:key="period"
						:value="period"
					>
						{{ t(`routineSchedule.${period}`) }}
					</option>
				</select>
			</span>
		</label>
		<label
			v-if="modelValue.period === 'weekly'"
			class="routine-schedule-field"
		>
			<span>{{ t('routineSchedule.weekStart') }}</span>
			<span class="select is-fullwidth">
				<select
					:value="modelValue.week_start"
					:aria-label="t('routineSchedule.weekStart')"
					:aria-disabled="saving"
					@change="update({week_start: Number(value($event))})"
				>
					<option
						v-for="weekday in weekdays"
						:key="weekday.day"
						:value="weekday.day"
					>{{ weekday.name }}</option>
				</select>
			</span>
		</label>
		<label
			v-if="modelValue.period === 'monthly'"
			class="routine-schedule-field"
		>
			<span>{{ t('routineSchedule.monthDay') }}</span>
			<input
				:value="modelValue.month_day"
				:aria-label="t('routineSchedule.monthDay')"
				:aria-describedby="`${hintId}-month`"
				type="number"
				class="input"
				min="1"
				max="31"
				step="1"
				:readonly="saving"
				@input="update({month_day: Number(value($event))})"
			>
			<small :id="`${hintId}-month`">{{ t('routineSchedule.monthDayHint') }}</small>
		</label>
		<label class="routine-schedule-field">
			<span>{{ t('routineSchedule.resetTime') }}</span>
			<input
				:value="resetTime"
				:aria-label="t('routineSchedule.resetTime')"
				:aria-describedby="`${hintId}-time`"
				type="time"
				class="input"
				:readonly="saving"
				required
				@input="changeTime"
			>
			<small :id="`${hintId}-time`">{{ t('routineSchedule.resetHint') }}</small>
		</label>
		<div class="routine-schedule-editor__zone">
			<RoutineTimezonePicker
				:model-value="modelValue.timezone"
				:disabled="saving"
				:hint="t('routineSchedule.timezoneHint')"
				@update:modelValue="update({timezone: $event || modelValue.timezone})"
			/>
		</div>
		<label class="routine-schedule-field">
			<span>{{ t('routineSchedule.target') }}</span>
			<input
				:value="modelValue.target"
				:aria-label="t('routineSchedule.target')"
				:aria-describedby="`${hintId}-target`"
				type="number"
				class="input"
				min="1"
				:max="Number.MAX_SAFE_INTEGER"
				step="1"
				:readonly="saving"
				@input="update({target: Number(value($event))})"
			>
			<small :id="`${hintId}-target`">{{ t('routineSchedule.targetHint') }}</small>
		</label>
		<label class="routine-schedule-field">
			<span>{{ t('routineSchedule.unit') }}</span>
			<input
				:value="modelValue.unit"
				type="text"
				class="input"
				maxlength="40"
				:readonly="saving"
				:placeholder="t('routineSchedule.unitPlaceholder')"
				@input="update({unit: value($event)})"
			>
		</label>
	</div>
</template>

<style lang="scss" scoped>
.routine-schedule-editor {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-4);
	min-inline-size: 0;

	@media (width <= 480px) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.routine-schedule-field {
	display: grid;
	align-content: start;
	gap: var(--space-2);
	min-inline-size: 0;

	> span:first-child {
		font-weight: var(--weight-medium);
	}

	small {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}
}

.routine-schedule-editor__zone {
	grid-column: 1 / -1;
	min-inline-size: 0;
}
</style>
