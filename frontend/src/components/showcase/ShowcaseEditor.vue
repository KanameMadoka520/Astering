<script setup lang="ts">
import {computed, ref, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import {onBeforeRouteLeave, onBeforeRouteUpdate, useRouter, type RouteLocationNormalized} from 'vue-router'
import {useEventListener} from '@vueuse/core'
import {useProjects} from '@/composables/useProjects'
import {
	normalizeDraft,
	usePreviewShowcase,
	usePublishShowcase,
	useSaveShowcase,
	useUnpublishShowcase,
} from '@/client/queries/tcyShowcase'
import type {TcyShowcasePreviewResponse, TcyShowcaseSettingsResponse} from '@/client/generated'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {getFullBaseUrl} from '@/helpers/getFullBaseUrl'
import {useConfigStore} from '@/stores/config'
import ShowcasePage from './ShowcasePage.vue'

const props = defineProps<{initial: TcyShowcaseSettingsResponse}>()
const {t} = useI18n({useScope: 'global'})

function seed() { return normalizeDraft(props.initial.draft) }
const draft = ref(seed())
// The draft as last saved or published. Only that copy is safe to leave; nothing is kept on the device.
const savedFingerprint = ref(JSON.stringify(seed()))
const dirty = computed(() => JSON.stringify(draft.value) !== savedFingerprint.value)
const router = useRouter()
const configStore = useConfigStore()
const projectList = useProjects()
const save = useSaveShowcase()
const previewMutation = usePreviewShowcase()
const publish = usePublishShowcase()
const unpublish = useUnpublishShowcase()
const preview = ref<TcyShowcasePreviewResponse>()
const previewFingerprint = ref('')
const selectedProject = ref(0)
const slugId = useId()
const slugHelpId = useId()
const publishHintId = useId()
const busy = computed(() => save.isPending.value
	|| previewMutation.isPending.value
	|| publish.isPending.value
	|| unpublish.isPending.value)
const readyToPublish = computed(() => Boolean(preview.value) && previewFingerprint.value === JSON.stringify(draft.value))
const publishHint = computed(() => {
	if (!preview.value) return t('tcymc.text.preview_to_enable_publishing')
	return readyToPublish.value ? '' : t('tcymc.text.the_draft_has_changed_preview_it_again_before')
})
const publicSlug = computed(() => props.initial.published?.slug ?? draft.value.slug)
// Built like the other shared links: the configured frontend address (or this app's base path) and the API root, so
// sub-path installs, the desktop app and a separate API host all hand out working addresses.
const frontendBase = computed(() => {
	const base = configStore.frontend_url || new URL(getFullBaseUrl(), window.location.origin).href
	return base.endsWith('/') ? base : `${base}/`
})
const publicURL = computed(() => `${frontendBase.value}p/${publicSlug.value}`)
const jsonURL = computed(() => `${configStore.apiBase}/api/v2/public/${publicSlug.value}`)
const weekdays = computed(() => [
	t('tcymc.text.sun'),
	t('tcymc.text.mon'),
	t('tcymc.text.tue'),
	t('tcymc.text.wed'),
	t('tcymc.text.thu'),
	t('tcymc.text.fri'),
	t('tcymc.text.sat'),
])
const selectableProjects = computed(() => projectList.projectsArray.filter(project => project.id > 0 && !project.is_archived))

// Without the project list nothing can be added, and saved rules can't be named yet.
const projectsFailed = computed(() => projectList.isError && projectList.projectsArray.length === 0)

function projectTitle(id: number) {
	const project = projectList.projectsArray.find(candidate => candidate.id === id)
	if (project) return project.title
	return projectList.isLoading ? t('misc.loading') : t('tcymc.projectID', {id})
}

function addProject() {
	if (!selectedProject.value || draft.value.projects.some(p => p.id === selectedProject.value)) return
	draft.value.projects.push({id: selectedProject.value, alias: '', mode: 'busy'})
}

function removeProject(id: number) {
	draft.value.projects = draft.value.projects.filter(p => p.id !== id)
}

function taskRule(id: number) {
	let rule = draft.value.tasks.find(t => t.id === id)
	if (!rule) { rule = {id, alias: '', hidden: false}; draft.value.tasks.push(rule) }
	return rule
}

async function showPreview() {
	if (busy.value) return
	try {
		const current = JSON.stringify(draft.value)
		preview.value = await previewMutation.mutateAsync(JSON.parse(current))
		previewFingerprint.value = current
	} catch { return }
}

async function saveDraft() {
	if (busy.value) return
	const sent = JSON.stringify(draft.value)
	try { await save.mutateAsync(JSON.parse(sent)) } catch { return }
	savedFingerprint.value = sent
}

async function publishDraft() {
	if (busy.value || !readyToPublish.value) return
	const sent = JSON.stringify(draft.value)
	try { await publish.mutateAsync(JSON.parse(sent)) } catch { return }
	savedFingerprint.value = sent
}

// Taking the page down is immediate for friends and bots and discards the published version, so it asks first.
const showTakeDown = ref(false)

async function takeDown() {
	if (busy.value) return
	try { await unpublish.mutateAsync() } catch { return }
	showTakeDown.value = false
}

// The template replaces the whole body and its format; a written body is only replaced after asking.
const showTemplateConfirm = ref(false)

function requestTemplate() {
	if (draft.value.content.trim() === '') {
		insertTemplate()
		return
	}
	showTemplateConfirm.value = true
}

function insertTemplate() {
	draft.value.content = t('tcymc.text.welcome_to_my_schedule_here_are_the_plans')
	draft.value.format = 'markdown'
	showTemplateConfirm.value = false
}

// Leaving with unsaved changes asks first; the route is only followed after an explicit discard.
const leaveTarget = ref<string | null>(null)
let leaving = false

function confirmLeave(to: RouteLocationNormalized) {
	if (leaving || !dirty.value) return true
	leaveTarget.value = to.fullPath
	return false
}

onBeforeRouteLeave(confirmLeave)
onBeforeRouteUpdate(confirmLeave)

async function discardAndLeave() {
	const target = leaveTarget.value
	if (target === null) return
	leaving = true
	leaveTarget.value = null
	const failure = await router.push(target)
	// Another guard stopped the navigation: the draft is still here and still protected.
	if (failure) leaving = false
}

useEventListener(window, 'beforeunload', (event: BeforeUnloadEvent) => {
	if (!dirty.value) return
	event.preventDefault()
	// Older browsers only ask when a return value is set.
	event.returnValue = ''
})
</script>

<template>
	<div class="showcase-editor">
		<PageHeader
			:title="t('tcymc.text.public_page')"
			:description="t('tcymc.text.share_a_separate_public_schedule_with_friends_and')"
		/>
		<div
			class="publication"
			:class="{'is-published': initial.published}"
			data-tour="showcase-status"
		>
			<span class="publication-state">
				<span
					class="publication-dot"
					aria-hidden="true"
				/>
				<strong>{{ initial.published ? t('tcymc.text.published') : t('tcymc.text.not_published') }}</strong>
			</span>
			<template v-if="initial.published">
				<a
					:href="publicURL"
					target="_blank"
					rel="noopener noreferrer"
				>{{ t('tcymc.text.view_public_page') }}</a>
				<a
					:href="jsonURL"
					target="_blank"
					rel="noopener noreferrer"
				>{{ t('tcymc.text.json_endpoint_for_bots') }}</a>
				<XButton
					variant="secondary"
					class="is-small publication-take-down"
					danger
					:shadow="false"
					:aria-disabled="busy || undefined"
					@click="showTakeDown = true"
				>
					{{ t('tcymc.text.take_down_page') }}
				</XButton>
			</template>
		</div>
		<div class="editor-layout">
			<div class="editor-panels">
				<section class="editor-panel">
					<h2 data-tour="showcase-hours">
						<Icon icon="calendar" />
						{{ t('tcymc.text.page_and_available_hours') }}
					</h2>
					<div class="fields">
						<div class="field is-wide">
							<label
								:for="slugId"
								class="field-label"
							>{{ t('tcymc.text.page_address') }}</label>
							<input
								:id="slugId"
								v-model="draft.slug"
								class="input"
								pattern="[a-z0-9][a-z0-9-]{2,47}"
								:placeholder="t('tcymc.text.for_example_tcy')"
								:aria-describedby="slugHelpId"
							>
							<small
								:id="slugHelpId"
								class="help"
							>/p/{{ draft.slug || 'your-name' }} {{ t('tcymc.text.3_48_lowercase_letters_numbers_or_hyphens') }}</small>
						</div>
						<label class="field is-wide">
							<span class="field-label">{{ t('tcymc.text.page_title') }}</span>
							<input
								v-model="draft.title"
								class="input"
								maxlength="100"
							>
						</label>
						<label class="field">
							<span class="field-label">{{ t('tcymc.text.days_to_show') }}</span>
							<input
								v-model.number="draft.days"
								class="input"
								type="number"
								min="1"
								max="31"
							>
						</label>
						<label class="field">
							<span class="field-label">{{ t('tcymc.text.daily_start_hour') }}</span>
							<input
								v-model.number="draft.start_hour"
								class="input"
								type="number"
								min="0"
								max="23"
							>
						</label>
						<label class="field">
							<span class="field-label">{{ t('tcymc.text.daily_end_hour') }}</span>
							<input
								v-model.number="draft.end_hour"
								class="input"
								type="number"
								min="1"
								max="24"
							>
						</label>
					</div>
					<label class="field">
						<span class="field-label">{{ t('tcymc.text.about_me') }}</span>
						<textarea
							v-model="draft.intro"
							class="textarea"
							rows="2"
							maxlength="500"
						/>
					</label>
					<fieldset class="weekdays">
						<legend class="field-label">
							{{ t('tcymc.text.available_weekdays') }}
						</legend>
						<label
							v-for="(day, index) in weekdays"
							:key="index"
							class="weekday"
						>
							<input
								v-model="draft.weekdays"
								type="checkbox"
								:value="index"
							>
							<span>{{ day }}</span>
						</label>
					</fieldset>
					<p class="help">
						{{ t('tcymc.text.times_use_asia_shanghai_only_tasks_with_start') }}
					</p>
				</section>
				<section class="editor-panel">
					<h2 data-tour="showcase-projects">
						<Icon icon="eye" />
						{{ t('tcymc.text.projects_to_publish') }}
					</h2>
					<p class="panel-description">
						{{ t('tcymc.text.projects_not_added_here_stay_private_by_default') }}
					</p>
					<LoadError
						v-if="projectsFailed"
						:message="t('tcymc.showcase.projectsError')"
						:retry="() => projectList.refetch()"
					/>
					<div
						v-else
						class="inline-actions"
					>
						<div
							class="select"
							:class="{'is-loading': projectList.isLoading}"
						>
							<select
								v-model.number="selectedProject"
								:aria-label="t('tcymc.text.select_a_project')"
								:aria-busy="projectList.isLoading || undefined"
							>
								<option :value="0">
									{{ projectList.isLoading ? t('tcymc.showcase.projectsLoading') : t('tcymc.text.select_a_project') }}
								</option>
								<option
									v-for="project in selectableProjects"
									:key="project.id"
									:value="project.id"
								>
									{{ project.title }}
								</option>
							</select>
						</div>
						<XButton
							variant="secondary"
							icon="plus"
							:shadow="false"
							@click="addProject"
						>
							{{ t('tcymc.text.add_project_rule') }}
						</XButton>
					</div>
					<ul
						v-if="draft.projects.length"
						class="rule-list"
					>
						<li
							v-for="rule in draft.projects"
							:key="rule.id"
							class="project-rule"
						>
							<strong class="rule-name">{{ projectTitle(rule.id) }}</strong>
							<label class="field rule-alias">
								<span class="field-label">{{ t('tcymc.text.public_name') }}</span>
								<input
									v-model="rule.alias"
									class="input"
									:placeholder="t('tcymc.text.leave_blank_to_show_private_project')"
								>
							</label>
							<label class="field rule-mode">
								<span class="field-label">{{ t('tcymc.text.visibility') }}</span>
								<span class="select">
									<select v-model="rule.mode">
										<option value="busy">{{ t('tcymc.text.show_busy_times_without_task_names') }}</option>
										<option value="titles">{{ t('tcymc.text.show_task_titles_with_optional_public_names_below') }}</option>
										<option value="hidden">{{ t('tcymc.text.hide_completely_and_exclude_from_availability') }}</option>
									</select>
								</span>
							</label>
							<XButton
								variant="tertiary"
								class="rule-remove"
								:shadow="false"
								@click="removeProject(rule.id)"
							>
								{{ t('tcymc.text.remove') }}
							</XButton>
						</li>
					</ul>
				</section>
				<section class="editor-panel">
					<h2 data-tour="showcase-content">
						<Icon icon="code" />
						{{ t('tcymc.text.custom_markdown_or_html') }}
					</h2>
					<label class="check">
						<input
							v-model="draft.custom_layout"
							type="checkbox"
						>
						<span>{{ t('tcymc.text.use_a_custom_page_body_and_hide_the') }}</span>
					</label>
					<div class="inline-actions">
						<div class="select">
							<select
								v-model="draft.format"
								:aria-label="t('tcymc.text.content_format')"
							>
								<option value="markdown">
									Markdown
								</option>
								<option value="html">
									{{ t('tcymc.text.static_html_with_optional_css') }}
								</option>
							</select>
						</div>
						<XButton
							variant="secondary"
							:shadow="false"
							@click="requestTemplate"
						>
							{{ t('tcymc.text.insert_schedule_template') }}
						</XButton>
					</div>
					<textarea
						v-model="draft.content"
						class="textarea template-editor"
						rows="10"
						maxlength="80000"
						:aria-label="t('tcymc.text.custom_markdown_or_html')"
						:placeholder="t('tcymc.text.write_an_introduction_or_insert_your_public_schedule')"
					/>
					<p
						class="help"
						v-text="t('tcymc.placeholderHelp', {schedule: '{{schedule}}', availability: '{{availability}}', projects: '{{projects}}'})"
					/>
				</section>
				<section
					v-if="preview?.sources?.length"
					class="editor-panel"
				>
					<h2>{{ t('tcymc.text.public_names_and_visibility_for_individual_tasks') }}</h2>
					<p class="panel-description">
						{{ t('tcymc.text.original_names_below_are_only_visible_to_you') }}
					</p>
					<div class="rule-list">
						<div
							v-for="task in preview.sources"
							:key="task.id"
							class="task-rule"
							role="group"
							:aria-label="task.title"
						>
							<strong class="rule-name">{{ task.title }}</strong>
							<input
								class="input"
								:value="draft.tasks.find(t => t.id === task.id)?.alias ?? ''"
								:aria-label="t('tcymc.text.public_name')"
								:placeholder="t('tcymc.text.public_name_leave_blank_to_use_project_rules')"
								@input="taskRule(task.id!).alias = ($event.target as HTMLInputElement).value"
							>
							<label class="check">
								<input
									type="checkbox"
									:checked="draft.tasks.find(t => t.id === task.id)?.hidden ?? false"
									@change="taskRule(task.id!).hidden = ($event.target as HTMLInputElement).checked"
								>
								<span>{{ t('tcymc.text.hide_completely') }}</span>
							</label>
						</div>
					</div>
				</section>
			</div>
			<div class="editor-actions">
				<p
					v-if="dirty"
					class="editor-unsaved"
					role="status"
				>
					{{ t('tcymc.showcase.unsaved') }}
				</p>
				<XButton
					variant="secondary"
					icon="save"
					:shadow="false"
					:loading="save.isPending.value"
					:aria-disabled="busy || undefined"
					@click="saveDraft"
				>
					{{ t('tcymc.text.save_draft') }}
				</XButton>
				<XButton
					variant="secondary"
					icon="eye"
					:shadow="false"
					:loading="previewMutation.isPending.value"
					:aria-disabled="busy || undefined"
					data-tour="showcase-preview"
					@click="showPreview"
				>
					{{ t('tcymc.text.preview_public_page') }}
				</XButton>
				<XButton
					variant="primary"
					icon="globe"
					:loading="publish.isPending.value"
					:aria-disabled="busy || !readyToPublish || undefined"
					:aria-describedby="publishHint ? publishHintId : undefined"
					data-tour="showcase-publish"
					@click="publishDraft"
				>
					{{ t('tcymc.text.publish_this_preview') }}
				</XButton>
				<p
					v-if="publishHint"
					:id="publishHintId"
					class="publish-hint"
				>
					{{ publishHint }}
				</p>
				<p class="help">
					{{ t('tcymc.text.preview_before_publishing_the_schedule_stays_up_to') }}
				</p>
			</div>
		</div>
		<section
			v-if="preview?.page"
			class="preview-panel"
		>
			<h2>{{ t('tcymc.text.what_visitors_will_see') }}</h2>
			<p
				v-if="!readyToPublish"
				class="preview-stale"
			>
				{{ t('tcymc.text.the_draft_has_changed_preview_it_again_before') }}
			</p>
			<ShowcasePage
				embedded
				:page="preview.page"
			/>
		</section>

		<Modal
			:enabled="showTakeDown"
			:loading="unpublish.isPending.value"
			:confirm-label="t('tcymc.text.take_down_page')"
			danger
			@close="showTakeDown = false"
			@submit="takeDown()"
		>
			<template #header>
				<span>{{ t('tcymc.showcase.takeDownTitle') }}</span>
			</template>
			<template #text>
				<p>{{ t('tcymc.showcase.takeDownText') }}</p>
			</template>
		</Modal>

		<Modal
			:enabled="showTemplateConfirm"
			:confirm-label="t('tcymc.showcase.templateConfirm')"
			@close="showTemplateConfirm = false"
			@submit="insertTemplate()"
		>
			<template #header>
				<span>{{ t('tcymc.showcase.templateTitle') }}</span>
			</template>
			<template #text>
				<p>{{ t('tcymc.showcase.templateText') }}</p>
			</template>
		</Modal>

		<Modal
			:enabled="leaveTarget !== null"
			:aria-label="t('tcymc.showcase.leaveTitle')"
			@close="leaveTarget = null"
		>
			<Card
				:title="t('tcymc.showcase.leaveTitle')"
				:shadow="false"
				:padding="false"
				:show-close="true"
				class="showcase-leave has-text-start"
				@close="leaveTarget = null"
			>
				<p class="showcase-leave__text">
					{{ t('tcymc.showcase.leaveText') }}
				</p>
				<template #footer>
					<XButton
						variant="secondary"
						:shadow="false"
						@click="leaveTarget = null"
					>
						{{ t('compass.settings.leave.stay') }}
					</XButton>
					<XButton
						variant="primary"
						danger
						:shadow="false"
						@click="discardAndLeave"
					>
						{{ t('compass.settings.leave.discard') }}
					</XButton>
				</template>
			</Card>
		</Modal>
	</div>
</template>

<style scoped lang="scss">
.showcase-editor {
	container: showcase-editor / inline-size;
	display: grid;
	gap: var(--space-4);
}

.publication {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-4);
	padding: var(--space-2) var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	font-size: var(--text-md);

	a {
		color: var(--accent-text);
		font-weight: var(--weight-medium);
	}
}

