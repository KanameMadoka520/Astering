<template>
	<section
		ref="root"
		class="task-routine"
		:class="`is-${mode}`"
		:aria-labelledby="headingId"
		:aria-busy="saving || undefined"
		:data-routine-mode="mode"
		tabindex="-1"
	>
		<div class="task-routine__header">
			<h2
				:id="headingId"
				class="task-routine__title"
			>
				<Icon
					:icon="['far', 'sun']"
					class="task-routine__title-icon"
				/>
				{{ $t(legacyPresentation ? 'task.routine.settings.title' : 'routineSchedule.title') }}
			</h2>
			<RoutineStatusChip
				v-if="routine?.enabled"
				:task="{routine}"
			/>
			<span
				v-else-if="mode === 'disabled'"
				class="task-routine__off"
			>
				<Icon
					icon="power-off"
					class="task-routine__off-icon"
				/>
				{{ $t('task.routine.settings.offBadge') }}
			</span>
			<Icon
				v-if="showSaving"
				icon="spinner"
				spin
				class="task-routine__saving"
			/>
		</div>

		<Message
			v-if="notice"
			variant="warning"
			class="task-routine__notice"
		>
			<div
				class="task-routine__notice-body"
				role="alert"
			>
				<p class="task-routine__text">
					{{ noticeText }}
				</p>
				<div class="task-routine__actions">
					<XButton
						v-if="canReapply"
						variant="secondary"
						class="is-small"
						icon="undo"
						:shadow="false"
						:loading="saving"
						:aria-disabled="saving || reloading || undefined"
						@click="reapply"
					>
						{{ $t('task.routine.settings.reapply', {action: intentLabel(notice.intent)}) }}
					</XButton>
					<XButton
						variant="tertiary"
						class="is-small"
						:shadow="false"
						@click="notice = null"
					>
						{{ $t('misc.close') }}
					</XButton>
				</div>
			</div>
		</Message>

		<!-- Enabled: today's state, the zone, streaks and the controls. -->
		<template v-if="mode === 'enabled' && routine">
			<p
				class="task-routine__status"
				:data-routine-today="todayState"
			>
				<Icon
					:icon="todayIcon"
					class="task-routine__status-icon"
					:class="`is-${todayState}`"
				/>
				<span>{{ todayText }}</span>
			</p>
			<ul class="task-routine__facts">
				<li>
					<Icon
						icon="globe"
						class="task-routine__fact-icon"
					/>
					{{ legacy ? $t('task.routine.settings.dayInfo', {
						date: format.day(today, {year: 'numeric', month: 'long', day: 'numeric'}),
						timezone: format.zone(routine.timezone),
					}) : $t('routineSchedule.periodInfo', {
						start: periodInstant(routine.period_start_at),
						end: periodInstant(routine.next_reset_at),
						timezone: format.zone(routine.timezone),
					}) }}
				</li>
				<li v-if="streak">
					<Icon
						:icon="['far', 'calendar-check']"
						class="task-routine__fact-icon"
					/>
					{{ $t(legacy ? 'task.routine.settings.streak' : 'routineSchedule.streak', {
						current: days(streak.current_streak),
						longest: days(streak.longest_streak),
					}) }}
				</li>
				<li>
					<Icon
						icon="users"
						class="task-routine__fact-icon"
					/>
					{{ $t(legacy ? 'task.routine.settings.shared' : 'routineSchedule.shared') }}
				</li>
			</ul>
			<RoutineProgressControl
				v-if="!legacy"
				:task-id="task.id"
				:routine="routine"
				:can-edit="canEdit"
			/>
			<div
				v-if="editingSchedule && canEdit"
				class="task-routine__zone-editor"
			>
				<RoutineScheduleEditor
					v-model="scheduleDraft"
					:saving="saving"
				/>
				<p class="task-routine__hint">
					{{ $t('routineSchedule.changeHint') }}
				</p>
				<div class="task-routine__actions">
					<XButton
						type="button"
						:loading="savingIntent === 'schedule'"
						:aria-disabled="saving || !scheduleValid"
						@click="saveSchedule"
					>
						{{ $t('routineSchedule.saveSchedule') }}
					</XButton>
					<XButton
						type="button"
						variant="tertiary"
						@click="stopScheduleEdit"
					>
						{{ $t('misc.cancel') }}
					</XButton>
				</div>
			</div>

			<div
				v-if="editingZone && canEdit"
				class="task-routine__zone-editor"
			>
				<RoutineTimezonePicker
					:model-value="zoneDraft"
					:disabled="saving"
					:hint="legacy ? undefined : $t('routineSchedule.timezoneHint')"
					@update:modelValue="zoneChoice = $event"
				/>
				<div class="task-routine__actions">
					<XButton
						variant="primary"
						class="is-small"
						:shadow="false"
						:loading="savingIntent === 'timezone'"
						:aria-disabled="saving || zoneDraft === routine.timezone || undefined"
						@click="saveZone"
					>
						{{ $t('task.routine.settings.saveTimezone') }}
					</XButton>
					<XButton
						variant="tertiary"
						class="is-small"
						:shadow="false"
						@click="stopZoneEdit"
					>
						{{ $t('misc.cancel') }}
					</XButton>
				</div>
			</div>

			<div
				v-if="canEdit"
				class="task-routine__actions"
				role="group"
				:aria-label="$t('task.routine.settings.controls')"
			>
				<XButton
					variant="secondary"
					class="is-small"
					:shadow="false"
					:icon="routine.paused ? 'play' : 'pause'"
					:loading="savingIntent === 'pause' || savingIntent === 'resume'"
					:aria-disabled="saving || undefined"
					@click="togglePause"
				>
					{{ routine.paused ? $t('task.routine.settings.resume') : $t('task.routine.settings.pause') }}
				</XButton>
				<XButton
					v-if="!editingZone && !editingSchedule"
					variant="tertiary"
					class="is-small"
					icon="globe"
					:shadow="false"
					:aria-disabled="saving || undefined"
					@click="startZoneEdit"
				>
					{{ $t('task.routine.settings.changeTimezone') }}
				</XButton>
				<XButton
					v-if="!editingSchedule && !editingZone"
					variant="tertiary"
					class="is-small"
					:aria-disabled="saving || undefined"
					@click="startScheduleEdit"
				>
					{{ $t('routineSchedule.editSchedule') }}
				</XButton>
				<XButton
					variant="tertiary"
					class="is-small task-routine__disable"
					icon="power-off"
					:shadow="false"
					:aria-disabled="saving || undefined"
					@click="askDisable"
				>
					{{ $t('task.routine.settings.disable') }}
				</XButton>
			</div>
		</template>

		<!-- Turned off: a normal task again, the history stays reachable. -->
		<template v-else-if="mode === 'disabled'">
			<p class="task-routine__status">
				<Icon
					icon="power-off"
					class="task-routine__status-icon"
				/>
				<span>{{ $t('task.routine.settings.disabledNotice') }}</span>
			</p>
			<div
				v-if="canEdit"
				class="task-routine__actions"
			>
				<XButton
					variant="secondary"
					class="is-small"
					:icon="['far', 'sun']"
					:shadow="false"
					@click="openSetup"
				>
					{{ $t('task.routine.settings.reenable') }}
				</XButton>
			</div>
		</template>

		<!-- Setting up: explain, block on done/repeat without touching them, pick the zone. -->
		<template v-else-if="mode === 'setup' && canEdit">
			<p class="task-routine__text">
				{{ $t(isLegacyRoutine(scheduleDraft) ? 'task.routine.settings.intro' : 'routineSchedule.intro') }}
			</p>
			<p class="task-routine__hint">
				<Icon
					icon="users"
					class="task-routine__fact-icon"
				/>
				{{ $t(isLegacyRoutine(scheduleDraft) ? 'task.routine.settings.shared' : 'routineSchedule.shared') }}
			</p>

			<Message
				v-if="isBlocked"
				variant="warning"
				class="task-routine__blockers"
			>
				<div :id="blockersId">
					<p class="task-routine__blockers-title">
						{{ $t('task.routine.settings.blockedTitle') }}
					</p>
					<ul class="task-routine__blocker-list">
						<li
							v-if="isDone"
							class="task-routine__blocker"
							data-routine-blocker="done"
						>
							<span>{{ $t('task.routine.settings.blockedDone') }}</span>
							<XButton
								variant="secondary"
								class="is-small"
								icon="undo"
								:shadow="false"
								:loading="reopenPending"
								:aria-disabled="reopenPending || undefined"
								@click="reopenPending || emit('reopen')"
							>
								{{ $t('task.routine.settings.reopenTask') }}
							</XButton>
						</li>
						<li
							v-if="isRepeating"
							class="task-routine__blocker"
							data-routine-blocker="repeat"
						>
							<span>{{ $t('task.routine.settings.blockedRepeat') }}</span>
							<XButton
								variant="secondary"
								class="is-small"
								icon="times"
								:shadow="false"
								:loading="removeRepeatPending"
								:aria-disabled="removeRepeatPending || undefined"
								@click="removeRepeatPending || emit('removeRepeat')"
							>
								{{ $t('task.routine.settings.removeRepeat') }}
							</XButton>
						</li>
					</ul>
					<p class="task-routine__hint">
						{{ $t('task.routine.settings.blockedNoChange') }}
					</p>
				</div>
			</Message>

			<RoutineScheduleEditor
				v-model="scheduleDraft"
				:saving="saving"
			/>

			<div class="task-routine__actions">
				<XButton
					variant="primary"
					class="is-small task-routine__enable"
					:icon="['far', 'sun']"
					:shadow="false"
					:loading="savingIntent === 'enable'"
					:aria-disabled="isBlocked || saving || !scheduleValid || undefined"
					:aria-describedby="isBlocked ? blockersId : undefined"
					@click="enable"
				>
					{{ $t(legacyPresentation ? 'task.routine.settings.enable' : 'routineSchedule.enable') }}
				</XButton>
				<XButton
					variant="tertiary"
					class="is-small"
					:shadow="false"
					@click="cancelSetup"
				>
					{{ $t('misc.cancel') }}
				</XButton>
			</div>
		</template>

		<div
			v-if="hasRecord && routine"
			class="task-routine__history"
		>
			<XButton
				variant="tertiary"
				class="is-small task-routine__history-toggle"
				:icon="['far', 'calendar-check']"
				:shadow="false"
				:aria-expanded="historyOpen"
				:aria-controls="historyId"
				@click="historyOpen = !historyOpen"
			>
				{{ historyOpen ? $t('task.routine.settings.hideHistory') : $t('task.routine.settings.showHistory') }}
			</XButton>
			<div
				:id="historyId"
				class="task-routine__history-body"
			>
				<TaskRoutineHistory
					v-if="historyOpen"
					:task-id="task.id"
					:routine="routine"
					:since="task.routine?.created"
				/>
			</div>
		</div>

		<Modal
			:enabled="confirmingDisable"
			danger
			:loading="savingIntent === 'disable'"
			@close="confirmingDisable = false"
			@submit="disable"
		>
			<template #header>
				<span>{{ $t(legacy ? 'task.routine.settings.disableConfirmTitle' : 'routineSchedule.disableConfirmTitle') }}</span>
			</template>
			<template #text>
				<p class="tw:text-balance">
					{{ $t('task.routine.settings.disableConfirmText') }}
				</p>
			</template>
		</Modal>
	</section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'

