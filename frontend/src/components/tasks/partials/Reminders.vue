<template>
	<div class="reminders">
		<div
			v-for="(r, index) in reminders"
			:key="index"
			:data-is-overdue="isOverdue(r) || undefined"
			class="reminder-input"
		>
			<ReminderDetail
				v-model="reminders[index]"
				class="reminder-detail"
				:disabled="disabled"
				:default-relative-to="defaultRelativeTo"
				:allow-absolute="allowAbsolute"
				@update:modelValue="updateData"
			/>
			<BaseButton
				v-if="!disabled"
				class="remove"
				:aria-label="$t('task.removeReminder')"
				@click="removeReminderByIndex(index)"
			>
				<Icon icon="times" />
			</BaseButton>
		</div>

		<ReminderDetail
			:disabled="disabled"
			:clear-after-update="true"
			:default-relative-to="defaultRelativeTo"
			:allow-absolute="allowAbsolute"
			@update:modelValue="addNewReminder"
		/>
	</div>
</template>

<script setup lang="ts">
import {ref, watch} from 'vue'

import type {TaskReminder as ITaskReminder} from '@/client/generated'
import type {IReminderPeriodRelativeTo} from '@/types/IReminderPeriodRelativeTo'

import {parseDateOrNull} from '@/helpers/parseDateOrNull'

import BaseButton from '@/components/base/BaseButton.vue'
import ReminderDetail from '@/components/tasks/partials/ReminderDetail.vue'
import {useGlobalNow} from '@/composables/useGlobalNow'

const props = withDefaults(defineProps<{
	modelValue?: ITaskReminder[],
	defaultRelativeTo?: IReminderPeriodRelativeTo | null,
	disabled?: boolean,
	allowAbsolute?: boolean,
}>(), {
	modelValue: () => [],
	defaultRelativeTo: null,
	disabled: false,
	allowAbsolute: true,
})

const emit = defineEmits<{
	'update:modelValue': [ITaskReminder[]]
}>()

const reminders = ref<ITaskReminder[]>([])

// Overdue styling follows the shared minute clock: one timer for the app, not a re-render of the list every second.
const {now} = useGlobalNow()

function isOverdue(reminder: ITaskReminder): boolean {
	const date = parseDateOrNull(reminder.reminder)
	return date !== null && date < now.value
}

watch(
	() => props.modelValue,
	(newVal) => {
		reminders.value = [...(newVal ?? [])]
	},
	{immediate: true, deep: true}, // deep watcher so that we get the resolved date after updating the task
)

function updateData() {
	emit('update:modelValue', [...reminders.value])
}

function addNewReminder(newReminder: ITaskReminder | undefined) {
	if (!newReminder) {
		return
	}
	reminders.value.push(newReminder)
	updateData()
}

function removeReminderByIndex(index: number) {
	reminders.value.splice(index, 1)
	updateData()
}
</script>

<style lang="scss" scoped>
.reminders {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.reminder-input {
	display: flex;
	align-items: center;
	gap: var(--space-1);

	&[data-is-overdue] :deep(.datepicker .show) {
		color: var(--danger-text);
	}
}

.reminder-detail {
	inline-size: 100%;
}

.remove {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	inline-size: max(1.5rem, var(--target-min));
	block-size: max(1.5rem, var(--target-min));
	border-radius: var(--radius-sm);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		background: var(--tint-danger);
		color: var(--danger-text);
	}
}
</style>