.publication-state {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-primary);
}

.publication-dot {
	inline-size: .5rem;
	block-size: .5rem;
	border-radius: var(--radius-full);
	background: var(--text-tertiary);

	.is-published & {
		background: var(--success);
	}
}

.publication-take-down {
	margin-inline-start: auto;
}

.editor-layout {
	display: grid;
	gap: var(--space-4);
	align-items: start;
}

@container showcase-editor (min-width: 52rem) {
	.editor-layout {
		grid-template-columns: minmax(0, 1fr) 15rem;
	}

	.editor-actions {
		position: sticky;
		inset-block-start: calc(var(--header-height) + var(--space-4));
		flex-direction: column;
		align-items: stretch;
	}
}

.editor-panels {
	display: grid;
	gap: var(--space-4);
	min-inline-size: 0;
}

.editor-panel,
.preview-panel {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;
	padding: var(--space-4) var(--space-5);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);

	h2 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-tight);

		svg {
			color: var(--text-tertiary);
			font-size: var(--text-md);
		}
	}
}

.panel-description,
.preview-stale {
	color: var(--text-secondary);
	font-size: var(--text-md);
}

.preview-stale {
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--warning);
	border-radius: var(--radius-sm);
	background: var(--tint-warning);
	color: var(--text-primary);
}

.fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
	gap: var(--space-3);
}

@container showcase-editor (min-width: 36rem) {
	.fields .is-wide {
		grid-column: span 2;
	}
}

.field {
	display: grid;
	align-content: start;
	gap: var(--space-1);
	min-inline-size: 0;
}

.field-label {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.help {
	margin: 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.check {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	font-size: var(--text-md);
	cursor: pointer;

	input {
		flex: none;
	}
}

.weekdays {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	min-inline-size: 0;
	margin: 0;
	padding: 0;
	border: 0;

	legend {
		margin-block-end: var(--space-2);
		padding: 0;
	}
}

.weekday {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: max(var(--control-height-sm), var(--target-min));
	padding-inline: var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	cursor: pointer;

	&:has(:checked) {
		border-color: hsla(var(--primary-hsl), .5);
		background: var(--surface-selected);
		color: var(--accent-text);
	}
}

.inline-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);

	.select {
		flex: 1 1 14rem;
		min-inline-size: 0;
		max-inline-size: 24rem;

		select {
			inline-size: 100%;
		}
	}
}

.rule-list {
	display: grid;
	margin: 0;
	padding: 0;
	list-style: none;
	border-block-start: 1px solid var(--border-subtle);
}

.project-rule,
.task-rule {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	padding-block: var(--space-3);
	border-block-end: 1px solid var(--border-subtle);
}