import Icon from '@/components/misc/Icon'
import Message from '@/components/misc/Message.vue'
import Modal from '@/components/misc/Modal.vue'
import RoutineStatusChip from '@/components/tasks/partials/RoutineStatusChip.vue'
import RoutineTimezonePicker from './RoutineTimezonePicker.vue'
import TaskRoutineHistory from './TaskRoutineHistory.vue'
import RoutineScheduleEditor from './RoutineScheduleEditor.vue'
import RoutineProgressControl from './RoutineProgressControl.vue'
import {useRoutineFormat} from './useRoutineFormat'

import type {Task} from '@/client/generated'
import {ApiError} from '@/client/problem'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {
	useConfigureTaskRoutineMutation,
	useRefreshTaskRoutinesMutation,
} from '@/client/queries/taskRoutines'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {useTaskRoutineHistory, useTaskRoutineSummary} from '@/composables/useTaskRoutine'
import {
	routineMonth,
	routineOf,
	routineSchedule,
	routineStatus,
	routineToday,
	isLegacyRoutine,
	validRoutineSchedule,
	type TaskRoutineSchedule,
	type TaskRoutineSummary,
} from '@/helpers/taskRoutine'
import {resolveUserTimezone} from '@/helpers/time/userTimezone'
import {error, success} from '@/message'
import {useAuthStore} from '@/stores/auth'
import {TASK_REPEAT_MODES} from '@/types/IRepeatMode'

