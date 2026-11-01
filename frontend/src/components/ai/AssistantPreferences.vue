<script setup lang="ts">
import {computed, nextTick, onMounted, onBeforeUnmount, ref, shallowRef, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import {useQuery} from '@tanstack/vue-query'
import {assistantPreferencesQuery, useSaveAssistantPreferences} from '@/client/queries/assistantPreferences'
import {aiSettingsQuery} from '@/client/queries/tcyAi'
import {builtinProfileIDs, normalizeOptions, profileOptions, validOptions, type AssistantOptions} from '@/helpers/assistantProfiles'
import {useProjects} from '@/composables/useProjects'
import {useAronaDisplayPreferences, defaultAronaDisplayPreferences} from '@/composables/useAronaDisplayPreferences'
import type {AssistantPreferences} from '@/client/generated'
const props = defineProps<{options: AssistantOptions, profile: string}>()
const emit = defineEmits<{close: [], apply: [options: AssistantOptions, profile: string]}>()
const {t} = useI18n({useScope: 'global'})
const preferences = useQuery(assistantPreferencesQuery())
const settings = useQuery(aiSettingsQuery())
const save = useSaveAssistantPreferences()
const projectList = useProjects()
// A modal deliberately edits a snapshot; cancel must not change the parent.
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const draft = ref(normalizeOptions(props.options))
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const selected = ref(props.profile)
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const sourceProfile = ref(props.profile.startsWith('custom-') ? props.profile : '')
const name = ref('')
const error = ref('')
const saved = ref(false)
const dialog = ref<HTMLDialogElement>()
const previousFocus = document.activeElement as HTMLElement | null
const custom = computed(() => preferences.data.value?.profiles ?? [])
const unavailable = computed(() => draft.value.write_project_ids.filter(id => !projectList.projectsArray.some(p => p.id === id && !p.is_archived)))
const valid = computed(() => validOptions(draft.value))
const models = computed(() => settings.data.value?.connections.filter(c => c.kind === 'chat') ?? [])
const defaultID = computed(() => preferences.data.value?.default_profile || 'ask')
const optionId = useId()
function choose(id: string) {
	selected.value = id
	const p = custom.value.find(p => p.id === id)
	draft.value = p ? normalizeOptions(p.options) : {...profileOptions(id), connection_id: draft.value.connection_id, project_id: draft.value.project_id}
	name.value = p?.name ?? ''
	sourceProfile.value = p?.id ?? ''
	saved.value = false
	confirmingDelete.value = false
}
function edited() {selected.value = ''; saved.value = false}
// The action that failed. Its retry reloads first: a save that lost to another window then applies the same change
// on top of that window's, instead of failing again or overwriting it.
const failedAction = shallowRef<() => Promise<unknown>>()
async function persist(next: AssistantPreferences, again: () => Promise<unknown>) {
	error.value = ''
	saved.value = false
	failedAction.value = undefined
	try {
		await save.mutateAsync(next)
		saved.value = true
		return true
	} catch {
		error.value = t('assistantUI.saveFailed')
		failedAction.value = again
		return false
	}
}
async function retrySave() {
	const action = failedAction.value
	if (!action || save.isPending.value || preferences.isFetching.value) return
	await preferences.refetch()
	await action()
}
const loadFailed = computed(() => preferences.isError.value && !preferences.data.value)
async function saveTemplate(overwrite = false) {
	if (!name.value.trim() || !valid.value || !preferences.data.value || (!overwrite && custom.value.length >= 20)) return
	const id = overwrite ? sourceProfile.value : `custom-${crypto.randomUUID()}`
	if (overwrite && !custom.value.some(p => p.id === id)) return
	const profile = {id, name: name.value.trim(), options: normalizeOptions(draft.value)}
	const profiles = overwrite ? custom.value.map(p => p.id === id ? profile : p) : [...custom.value, profile]
	if (await persist({...preferences.data.value, profiles}, () => saveTemplate(overwrite))) {
		selected.value = id
		sourceProfile.value = id
	}
}
async function setDefault() {
	if (!selected.value || !preferences.data.value) return
	await persist({...preferences.data.value, default_profile: selected.value}, setDefault)
}
// An account-wide template is gone for every device once deleted, so the button asks first.
const confirmingDelete = ref(false)
const deleteButton = ref<HTMLButtonElement>()
const confirmDeleteButton = ref<HTMLButtonElement>()
const selectedName = computed(() => custom.value.find(p => p.id === selected.value)?.name ?? '')
async function askDelete() {
	confirmingDelete.value = true
	await nextTick()
	confirmDeleteButton.value?.focus()
}
async function cancelDelete() {
	confirmingDelete.value = false
	await nextTick()
	deleteButton.value?.focus()
}
async function removeTemplate() {
	if (save.isPending.value || !selected.value.startsWith('custom-') || !preferences.data.value) return
	const next = {...preferences.data.value, profiles: custom.value.filter(p => p.id !== selected.value)}
	if (next.default_profile === selected.value) next.default_profile = 'ask'
	if (!await persist(next, removeTemplate)) return
	choose('ask')
	// The delete button left with the template; the scenario that is selected now takes the focus.
	await nextTick()
	dialog.value?.querySelector<HTMLButtonElement>('.preset[aria-pressed="true"]')?.focus()
}
// Closes only for a press that started on the backdrop too: a text selection dragged out of a field keeps it open.
let pressedBackdrop = false
// Both listen on the dialog, which is the backdrop's target.
function pressBackdrop(event: MouseEvent) {
	pressedBackdrop = event.target === event.currentTarget
}
function clickBackdrop(event: MouseEvent) {
	if (pressedBackdrop && event.target === event.currentTarget) emit('close')
	pressedBackdrop = false
}
function apply() {
	if (!valid.value || save.isPending.value) return
	emit('apply', normalizeOptions(draft.value), selected.value)
	emit('close')
}
// Display defaults are device-local view settings: they apply at once and never enter the run-option draft.
const {preferences: display, update: updateDisplay, reset: resetDisplay} = useAronaDisplayPreferences()
const displayFields = [
	{key: 'showIntermediate', label: 'aronaDisplay.intermediate', hint: 'aronaDisplay.intermediateHint'},
	{key: 'expandReasoning', label: 'aronaDisplay.reasoning', hint: 'aronaDisplay.reasoningHint'},
	{key: 'expandToolDetails', label: 'aronaDisplay.tools', hint: 'aronaDisplay.toolsHint'},
] as const
type DisplayKey = typeof displayFields[number]['key']
const displayId = useId()
const displayDefault = computed(() => displayFields.every(({key}) => display.value[key] === defaultAronaDisplayPreferences[key]))
const displayNote = ref('')
let displayNoteTimer: ReturnType<typeof setTimeout> | undefined
let displayNoteRequest = 0
// The status region stays mounted; emptying it first makes a repeated message a change that is announced again.
async function noteDisplay(message: string) {
	clearTimeout(displayNoteTimer)
	const request = ++displayNoteRequest
	displayNote.value = ''
	await nextTick()
	if (request !== displayNoteRequest) return
	displayNote.value = message
	displayNoteTimer = setTimeout(() => { displayNote.value = '' }, 3000)
}
function setDisplay(key: DisplayKey, value: boolean) {
	const patch: Partial<Record<DisplayKey, boolean>> = {}
	patch[key] = value
	updateDisplay(patch)
	noteDisplay(t('aronaDisplay.saved'))
}
// aria-disabled instead of disabled keeps keyboard focus on the button after restoring.
function restoreDisplay() {
	if (displayDefault.value) return
	resetDisplay()
	noteDisplay(t('aronaDisplay.restored'))
}
onMounted(() => {name.value = custom.value.find(p => p.id === sourceProfile.value)?.name ?? ''; dialog.value?.showModal()})
onBeforeUnmount(() => {clearTimeout(displayNoteTimer); displayNoteRequest++; dialog.value?.close(); previousFocus?.focus()})
</script>

<template>
	<Teleport to="body">
		<dialog
			ref="dialog"
			class="assistant-preferences"
			:aria-label="t('assistantUI.preferences')"
			@cancel.prevent="emit('close')"
			@mousedown="pressBackdrop"
			@click="clickBackdrop"
		>
			<form
				class="preferences-body"
				@submit.prevent="apply"
			>
				<header>
					<div><h2>{{ t('assistantUI.preferences') }}</h2><p>{{ t('assistantUI.nextRequest') }}</p></div><button
						type="button"
						class="plain-button close-button"
						:aria-label="t('misc.close')"
						@click="emit('close')"
					>
						<Icon icon="times" />
					</button>
				</header>
				<div class="preferences-scroll">
					<section :aria-label="t('assistantUI.scenarios')">
						<h3>{{ t('assistantUI.scenarios') }}</h3>
						<div class="preset-grid">
							<button
								v-for="id in builtinProfileIDs"
								:key="id"
								type="button"
								class="preset"
								:class="{selected: selected === id}"
								:aria-pressed="selected === id"
								@click="choose(id)"
							>
								<strong>{{ t(`assistantUI.presets.${id}.name`) }}</strong><span>{{ t(`assistantUI.presets.${id}.description`) }}</span><small v-if="defaultID === id">{{ t('assistantUI.default') }}</small>
							</button>
						</div>
						<label v-if="custom.length">{{ t('assistantUI.myTemplates') }}<select
							class="input"
							:value="selected.startsWith('custom-') ? selected : ''"
							@change="choose(($event.target as HTMLSelectElement).value)"
						><option
							value=""
							disabled
						>{{ t('assistantUI.chooseTemplate') }}</option><option
							v-for="p in custom"
							:key="p.id"
							:value="p.id"
						>{{ p.name }}{{ defaultID === p.id ? ` · ${t('assistantUI.default')}` : '' }}</option></select></label>
						<div class="template-actions">
							<button
								type="button"
								:disabled="!selected || save.isPending.value || preferences.isPending.value"
								@click="setDefault"
							>
								{{ t('assistantUI.makeDefault') }}
							</button><button
								v-if="selected.startsWith('custom-') && !confirmingDelete"
								ref="deleteButton"
								type="button"
								:disabled="save.isPending.value"
								@click="askDelete"
							>
								{{ t('assistantUI.deleteTemplate') }}
							</button>
						</div>
						<div
							v-if="confirmingDelete"
							class="delete-confirm"
							role="group"
							:aria-label="t('assistantUI.deleteTemplate')"
						>
							<span>{{ t('assistantUI.deleteTemplateConfirm', {name: selectedName}) }}</span><button
								ref="confirmDeleteButton"
								type="button"
								class="danger-button"
								:aria-disabled="save.isPending.value"
								@click="removeTemplate"
							>
								{{ t('assistantUI.deleteTemplateYes') }}
							</button><button
								type="button"
								@click="cancelDelete"
							>
								{{ t('misc.cancel') }}
							</button>
						</div>
						<p class="help">
							{{ t('assistantUI.defaultHelp') }}
						</p>
					</section>
					<section
						class="option-grid"
						@input="edited"
						@change="edited"
					>
						<label>{{ t('chat.model') }}<select
							v-model="draft.connection_id"
							class="input"
						><option value="">{{ t('chat.defaultModel') }}</option><option
							v-for="c in models"
							:key="c.id"
							:value="c.id"
						>{{ c.name }} · {{ c.model }}</option><option
							v-if="draft.connection_id && !models.some(c => c.id === draft.connection_id)"
							:value="draft.connection_id"
						>{{ t('assistantUI.missingModel') }} · {{ draft.connection_id }}</option></select></label>
						<label>{{ t('tcymc.text.current_project') }}<select
							v-model.number="draft.project_id"
							class="input"
						><option :value="0">{{ t('tcymc.text.all_accessible_projects') }}</option><option
							v-for="p in projectList.projectsArray.filter(p => p.id > 0 && !p.is_archived)"
							:key="p.id"
							:value="p.id"
						>{{ p.title }}</option><option
							v-if="draft.project_id && !projectList.projectsArray.some(p => p.id === draft.project_id && !p.is_archived)"
							:value="draft.project_id"
						>#{{ draft.project_id }} · {{ t('assistantUI.unavailableProject') }}</option></select><small>{{ t('assistantUI.contextHelp') }}</small></label>
						<label>{{ t('tcymc.text.working_mode') }}<select
							v-model="draft.mode"
							class="input"
							@change="draft.mode === 'read' && (draft.allow_delete = false)"
						><option value="read">{{ t('tcymc.text.read_only_look_up_tasks_and_suggest_changes') }}</option><option value="write">{{ t('tcymc.text.execute_allow_creation_and_changes') }}</option></select><small>{{ t('assistantUI.modeHelp') }}</small></label>
						<label>{{ t('agent.approvalPolicy') }}<select
							v-model="draft.approval"
							class="input"
							:disabled="draft.mode === 'read'"
						><option value="smart">{{ t('agent.smart') }}</option><option value="review">{{ t('agent.reviewAll') }}</option><option value="auto">{{ t('agent.auto') }}</option></select><small>{{ t(`assistantUI.approval_${draft.approval}`) }}</small></label>
						<label class="checkbox"><input
							v-model="draft.allow_delete"
							type="checkbox"
							:disabled="draft.mode === 'read'"
						>{{ t('tcymc.text.allow_task_deletion_for_this_request') }}</label>
						<fieldset
							class="project-scope"
							:disabled="draft.mode === 'read'"
						>
							<legend>{{ t('agent.writeScope') }}</legend><p class="help">
								{{ t('agent.scopeHelp') }}
							</p><div class="project-checks">
								<label
									v-for="p in projectList.projectsArray.filter(p => p.id > 0 && !p.is_archived)"
									:key="p.id"
									class="checkbox"
								><input
									v-model="draft.write_project_ids"
									type="checkbox"
									:value="p.id"
								>{{ p.title }}</label><label
									v-for="id in unavailable"
									:key="id"
									class="checkbox"
								><input
									v-model="draft.write_project_ids"
									type="checkbox"
									:value="id"
								>#{{ id }} · {{ t('assistantUI.unavailableProject') }}</label>
							</div>
						</fieldset>
						<div class="option-switch">
							<label class="checkbox"><input
								v-model="draft.enable_subagents"
								type="checkbox"
								:aria-describedby="`${optionId}-subagents`"
							>{{ t('assistantUI.subagents') }}<span class="experimental-tag">{{ t('assistantUI.experimental') }}</span></label><small :id="`${optionId}-subagents`">{{ t('assistantUI.subagentsHelp') }}</small>
						</div>
					</section>
					<details class="advanced">
						<summary>{{ t('assistantUI.advanced') }}</summary><p class="help">
							{{ t('assistantUI.segmentHelp') }}
						</p><div
							class="option-grid"
							@input="edited"
						>
							<label
								v-for="field in (['max_rounds', 'max_operations', 'timeout_seconds', 'token_budget'] as const)"
								:key="field"
							>{{ t(`assistantUI.${field}`) }}<input
								v-model.number="draft[field]"
								class="input"
								type="number"
								required
								step="1"
								:min="field === 'token_budget' ? 0 : 1"
								:max="{max_rounds: 40, max_operations: 100, timeout_seconds: 600, token_budget: 1000000}[field]"
							><small>{{ t(`assistantUI.${field}Help`) }}</small></label>
							<div class="option-switch">
								<label class="checkbox"><input
									v-model="draft.stop_at_segment_limit"
									type="checkbox"
									:aria-describedby="`${optionId}-segments`"
								>{{ t('assistantUI.stopAtSegmentLimit') }}</label><small :id="`${optionId}-segments`">{{ t('assistantUI.stopAtSegmentLimitHelp') }}</small>
							</div>
						</div>
					</details>
					<section class="save-template">
						<label>{{ t('assistantUI.templateName') }}<input
							v-model="name"
							class="input"
							maxlength="80"
							:placeholder="t('assistantUI.nameExample')"
						></label><button
							type="button"
							:disabled="!name.trim() || !valid || custom.length >= 20 || preferences.isPending.value || save.isPending.value"
							@click="saveTemplate(false)"
						>
							{{ t('assistantUI.saveTemplate') }}
						</button><button
							v-if="sourceProfile && custom.some(p => p.id === sourceProfile)"
							type="button"
							:disabled="!name.trim() || !valid || save.isPending.value"
							@click="saveTemplate(true)"
						>
							{{ t('assistantUI.updateTemplate') }}
						</button><small>{{ t('assistantUI.templateHelp') }}</small>
					</section>
					<p
						v-if="saved"
						role="status"
					>
						{{ t('assistantUI.saved') }}
					</p><p
						v-if="error"
						role="alert"
					>
						{{ error }} <button
							v-if="failedAction"
							type="button"
							:aria-disabled="save.isPending.value || preferences.isFetching.value"
							@click="retrySave"
						>
							{{ t('chat.retry') }}
						</button>
					</p><p
						v-else-if="loadFailed"
						role="alert"
					>
						{{ t('assistantUI.loadFailed') }} <button
							type="button"
							@click="preferences.refetch()"
						>
							{{ t('chat.retry') }}
						</button>
					</p>
					<!-- Outside the option sections so toggling never fires edited() or resets the selected scenario. -->
					<section
						class="display-preferences"
						:aria-label="t('aronaDisplay.title')"
					>
						<h3>{{ t('aronaDisplay.title') }}</h3>
						<p class="help">
							{{ t('aronaDisplay.help') }}
						</p>
						<div class="display-options">
							<div
								v-for="f in displayFields"
								:key="f.key"
								class="display-option"
							>
								<label class="checkbox"><input
									type="checkbox"
									:checked="display[f.key]"
									:aria-describedby="`${displayId}-${f.key}`"
									@change="setDisplay(f.key, ($event.target as HTMLInputElement).checked)"
								>{{ t(f.label) }}</label><small :id="`${displayId}-${f.key}`">{{ t(f.hint) }}</small>
							</div>
						</div>
						<div class="display-actions">
							<button
								type="button"
								:aria-disabled="displayDefault"
								@click="restoreDisplay"
							>
								{{ t('aronaDisplay.reset') }}
							</button><span
								class="display-status"
								role="status"
							>{{ displayNote }}</span>
						</div>
					</section>
				</div>
				<footer>
					<RouterLink
						:to="{name: 'user.settings.ai'}"
						@click="emit('close')"
					>
						{{ t('tcymc.text.ai_and_voice_settings') }}
					</RouterLink><button
						type="button"
						@click="emit('close')"
					>
						{{ t('misc.cancel') }}
					</button><button
						class="apply-button"
						type="submit"
						:disabled="!valid || save.isPending.value"
					>
						{{ t('assistantUI.apply') }}
					</button>
				</footer>
			</form>
		</dialog>
	</Teleport>
</template>

<style scoped lang="scss">
.assistant-preferences {
	inline-size: min(44rem, calc(100vw - 2rem));
	max-block-size: calc(100dvh - 2rem);
	padding: 0;
	overflow: hidden;
	overscroll-behavior: contain;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);
	font-family: var(--font-ui);

	&::backdrop {
		background: var(--scrim);
	}
}

