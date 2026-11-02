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
				<div class="calendar-create__dates">
					<label
						v-for="field in dateFields"
						:key="field"
					>
						{{ t(`calendar.create.${field}`) }}
						<span
							v-if="field === 'due'"
							class="calendar-create__optional"
						>{{ t('calendar.create.optional') }}</span>
						<input
							v-model="dates[field]"
							class="input"
							type="datetime-local"
							:required="field !== 'due'"
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
import UnsavedLeaveDialog from '@/components/misc/UnsavedLeaveDialog.vue'
import {useProjects} from '@/composables/useProjects'
import {useUnsavedLeaveGuard} from '@/composables/useUnsavedLeaveGuard'
import {useCreateTaskMutation} from '@/client/queries/taskMutations'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {PERMISSIONS} from '@/constants/permissions'
import {resolveCalendarWallTime} from '@/helpers/calendar'

const props = defineProps<{
	date: string
	timezone: string
	projectId?: number
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
// Each mounted dialog owns one draft; later parent changes must not overwrite it.
const initialProject = () => props.projectId ?? 0
const selectedProjectId = ref(initialProject())
watch(projects, available => {
	if (!available.some(project => project.id === selectedProjectId.value)) selectedProjectId.value = available[0]?.id ?? 0
}, {immediate: true})
const dateFields = ['start', 'end', 'due'] as const
type DateField = typeof dateFields[number]
const initialDates = () => ({
	start: `${props.date}T09:00`,
	end: `${props.date}T10:00`,
	due: '',
})
const initial = initialDates()
const dates = reactive({...initial})
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
const dirty = computed(() => !completed.value && (title.value !== '' || dateFields.some(field => dates[field] !== initial[field])))
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
	const start = instant('start')
	const end = instant('end')
	const due = instant('due')
	if (validation.value || !start || !end) return
	if (Date.parse(end) <= Date.parse(start)) {
		validation.value = t('calendar.create.invalidRange')
		return
	}
	saving.value = true
	try {
		const task = await createTask.mutateAsync({
			title: title.value.trim(),
			project_id: selectedProjectId.value,
			start_date: start,
			end_date: end,
			...(due ? {due_date: due} : {}),
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
	background: var(--card-background-color);
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