type Intent =
	| {kind: 'enable', schedule: TaskRoutineSchedule}
	| {kind: 'pause'}
	| {kind: 'resume'}
	| {kind: 'disable'}
	| {kind: 'timezone', timezone: string}
	| {kind: 'schedule', schedule: TaskRoutineSchedule}

type Notice = {
	// 'conflict': the routine changed elsewhere (409); 'state': the task or routine no longer allows it (400 20003).
	reason: 'conflict' | 'state'
	intent: Intent
}

const props = defineProps<{
	task: Pick<Task, 'id' | 'done' | 'repeat_after' | 'repeat_mode' | 'routine'> & {id: number}
	// Write access to an unarchived project.
	canEdit: boolean
	reopenPending?: boolean
	removeRepeatPending?: boolean
}>()

const emit = defineEmits<{
	// The ordinary task actions that clear a blocker; the detail view runs them through its own save path.
	reopen: []
	removeRepeat: []
	// Setup was cancelled on a task that never had a routine.
	close: []
	// The task changed in a way only a full read shows (done or repeat set elsewhere).
	taskStale: []
}>()

const {t} = useI18n({useScope: 'global'})
const {now} = useGlobalNow()
const authStore = useAuthStore()
const format = useRoutineFormat()
const owner = captureClientRequestContext()
let disposed = false
let generation = 0
onBeforeUnmount(() => { disposed = true })