.preferences-body {
	display: flex;
	flex-direction: column;
	max-block-size: calc(100dvh - 2rem - 2px);
	padding: 0;
}

.preferences-scroll {
	flex: 1;
	min-block-size: 0;
	padding: 0 var(--space-6) var(--space-4);
	overflow-y: auto;
	overscroll-behavior: contain;
}

header {
	display: flex;
	flex-shrink: 0;
	justify-content: space-between;
	gap: var(--space-4);
	padding: var(--space-5) var(--space-6) var(--space-2);
}

h2 {
	margin: 0 0 var(--space-1);
	font-size: var(--text-xl);
	font-weight: var(--weight-semibold);
}

h3 {
	margin: 0 0 var(--space-3);
	font-size: var(--text-base);
	font-weight: var(--weight-semibold);
}

header p,
.help,
small {
	color: var(--text-tertiary);
	font-size: var(--text-sm);
	font-weight: var(--weight-regular);
	line-height: var(--leading-normal);
}

section,
.advanced {
	margin-block: var(--space-5);
}

label {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	min-inline-size: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.input {
	font-weight: var(--weight-regular);
}

.checkbox {
	flex-direction: row;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-regular);
}

legend {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

button {
	min-block-size: var(--control-height);
	padding: 0 var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: $radius;
	background: var(--surface);
	color: var(--text-primary);
	font: inherit;
	font-size: var(--text-md);
	cursor: pointer;

	&:hover:not(:disabled, [aria-disabled='true']) {
		background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
	}

	&:focus-visible {
		@include focus-ring;
	}

	&:disabled,
	&[aria-disabled='true'] {
		opacity: .45;
		cursor: not-allowed;
	}
}

.preset-grid,
.option-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-3);
}

