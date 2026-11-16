<script setup lang="ts">
import {computed, ref, useId} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import type {Automation, AutomationDraft} from '@/client/queries/automations'
import {aiSettingsQuery} from '@/client/queries/tcyAi'
import {normalizeOptions, type AssistantOptions} from '@/helpers/assistantProfiles'
import {automationWallTime, onceSchedule, scheduleDescription, scheduleKinds, type AutomationSchedule} from '@/helpers/automationSchedule'
import {resolveCalendarWallTime} from '@/helpers/calendar'
import AssistantPreferences from './AssistantPreferences.vue'
import ToolModuleControls from './ToolModuleControls.vue'
import MCPSessionPicker from './MCPSessionPicker.vue'
import XButton from '@/components/input/Button.vue'
import LoadError from '@/components/misc/state/LoadError.vue'

const props = defineProps<{
	initial: AutomationDraft | Automation
	busy: boolean
	error: string
}>()
const emit = defineEmits<{save: [draft: AutomationDraft], close: []}>()
const {t} = useI18n({useScope: 'global'})
// The editor is a keyed, explicit draft. Background reads must never replace typed instructions.
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const initialDraft: AutomationDraft = {...props.initial, options: normalizeOptions(props.initial.options), schedule: {...props.initial.schedule}}
const initialSchedule = {...initialDraft.schedule, weekdays: [...(initialDraft.schedule.weekdays ?? [1])]}
const initialOnce = automationWallTime(initialSchedule.at ?? new Date(Date.now() + 3_600_000).toISOString(), initialDraft.timezone)
const draft = ref(initialDraft)
const id = useId()
const preferencesOpen = ref(false)
const runtimeMinutes = computed({
	get: () => draft.value.max_runtime_seconds / 60,
	set: (value: number) => { draft.value.max_runtime_seconds = value * 60 },
})
const schedule = ref<AutomationSchedule>(initialSchedule)
const once = ref(initialOnce)
const originalWallTime = resolveCalendarWallTime(initialOnce, initialDraft.timezone)
const occurrence = ref(originalWallTime.kind === 'ambiguous'
	? Math.max(0, originalWallTime.instants.findIndex(at => Date.parse(at) === Date.parse(initialSchedule.at ?? '')))
	: 0)