const root = useTemplateRef<HTMLElement>('root')
const headingId = useId()
const blockersId = useId()
const historyId = useId()

const summary = useTaskRoutineSummary(() => props.task.id)
const configure = useConfigureTaskRoutineMutation()
const refreshRoutines = useRefreshTaskRoutinesMutation()

// The task copy follows live updates and check-ins; the summary is read on mount and after a conflict.
// A configuration change always raises the revision, so the higher one is the newer configuration.
const routine = computed<TaskRoutineSummary | null>(() => {
	const fromTask = routineOf(props.task)
	const fromSummary = summary.routine.value ?? null
	if (!fromTask) return fromSummary
	if (!fromSummary) return fromTask
	return fromSummary.revision > fromTask.revision ? fromSummary : fromTask
})

const hasRecord = computed(() => (routine.value?.revision ?? 0) > 0)
const legacy = computed(() => !routine.value || isLegacyRoutine(routine.value))
const periodInstant = (instant: string) => format.instant(instant, routine.value?.timezone ?? '')

const setupOpen = ref(false)
const mode = computed<'enabled' | 'disabled' | 'setup'>(() => {
	if (routine.value?.enabled) return 'enabled'
	if (hasRecord.value && (!setupOpen.value || !props.canEdit)) return 'disabled'
	return 'setup'
})

watch(() => routine.value?.enabled, enabled => {
	if (enabled) setupOpen.value = false
})

const historyOpen = ref(false)
const confirmingDisable = ref(false)
const notice = ref<Notice | null>(null)
const reloading = ref(false)

const savingIntent = ref<Intent['kind'] | null>(null)
const saving = computed(() => savingIntent.value !== null)
const showSaving = useDelayedLoading(saving)

// The server refuses a routine on a done or repeating task; the same rule decides here.
const isDone = computed(() => props.task.done === true)
const isRepeating = computed(() => (props.task.repeat_after ?? 0) !== 0
	|| (props.task.repeat_mode ?? TASK_REPEAT_MODES.REPEAT_MODE_DEFAULT) !== TASK_REPEAT_MODES.REPEAT_MODE_DEFAULT)
const isBlocked = computed(() => isDone.value || isRepeating.value)