.preset {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding: var(--space-3);
	border-color: var(--border-subtle);
	border-radius: var(--radius-md);
	text-align: start;

	strong {
		font-weight: var(--weight-semibold);
	}

	span {
		color: var(--text-secondary);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}

	small {
		color: var(--accent-text);
		font-weight: var(--weight-semibold);
	}

	&.selected {
		border-color: var(--primary);
		background: var(--surface-selected);

		strong {
			color: var(--accent-text);
		}
	}
}

.template-actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin-block-start: var(--space-3);
}

.delete-confirm {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	margin-block-start: var(--space-2);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);

	span {
		flex: 1 1 14rem;
	}
}

.danger-button {
	border-color: var(--danger);
	color: var(--danger-text);
}

.project-scope {
	grid-column: 1 / -1;
	padding: 0;
	border: 0;
}

.project-checks {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2) var(--space-5);
	max-block-size: 10rem;
	overflow-y: auto;
}

.option-switch {
	grid-column: 1 / -1;
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	min-inline-size: 0;

	.checkbox {
		flex-wrap: wrap;
	}
}

.experimental-tag {
	padding: 0 var(--space-2);
	border-radius: var(--radius-full);
	background: var(--tint-warning);
	color: var(--text-primary);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	line-height: var(--leading-normal);
	white-space: nowrap;
}

