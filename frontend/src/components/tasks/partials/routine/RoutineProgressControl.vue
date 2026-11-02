<script setup lang="ts">
import {computed, onBeforeUnmount, ref, shallowRef, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import Message from '@/components/misc/Message.vue'
import {ApiError} from '@/client/problem'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {
	useRefreshTaskRoutinesMutation,
	useSetTaskRoutineProgressMutation,
} from '@/client/queries/taskRoutines'
import {hasRoutineDayEnded, type TaskRoutineSummary} from '@/helpers/taskRoutine'
import {useGlobalNow} from '@/composables/useGlobalNow'

const props = defineProps<{
	taskId: number
	routine: TaskRoutineSummary
	canEdit: boolean
}>()
const {t, locale} = useI18n({useScope: 'global'})
const progress = useSetTaskRoutineProgressMutation()
const refresh = useRefreshTaskRoutinesMutation()
const {now} = useGlobalNow()
const number = computed(() => new Intl.NumberFormat(locale.value))
const identity = computed(() =>
	`${props.taskId}:${props.routine.schedule_key}:${props.routine.revision}:${props.routine.date}`)
// These are editable snapshots; prop changes replace them only while clean.
/* eslint-disable vue/no-ref-object-reactivity-loss, vue/no-setup-props-reactivity-loss */
const draftIdentity = ref(identity.value)
const draftRequest = shallowRef(captureClientRequestContext())
const identityChanged = ref(false)
const amount = ref(String(props.routine.current_amount))
const baseline = ref(amount.value)
/* eslint-enable vue/no-ref-object-reactivity-loss, vue/no-setup-props-reactivity-loss */
const dirty = computed(() => amount.value !== baseline.value)
const saving = ref(false)
const failure = ref('')
const ended = computed(() => hasRoutineDayEnded(props.routine, now.value))
const shownAmount = computed(() => ended.value ? 0 : props.routine.current_amount)
const stale = computed(() => identityChanged.value || draftIdentity.value !== identity.value || ended.value)
const valid = computed(() => /^\d+$/.test(amount.value) && Number.isSafeInteger(Number(amount.value)))
const unavailable = computed(() => !props.canEdit || props.routine.paused || !props.routine.enabled)
let disposed = false
let operation = 0
onBeforeUnmount(() => { disposed = true })
watch(identity, () => {
	if (!dirty.value && !saving.value) adopt(false)
})
watch(() => props.routine.current_amount, () => {
	if (!dirty.value && !saving.value) adopt(false)
})
watch(() => props.taskId, () => {
	operation++
	saving.value = false
	adopt(false)
})

function adopt(keepAmount = true) {
	draftIdentity.value = identity.value
	draftRequest.value = captureClientRequestContext()
	identityChanged.value = false
	baseline.value = String(props.routine.current_amount)
	if (!keepAmount) amount.value = baseline.value
	failure.value = ''
}
async function useCurrentPeriod() {
	if (saving.value || refresh.isPending.value) return
	const mine = operation
	const request = captureClientRequestContext()
	const taskId = props.taskId
	try {
		const results = await refresh.mutateAsync([taskId])
		if (!results.some(result => result.taskId === taskId)) return
	} catch {
		return
	}
	if (!disposed && mine === operation && props.taskId === taskId
		&& isClientRequestContextCurrent(request) && !ended.value) adopt()
}
async function save() {
	if (!isClientRequestContextCurrent(draftRequest.value)) {
		identityChanged.value = true
		return
	}
	if (saving.value || unavailable.value || !valid.value || stale.value || !dirty.value) return
	const mine = ++operation
	const request = captureClientRequestContext()
	const target = identity.value
	const submitted = amount.value
	saving.value = true
	failure.value = ''
	try {
		await progress.mutateAsync({
			taskId: props.taskId,
			date: props.routine.date,
			revision: props.routine.revision,
			amount: Number(submitted),
		})
		if (disposed || mine !== operation || !isClientRequestContextCurrent(request) || target !== identity.value) return
		baseline.value = submitted
	} catch (cause) {
		if (disposed || mine !== operation || isRequestContextAbort(cause)
			|| !isClientRequestContextCurrent(request) || target !== identity.value) return
		if (cause instanceof ApiError && (cause.status === 409 || cause.code === 20003)) {
			failure.value = t('routineSchedule.progressConflict')
			refresh.mutate([props.taskId])
		} else {
			failure.value = cause instanceof Error ? cause.message : t('routineSchedule.progressFailed')
		}
	} finally {
		if (!disposed && mine === operation) saving.value = false
	}
}
</script>

<template>
	<form
		class="routine-progress"
		:aria-label="t('routineSchedule.progress')"
		@submit.prevent="save"
	>
		<p
			class="routine-progress__amount"
			role="status"
		>
			{{ t('routineSchedule.amount', {
				amount: number.format(shownAmount),
				target: number.format(routine.target),
				unit: routine.unit,
			}) }}
		</p>
		<progress
			:value="Math.min(shownAmount, routine.target)"
			:max="routine.target"
			:aria-label="t('routineSchedule.progress')"
		/>
		<template v-if="canEdit">
			<div class="routine-progress__controls">
				<label>
					<span>{{ t('routineSchedule.currentAmount') }}</span>
					<input
						v-model="amount"
						type="number"
						class="input"
						min="0"
						:max="Number.MAX_SAFE_INTEGER"
						step="1"
						:readonly="saving || unavailable"
					>
				</label>
				<XButton
					type="submit"
					icon="save"
					:loading="saving"
					:aria-disabled="saving || unavailable || !valid || stale || !dirty"
				>
					{{ t('routineSchedule.saveProgress') }}
				</XButton>
			</div>
			<p class="routine-progress__hint">
				{{ t('routineSchedule.absoluteHint') }}
			</p>
			<Message
				v-if="stale"
				variant="warning"
			>
				{{ t('routineSchedule.progressStale') }}
				<XButton
					type="button"
					variant="secondary"
					:loading="refresh.isPending.value"
					:aria-disabled="saving || refresh.isPending.value"
					@click="useCurrentPeriod"
				>
					{{ t('routineSchedule.keepAmount') }}
				</XButton>
			</Message>
			<Message
				v-if="failure"
				variant="danger"
			>
				<span role="alert">{{ failure }}</span>
			</Message>
		</template>
	</form>
</template>

<style lang="scss" scoped>
.routine-progress {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);

	progress {
		inline-size: 100%;
		block-size: .5rem;
		accent-color: var(--primary);
	}
}

.routine-progress__amount {
	margin: 0;
	font-weight: var(--weight-semibold);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}

.routine-progress__controls {
	display: flex;
	flex-wrap: wrap;
	align-items: end;
	gap: var(--space-3);

	label {
		display: grid;
		flex: 1 1 10rem;
		gap: var(--space-2);
		min-inline-size: 0;
	}
}

.routine-progress__hint {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
</style>