const accountZone = computed(() => resolveUserTimezone(authStore.settings.timezone))

// null: the user has not picked a zone, so the routine's own (or the account's for a new one) applies.
const zoneChoice = ref<string | null>(null)
const zoneDraft = computed(() => zoneChoice.value || routine.value?.timezone || accountZone.value)
const editingZone = ref(false)
const editingSchedule = ref(false)
const scheduleChoice = ref<TaskRoutineSchedule | null>(null)
const scheduleDraft = computed({
	get: () => scheduleChoice.value ?? routineSchedule(routine.value, accountZone.value),
	set: (schedule: TaskRoutineSchedule) => { scheduleChoice.value = schedule },
})
const scheduleValid = computed(() => validRoutineSchedule(scheduleDraft.value))
const legacyPresentation = computed(() => mode.value === 'setup' ? isLegacyRoutine(scheduleDraft.value) : legacy.value)

function startScheduleEdit() {
	if (saving.value || editingZone.value) return
	if (!scheduleChoice.value) scheduleChoice.value = routineSchedule(routine.value, accountZone.value)
	editingSchedule.value = true
}
function stopScheduleEdit() {
	if (saving.value) return
	editingSchedule.value = false
	scheduleChoice.value = null
}
async function saveSchedule() {
	if (saving.value || !scheduleValid.value) return
	const schedule = {...scheduleDraft.value}
	if (await run({kind: 'schedule', schedule})) stopScheduleEdit()
}

function startZoneEdit() {
	if (saving.value) return
	if (editingSchedule.value) return
	zoneChoice.value = null
	editingZone.value = true
}

function stopZoneEdit() {
	editingZone.value = false
	zoneChoice.value = null
}

const today = computed(() => routine.value ? routineToday(routine.value, now.value) : '')
const todayState = computed(() => routineStatus(routine.value, now.value) ?? 'pending')

const todayIcon = computed<IconProp>(() => {
	switch (todayState.value) {
		case 'done': return 'circle-check'
		case 'paused': return 'pause'
		default: return ['far', 'sun']
	}
})

const todayText = computed(() => {
	const current = routine.value
	if (!current) return ''
	if (!legacy.value) {
		if (todayState.value === 'paused') return t('task.routine.settings.statusPaused')
		return t(todayState.value === 'done' ? 'routineSchedule.completeStatus' : 'routineSchedule.pendingStatus')
	}
	switch (todayState.value) {
		case 'done': return t('task.routine.settings.statusDone', {
			time: format.time(current.completed_at, current.timezone),
			user: format.operator(current.completed_by_id),
		})
		case 'paused': return t('task.routine.settings.statusPaused')
		default: return t('task.routine.settings.statusPending')
	}
})

// The history of the routine's current month also carries the streaks; the open calendar shares this read.
const currentMonth = computed(() => routine.value ? routineMonth(routine.value, now.value) : {year: 0, month: 0})
const {history: streak} = useTaskRoutineHistory(
	() => hasRecord.value ? props.task.id : 0,
	() => currentMonth.value.year,
	() => currentMonth.value.month,
)

function days(count: number): string {
	return t(legacy.value ? 'task.routine.history.days' : 'routineSchedule.periodCount', {n: count}, count)
}

function intentLabel(intent: Intent): string {
	switch (intent.kind) {
		case 'enable': return t('task.routine.settings.enable')
		case 'pause': return t('task.routine.settings.pause')
		case 'resume': return t('task.routine.settings.resume')
		case 'disable': return t('task.routine.settings.disable')
		case 'timezone': return t('task.routine.settings.changeTimezone')
		case 'schedule': return t('routineSchedule.editSchedule')
	}
}

const noticeText = computed(() => {
	if (!notice.value) return ''
	const action = intentLabel(notice.value.intent)
	return notice.value.reason === 'conflict'
		? t('task.routine.settings.conflict', {action})
		: t('task.routine.settings.stateChanged', {action})
})