const localError = ref('')
const settings = useQuery({...aiSettingsQuery(), enabled: computed(() => draft.value.kind === 'agent')})
const models = computed(() => settings.data.value?.connections.filter(connection => connection.kind === 'chat') ?? [])
const zones = computed(() => [...new Set([draft.value.timezone, 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'])])
const ambiguous = computed(() => schedule.value.kind === 'once'
	&& resolveCalendarWallTime(once.value, draft.value.timezone).kind === 'ambiguous')
const summary = computed(() => scheduleDescription(schedule.value.kind === 'once'
	? onceSchedule(once.value, draft.value.timezone, occurrence.value) ?? schedule.value
	: schedule.value, draft.value.timezone))
function applyOptions(options: AssistantOptions) {
	draft.value.options = normalizeOptions(options)
}
function selectSchedule(kind: AutomationSchedule['kind']) {
	schedule.value = {
		kind,
		time: schedule.value.time ?? '09:00',
		weekdays: [...(schedule.value.weekdays ?? [1])],
		day: schedule.value.day ?? 1,
		month: schedule.value.month ?? 1,
		interval_minutes: schedule.value.interval_minutes ?? 60,
	}
}
function submit() {
	if (props.busy) return
	localError.value = ''
	try {
		new Intl.DateTimeFormat('en', {timeZone: draft.value.timezone}).format()
	} catch {
		localError.value = t('automations.invalidTimezone')
		return
	}
	let next: AutomationSchedule = {kind: schedule.value.kind}
	if (next.kind === 'once') {
		const resolved = onceSchedule(once.value, draft.value.timezone, occurrence.value)
		if (!resolved) {
			localError.value = t('automations.invalidTime')
			return
		}
		next = resolved
	} else if (next.kind === 'interval') next.interval_minutes = schedule.value.interval_minutes
	else {
		next.time = schedule.value.time || '09:00'
		if (next.kind === 'weekly') next.weekdays = [...(schedule.value.weekdays ?? [])].sort()
		if (next.kind === 'monthly' || next.kind === 'yearly') next.day = schedule.value.day ?? 1
		if (next.kind === 'yearly') next.month = schedule.value.month ?? 1
	}
	if (next.kind === 'weekly' && !next.weekdays?.length) {
		localError.value = t('automations.selectWeekday')
		return
	}
	emit('save', {...draft.value, title: draft.value.title.trim(), schedule: next, options: normalizeOptions(draft.value.options)})
}
</script>

<template>
	<form
		class="automation-editor"
		@submit.prevent="submit"
	>
		<header><h2>{{ t('automations.editorTitle') }}</h2><p>{{ t('automations.editorHint') }}</p></header>
		<fieldset :disabled="busy">
			<label :for="`${id}-title`">{{ t('automations.name') }}</label>
			<input
				:id="`${id}-title`"
				v-model="draft.title"
				class="input"
				required
				maxlength="120"
				autocomplete="off"
				autofocus
			>
			<div class="automation-editor__grid">
				<div class="automation-editor__field">
					<label :for="`${id}-kind`">{{ t('automations.kind') }}</label>
					<select
						:id="`${id}-kind`"
						v-model="draft.kind"
						class="input"
					>
						<option value="agent">
							{{ t('automations.agent') }}
						</option>
						<option value="reminder">
							{{ t('automations.reminder') }}
						</option>
					</select>
				</div>
				<div class="automation-editor__toggle">
					<input
						:id="`${id}-enabled`"
						v-model="draft.enabled"
						type="checkbox"
					>
					<label :for="`${id}-enabled`">{{ t('automations.enabled') }}</label>
				</div>
			</div>
			<label :for="`${id}-prompt`">{{ draft.kind === 'agent' ? t('automations.instructions') : t('automations.reminderText') }}</label>
			<textarea
				:id="`${id}-prompt`"
				v-model="draft.prompt"
				class="textarea"
				rows="6"
				required
				maxlength="12000"
				:placeholder="t(`automations.${draft.kind}Placeholder`)"
				:aria-describedby="`${id}-prompt-hint`"
			/>
			<p
				:id="`${id}-prompt-hint`"
				class="automation-editor__hint"
			>
				{{ t(`automations.${draft.kind}Hint`) }}
			</p>
			<div class="automation-editor__grid">
				<div class="automation-editor__field">
					<label :for="`${id}-frequency`">{{ t('automations.frequency') }}</label>
					<select
						:id="`${id}-frequency`"
						class="input"
						:value="schedule.kind"
						@change="selectSchedule(($event.target as HTMLSelectElement).value as AutomationSchedule['kind'])"
					>
						<option
							v-for="kind in scheduleKinds"
							:key="kind"
							:value="kind"
						>
							{{ t(`automations.schedules.${kind}`) }}
						</option>
					</select>
				</div>
				<div class="automation-editor__field">
					<label :for="`${id}-timezone`">{{ t('automations.timezone') }}</label>
					<input
						:id="`${id}-timezone`"
						v-model.trim="draft.timezone"
						class="input"
						:list="`${id}-zones`"
						required
						autocomplete="off"
					>
					<datalist :id="`${id}-zones`">
						<option
							v-for="zone in zones"
							:key="zone"
							:value="zone"
						/>
					</datalist>
				</div>
			</div>
			<div
				v-if="schedule.kind === 'once'"
				class="automation-editor__field"
			>
				<label :for="`${id}-date-time`">{{ t('automations.dateTime') }}</label>
				<input
					:id="`${id}-date-time`"
					v-model="once"
					class="input"
					type="datetime-local"
					required
				>
			</div>
			<div
				v-else-if="schedule.kind === 'interval'"
				class="automation-editor__field"
			>
				<label :for="`${id}-interval`">{{ t('automations.intervalMinutes') }}</label>
				<input
					:id="`${id}-interval`"
					v-model.number="schedule.interval_minutes"
					class="input"
					type="number"
					min="1"
					max="525600"
					required
				>
			</div>
			<template v-else>
				<div class="automation-editor__field">
					<label :for="`${id}-time`">{{ t('automations.time') }}</label>
					<input
						:id="`${id}-time`"
						v-model="schedule.time"
						class="input"
						type="time"
						required
					>
				</div>
				<div
					v-if="schedule.kind === 'weekly'"
					class="automation-editor__week"
					role="group"
					:aria-label="t('automations.weekdays')"
				>
					<div
						v-for="day in [1, 2, 3, 4, 5, 6, 0]"
						:key="day"
						class="automation-editor__check"
					>
						<input
							:id="`${id}-weekday-${day}`"
							v-model="schedule.weekdays"
							type="checkbox"
							:value="day"
						>
						<label :for="`${id}-weekday-${day}`">{{ t(`automations.dayNames.${day}`) }}</label>
					</div>
				</div>
				<div
					v-if="schedule.kind === 'monthly' || schedule.kind === 'yearly'"
					class="automation-editor__grid"
				>
					<div
						v-if="schedule.kind === 'yearly'"
						class="automation-editor__field"
					>
						<label :for="`${id}-month`">{{ t('automations.month') }}</label>
						<input
							:id="`${id}-month`"
							v-model.number="schedule.month"
							class="input"
							type="number"
							min="1"
							max="12"
							required
							:aria-describedby="`${id}-missing-day-hint`"
						>
					</div>
					<div class="automation-editor__field">
						<label :for="`${id}-month-day`">{{ t('automations.dayOfMonth') }}</label>
						<input
							:id="`${id}-month-day`"
							v-model.number="schedule.day"
							class="input"
							type="number"
							min="1"
							max="31"
							required
							:aria-describedby="`${id}-missing-day-hint`"
						>
					</div>
					<p
						:id="`${id}-missing-day-hint`"
						class="automation-editor__hint"
					>
						{{ t('automations.missingDay') }}
					</p>
				</div>
			</template>
			<div
				v-if="ambiguous"
				class="automation-editor__field"
			>
				<label :for="`${id}-dst-occurrence`">{{ t('automations.dstOccurrence') }}</label>
				<select
					:id="`${id}-dst-occurrence`"
					v-model.number="occurrence"
					class="input"
				>
					<option :value="0">
						{{ t('automations.firstOccurrence') }}
					</option>
					<option :value="1">
						{{ t('automations.secondOccurrence') }}
					</option>
				</select>
			</div>
			<p class="automation-editor__schedule">
				<Icon icon="clock" /> {{ summary }} · {{ draft.timezone }}
			</p>
			<template v-if="draft.kind === 'agent'">
				<LoadError
					v-if="settings.isError.value"
					:retry="() => settings.refetch()"
				/>
				<div class="automation-editor__field">
					<label :for="`${id}-model`">{{ t('chat.model') }}</label>
					<select
						:id="`${id}-model`"
						v-model="draft.options.connection_id"
						class="input"
					>
						<option value="">
							{{ t('automations.defaultModel') }}
						</option>
						<option
							v-for="model in models"
							:key="model.id"
							:value="model.id"
						>
							{{ model.name }} · {{ model.model }}
						</option>
						<option
							v-if="draft.options.connection_id && !models.some(model => model.id === draft.options.connection_id)"
							:value="draft.options.connection_id"
						>
							{{ t('automations.unavailableModel') }} · {{ draft.options.connection_id }}
						</option>
					</select>
				</div>
				<details class="automation-editor__capabilities">
					<summary>{{ t('automations.capabilities') }} · {{ t(`agent.${draft.options.approval === 'unattended' ? 'unattended' : draft.options.approval === 'auto' ? 'auto' : draft.options.approval === 'review' ? 'reviewAll' : 'smart'}`) }}</summary>
					<p class="automation-editor__hint">
						{{ t('automations.permissionsHint') }}
					</p>
					<ToolModuleControls
						:modules="draft.options.tool_modules"
						:mode="draft.options.mode"
						:disabled="busy"
						:mcp-selected="draft.options.mcp_server_ids.length > 0"
						@change="Object.assign(draft.options, $event)"
					/>
					<div class="automation-editor__settings">
						<MCPSessionPicker
							v-model="draft.options.mcp_server_ids"
							:disabled="busy"
							:write-scoped="draft.options.write_project_ids.length > 0"
						/><XButton
							variant="secondary"
							:shadow="false"
							@click="preferencesOpen = true"
						>
							{{ t('automations.executionSettings') }}
						</XButton>
					</div>
					<div class="automation-editor__field">
						<label :for="`${id}-max-runtime`">{{ t('automations.maxRuntime') }}</label>
						<input
							:id="`${id}-max-runtime`"
							v-model.number="runtimeMinutes"
							class="input"
							type="number"
							min="1"
							max="1440"
							required
							:aria-describedby="`${id}-runtime-hint`"
						>
						<small :id="`${id}-runtime-hint`">{{ t('automations.maxRuntimeHint') }}</small>
					</div>
				</details>
				<div class="automation-editor__notifications">
					<div class="automation-editor__check">
						<input
							:id="`${id}-notify-success`"
							v-model="draft.notify_on_success"
							type="checkbox"
						>
						<label :for="`${id}-notify-success`">{{ t('automations.notifySuccess') }}</label>
					</div>
					<div class="automation-editor__check">
						<input
							:id="`${id}-notify-failure`"
							v-model="draft.notify_on_failure"
							type="checkbox"
						>
						<label :for="`${id}-notify-failure`">{{ t('automations.notifyFailure') }}</label>
					</div>
				</div>
			</template>
			<p
				v-else
				class="automation-editor__hint"
			>
				{{ t('automations.reminderChannels') }}
			</p>
		</fieldset>
		<p
			v-if="localError || error"
			class="automation-editor__error"
			role="alert"
		>
			{{ localError || error }}
		</p>
		<p
			v-if="busy"
			class="automation-editor__hint"
			role="status"
		>
			{{ t('automations.savingCanClose') }}
		</p>
		<footer>
			<XButton
				variant="secondary"
				:shadow="false"
				@click="emit('close')"
			>
				{{ t('misc.cancel') }}
			</XButton><XButton
				type="submit"
				:loading="busy"
				:disabled="busy"
			>
				{{ t('misc.save') }}
			</XButton>
		</footer>
		<AssistantPreferences
			v-if="preferencesOpen"
			context="automation"
			:options="draft.options"
			profile=""
			:locked="busy"
			@apply="applyOptions"
			@close="preferencesOpen = false"
		/>
	</form>
</template>

<style lang="scss" scoped>
.automation-editor {
	display: grid;
	gap: var(--space-4);
	inline-size: min(100%, 46rem);
	padding: var(--space-5);
	color: var(--text-primary);

	header p, &__hint {
		color: var(--text-secondary);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}

	fieldset {
		display: grid;
		gap: var(--space-3);
		min-inline-size: 0;
		padding: 0;
		border: 0;
	}

	label, &__field {
		display: grid;
		gap: var(--space-2);
		min-inline-size: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.input, .textarea {
		inline-size: 100%;
		min-block-size: 2.75rem;
		font-size: 1rem;
	}

	textarea {
		resize: vertical;
	}

	&__grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	&__toggle, &__check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-block-size: 2.75rem;
	}

	&__week, &__notifications, &__settings, footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}

	&__week &__check {
		padding-inline: var(--space-2);
	}

	&__capabilities, &__schedule {
		padding: var(--space-3);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
		font-size: var(--text-sm);
	}

	&__capabilities[open] > * + * {
		margin-block-start: var(--space-3);
	}

	summary {
		cursor: pointer;
		line-height: var(--leading-normal);
	}

	&__error {
		color: var(--danger-text);
	}

	footer {
		justify-content: flex-end;
	}

	@media (max-width: $tablet) {
		padding: var(--space-4);

		&__grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
}
</style>