.rule-name {
	min-inline-size: 0;
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
}

.rule-alias,
.rule-mode {
	grid-column: 1 / -1;

	.select,
	select {
		inline-size: 100%;
	}
}

.rule-remove {
	grid-row: 1;
	grid-column: 2;
}

.task-rule .input {
	grid-column: 1 / -1;
}

@container showcase-editor (min-width: 44rem) {
	.project-rule {
		grid-template-columns: minmax(7rem, 1fr) minmax(8rem, 1fr) minmax(10rem, 1.4fr) auto;
		align-items: end;
	}

	.project-rule .rule-name {
		align-self: center;
	}

	.rule-alias,
	.rule-mode,
	.rule-remove {
		grid-row: auto;
		grid-column: auto;
	}

	.task-rule {
		grid-template-columns: minmax(8rem, 1fr) minmax(10rem, 1.2fr) auto;
	}

	.task-rule .input {
		grid-column: auto;
	}
}

.template-editor {
	font-family: var(--font-mono);
}

.editor-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
}

@container showcase-editor (max-width: 36rem) {
	.editor-actions > .button {
		flex: 1 1 100%;
	}
}

.editor-unsaved {
	flex-basis: 100%;
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
}

.showcase-leave__text {
	margin: 0;
	padding: var(--space-4);
	color: var(--text-secondary);
}

.publish-hint {
	flex-basis: 100%;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.editor-actions .help {
	flex-basis: 100%;
}
</style>