// Re-applying only makes sense while the reloaded state still lets the same choice change something.
function stillApplies(intent: Intent): boolean {
	const current = routine.value
	switch (intent.kind) {
		case 'enable': return !current?.enabled && !isBlocked.value
		case 'pause': return current?.enabled === true && !current.paused
		case 'resume': return current?.enabled === true && current.paused
		case 'disable': return current?.enabled === true
		case 'timezone': return current?.enabled === true && current.timezone !== intent.timezone
		case 'schedule': return current?.enabled === true
	}
}

const canReapply = computed(() => props.canEdit && notice.value !== null && stillApplies(notice.value.intent))

function changesFor(intent: Intent, current: TaskRoutineSummary | null) {
	const calendar = routineSchedule(current, accountZone.value)
	switch (intent.kind) {
		case 'enable': return {
			...intent.schedule,
			enabled: true,
			paused: false,
		}
		case 'pause': return {
			...calendar,
			enabled: true,
			paused: true,
		}
		case 'resume': return {
			...calendar,
			enabled: true,
			paused: false,
		}
		case 'disable': return {
			...calendar,
			enabled: false,
			paused: false,
		}
		case 'timezone': return {
			...calendar,
			enabled: true,
			paused: current?.paused ?? false,
			timezone: intent.timezone,
		}
		case 'schedule': return {
			...intent.schedule,
			enabled: true,
			paused: current?.paused ?? false,
		}
	}
}

const SUCCESS_KEYS: Record<Intent['kind'], string> = {
	enable: 'task.routine.settings.enabledSuccess',
	pause: 'task.routine.settings.pausedSuccess',
	resume: 'task.routine.settings.resumedSuccess',
	disable: 'task.routine.settings.disabledSuccess',
	timezone: 'task.routine.settings.timezoneSuccess',
	schedule: 'routineSchedule.saved',
}
const PERIOD_SUCCESS_KEYS: Partial<Record<Intent['kind'], string>> = {
	enable: 'routineSchedule.enableSuccess',
	pause: 'routineSchedule.pauseSuccess',
	resume: 'routineSchedule.resumeSuccess',
	disable: 'routineSchedule.disableSuccess',
}

// The summary drives this panel; the task copies drive the header button and the project views.
async function reload(stale: boolean) {
	reloading.value = true
	refreshRoutines.mutate([props.task.id])
	if (stale) emit('taskStale')
	try {
		await summary.refetch()
	} finally {
		reloading.value = false
	}
}

async function run(intent: Intent): Promise<boolean> {
	if (!props.canEdit || saving.value || !isClientRequestContextCurrent(owner)) return false
	const taskId = props.task.id
	const routeGeneration = generation
	const request = captureClientRequestContext()
	const currentRequest = () => !disposed && routeGeneration === generation
		&& props.task.id === taskId && isClientRequestContextCurrent(request)
	const current = routine.value
	notice.value = null
	savingIntent.value = intent.kind
	try {
		await configure.mutateAsync({
			taskId,
			revision: current?.revision ?? 0,
			...changesFor(intent, current),
		})
	} catch (cause) {
		if (isRequestContextAbort(cause) || !currentRequest()) return false
		if (cause instanceof ApiError && (cause.status === 409 || cause.code === 20003)) {
			// Nothing was written: say so, read the current state, keep the user's choice on screen.
			notice.value = {
				reason: cause.status === 409 ? 'conflict' : 'state',
				intent,
			}
			void reload(cause.status !== 409)
		} else {
			error(cause)
		}
		return false
	} finally {
		if (currentRequest()) savingIntent.value = null
	}
	if (!currentRequest()) return false
	success({message: t((!legacy.value && PERIOD_SUCCESS_KEYS[intent.kind]) || SUCCESS_KEYS[intent.kind])})
	return true
}

async function enable() {
	if (isBlocked.value || saving.value || !scheduleValid.value) return
	if (await run({kind: 'enable', schedule: {...scheduleDraft.value}})) {
		scheduleChoice.value = null
		zoneChoice.value = null
		// The setup controls are gone now; keep focus inside the panel.
		await nextTick()
		root.value?.focus({preventScroll: true})
	}
}

async function saveZone() {
	const timezone = zoneDraft.value
	if (saving.value || timezone === routine.value?.timezone) return
	if (await run({kind: 'timezone', timezone})) stopZoneEdit()
}