.advanced {
	padding-block: var(--space-3);
	border-block: 1px solid var(--border-subtle);
}

summary {
	color: var(--text-primary);
	font-weight: var(--weight-semibold);
	cursor: pointer;
}

.save-template {
	display: flex;
	flex-wrap: wrap;
	align-items: end;
	gap: var(--space-3);

	label {
		flex: 1;
	}

	small {
		flex-basis: 100%;
	}
}

.display-preferences {
	padding-block-start: var(--space-5);
	border-block-start: 1px solid var(--border-subtle);

	.help {
		margin-block: 0 var(--space-3);
	}
}

.display-options,
.display-option {
	display: flex;
	flex-direction: column;
	min-inline-size: 0;
}

.display-options {
	gap: var(--space-3);
}

.display-option {
	gap: var(--space-1);
}

.display-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	margin-block-start: var(--space-4);
}

[role='alert'] {
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-md);
}

[role='status'] {
	color: var(--text-secondary);
	font-size: var(--text-md);
}

footer {
	display: flex;
	flex-shrink: 0;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-3) var(--space-6);
	border-block-start: 1px solid var(--border-subtle);
	background: var(--surface-sunken);

	a {
		margin-inline-end: auto;
		font-size: var(--text-sm);
	}
}

.apply-button {
	border-color: transparent;
	background: var(--primary);
	color: var(--text-on-accent);
	font-weight: var(--weight-semibold);
}

.close-button {
	align-self: start;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	inline-size: var(--control-height);
	padding: 0;
	border-color: transparent;
	background: transparent;
	color: var(--text-secondary);
}

@media (width <= 540px) {
	.option-grid,
	.preset-grid {
		grid-template-columns: 1fr;
	}

	.preferences-scroll {
		padding-inline: var(--space-4);
	}

	header,
	footer {
		padding-inline: var(--space-4);
	}

	footer a {
		flex-basis: 100%;
	}
}

@media (pointer: coarse) {
	.display-preferences {
		.checkbox,
		button {
			min-block-size: var(--target-min);
		}
	}

	.option-switch .checkbox {
		min-block-size: var(--target-min);
	}
}
</style>