function togglePause() {
	const current = routine.value
	if (!current?.enabled) return
	void run(current.paused ? {kind: 'resume'} : {kind: 'pause'})
}

function askDisable() {
	if (saving.value) return
	confirmingDisable.value = true
}

async function disable() {
	if (saving.value) return
	const taskId = props.task.id
	const routeGeneration = generation
	const request = captureClientRequestContext()
	const disabled = await run({kind: 'disable'})
	if (disposed || routeGeneration !== generation
		|| props.task.id !== taskId || !isClientRequestContextCurrent(request)) return
	confirmingDisable.value = false
	if (!disabled) return
	editingZone.value = false
	await nextTick()
	root.value?.focus({preventScroll: true})
}

function reapply() {
	const intent = notice.value?.intent
	if (!intent || reloading.value || !stillApplies(intent)) return
	if (intent.kind === 'disable') {
		askDisable()
		return
	}
	void run(intent)
}

function openSetup() {
	if (routine.value?.enabled) return
	setupOpen.value = true
}

function cancelSetup() {
	setupOpen.value = false
	zoneChoice.value = null
	scheduleChoice.value = null
	if (notice.value?.intent.kind === 'enable') notice.value = null
	if (!hasRecord.value) emit('close')
}

watch(() => props.task.id, () => {
	generation++
	setupOpen.value = false
	editingZone.value = false
	editingSchedule.value = false
	scheduleChoice.value = null
	zoneChoice.value = null
	notice.value = null
	confirmingDisable.value = false
	savingIntent.value = null
})

defineExpose({openSetup})
</script>

<style lang="scss" scoped>
.task-routine {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-3) var(--space-4) var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);

	&:focus-visible {
		@include focus-ring;
	}

	// Focus moved here by script (after enabling or from the actions rail) needs no ring.
	&:focus:not(:focus-visible) {
		outline: none;
	}

	@media screen and (max-width: $tablet) {
		padding-inline: var(--space-3);
	}
}

.task-routine__header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
}

.task-routine__title {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.task-routine__title-icon {
	inline-size: 1rem;
	color: var(--text-tertiary);
}

.task-routine__off {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	padding: 1px var(--space-2);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	background: var(--surface-active);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
}

.task-routine__off-icon {
	inline-size: .625rem;
}

.task-routine__saving {
	margin-inline-start: auto;
	color: var(--text-tertiary);
}

.task-routine__status {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-base);
	font-weight: var(--weight-medium);
}

.task-routine__status-icon {
	flex-shrink: 0;
	margin-block-start: .2em;
	color: var(--text-tertiary);

	&.is-done {
		color: var(--success);
	}

	&.is-pending {
		color: var(--warning);
	}
}

.task-routine__facts {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	margin: 0;
	padding: 0;
	list-style: none;
	color: var(--text-secondary);
	font-size: var(--text-sm);

	li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		margin: 0;
		overflow-wrap: anywhere;
	}
}

.task-routine__fact-icon {
	flex-shrink: 0;
	inline-size: .875rem;
	margin-block-start: .2em;
	color: var(--text-tertiary);
}

.task-routine__text {
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-md);
}

.task-routine__hint {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.task-routine__actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
}

.task-routine__disable:not([aria-disabled='true']):hover {
	color: var(--danger-text);
}

.task-routine__notice-body {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

.task-routine__blockers-title {
	margin: 0 0 var(--space-2);
	font-weight: var(--weight-semibold);
}

.task-routine__blocker-list {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	margin: 0 0 var(--space-2);
	padding: 0;
	list-style: none;
}

.task-routine__blocker {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2) var(--space-3);
	margin: 0;

	> span {
		flex: 1 1 14rem;
		min-inline-size: 0;
	}
}

.task-routine__zone-editor {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);
}

.task-routine__history {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding-block-start: var(--space-3);
	border-block-start: 1px solid var(--border-subtle);
}

.task-routine__history-toggle {
	align-self: flex-start;
}

// Coarse pointers: every control in the panel reaches the 44px target.
@media (pointer: coarse) {
	.task-routine .button.is-small {
		min-block-size: var(--target-min);
	}
}
</style>
