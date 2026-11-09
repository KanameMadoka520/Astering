<script setup lang="ts">
import {
	computed,
	ref,
	watch,
} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {aiSettingsQuery} from '@/client/queries/tcyAi'
import {
	noteOrganizationQuery,
	organizationActive,
	useCreateNoteOrganization,
	useControlNoteOrganization,
	useApplyNoteOrganization,
} from '@/client/queries/noteOrganization'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {ApiError} from '@/client/problem'
import {getHumanSize} from '@/helpers/getHumanSize'
import type {Note} from '@/client/queries/notes'
import MarkdownBlock from '@/components/ai/timeline/MarkdownBlock.vue'
import XButton from '@/components/input/Button.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import Modal from '@/components/misc/Modal.vue'
const props = defineProps<{
	note: Note
	articleDirty: boolean
}>()
const {t} = useI18n({useScope: 'global'})
const owner = captureClientRequestContext()
const query = useQuery(computed(() => noteOrganizationQuery(props.note.id)))
const expanded = ref(false)
const settings = useQuery({
	...aiSettingsQuery(),
	enabled: computed(() => expanded.value),
})
// The parent keys this child by account and note; the source choice is a local
// user preference for this opened note, not a binding over background updates.
function initialSource() { return props.note.segment_count ? 'transcript' : 'article' }
const source = ref<'transcript' | 'article'>(initialSource())
const connection = ref('')
const connections = computed(() => settings.data.value?.connections
	.filter(item => item.kind === 'chat') ?? [])
watch(settings.data, data => {
	if (!data || connections.value.some(item => item.id === connection.value)) return
	connection.value = data.cleanup || data.assistant || connections.value[0]?.id || ''
})
const job = computed(() => query.data.value?.job)
const active = computed(() => organizationActive(job.value))
const create = useCreateNoteOrganization()
const control = useControlNoteOrganization()
const apply = useApplyNoteOrganization()
const failure = ref('')
const adopted = ref(false)
const confirm = ref<{
	mode: 'append' | 'replace'
	revision: number
}>()
const discardConfirm = ref(false)
const busy = computed(() => create.isPending.value || control.isPending.value || apply.isPending.value)
const percent = computed(() => job.value?.source_bytes
	? Math.min(100, Math.floor(job.value.processed_bytes / job.value.source_bytes * 100))
	: 0)
const sourceEmpty = computed(() => source.value === 'transcript'
	? !props.note.segment_count
	: !props.note.content.trim())
const badge = computed(() => {
	if (active.value) return t('notes.organization.working')
	return t(job.value?.status === 'completed' ? 'notes.organization.ready' : 'notes.organization.optional')
})
const errorMessage = computed(() => {
	if (failure.value) return failure.value
	const code = job.value?.error
	return code?.startsWith('note_organization_') ? t(`notes.organization.errors.${code}`) : code
})
function fail(cause: unknown) {
	if (!isClientRequestContextCurrent(owner) || isRequestContextAbort(cause)) return
	if (cause instanceof ApiError && cause.status === 429 && [
		'note_organization_capacity_account',
		'note_organization_capacity_instance',
	].includes(cause.detail)) {
		failure.value = t(`notes.organization.errors.${cause.detail}`)
		return
	}
	failure.value = cause instanceof ApiError && cause.status === 409
		? t('notes.organization.conflict')
		: t('notes.organization.requestFailed')
}
function chooseSource(event: Event) {
	const select = event.target as HTMLSelectElement
	if (busy.value) select.value = source.value
	else source.value = select.value === 'article' ? 'article' : 'transcript'
}
function chooseConnection(event: Event) {
	const select = event.target as HTMLSelectElement
	if (busy.value || settings.isPending.value) select.value = connection.value
	else connection.value = select.value
}
async function start() {
	if (busy.value || active.value || sourceEmpty.value || !connection.value
		|| !isClientRequestContextCurrent(owner)) return
	if (source.value === 'article' && props.articleDirty) {
		failure.value = t('notes.organization.saveDraft')
		return
	}
	failure.value = ''
	adopted.value = false
	try {
		await create.mutateAsync({
			id: props.note.id,
			source: source.value,
			connection_id: connection.value,
		})
	} catch (cause) { fail(cause) }
}
async function change(action: 'cancel' | 'retry' | 'discard') {
	if (!job.value || busy.value || !isClientRequestContextCurrent(owner)) return
	failure.value = ''
	try {
		await control.mutateAsync({
			id: props.note.id,
			job_id: job.value.id,
			action,
		})
		if (isClientRequestContextCurrent(owner)) discardConfirm.value = false
	} catch (cause) { fail(cause) }
}
function askApply(mode: 'append' | 'replace') {
	if (busy.value || !isClientRequestContextCurrent(owner)) return
	if (props.articleDirty) {
		failure.value = t('notes.organization.saveDraft')
		return
	}
	confirm.value = {
		mode,
		revision: props.note.revision,
	}
}
async function adopt() {
	const choice = confirm.value
	if (!choice || !job.value || busy.value || !isClientRequestContextCurrent(owner)) return
	if (props.articleDirty) {
		failure.value = t('notes.organization.saveDraft')
		confirm.value = undefined
		return
	}
	failure.value = ''
	try {
		await apply.mutateAsync({
			id: props.note.id,
			job_id: job.value.id,
			expected_revision: choice.revision,
			mode: choice.mode,
		})
		if (isClientRequestContextCurrent(owner) && confirm.value === choice) {
			confirm.value = undefined
			adopted.value = true
		}
	} catch (cause) {fail(cause)}
}
</script>

<template>
	<section class="note-organization">
		<button
			class="note-organization__toggle"
			type="button"
			:aria-expanded="expanded"
			@click="expanded = !expanded"
		>
			<span><Icon icon="comments" /> {{ t('notes.organization.title') }}</span>
			<span class="note-organization__badge">
				{{ badge }}
				<Icon :icon="expanded ? 'chevron-up' : 'chevron-down'" />
			</span>
		</button>
		<div
			v-if="expanded"
			class="note-organization__body"
		>
			<p>{{ t('notes.organization.help') }}</p>
			<LoadError
				v-if="query.isError.value"
				:message="t('notes.organization.loadFailed')"
				:retry="query.refetch"
			/>
			<LoadError
				v-if="settings.isError.value"
				:message="t('notes.organization.modelsFailed')"
				:retry="settings.refetch"
			/>
			<div
				v-if="!active"
				class="note-organization__settings"
			>
				<label>{{ t('notes.organization.source') }}
					<select
						:value="source"
						class="input"
						:aria-disabled="busy"
						@change="chooseSource"
					>
						<option value="transcript">{{ t('notes.organization.transcript') }}</option>
						<option value="article">{{ t('notes.organization.article') }}</option>
					</select>
				</label>
				<label>{{ t('notes.organization.model') }}
					<select
						:value="connection"
						class="input"
						:aria-disabled="busy || settings.isPending.value"
						@change="chooseConnection"
					>
						<option
							v-if="!connections.length"
							value=""
						>{{ t('notes.organization.noModel') }}</option>
						<option
							v-for="item in connections"
							:key="item.id"
							:value="item.id"
						>{{ item.name }} · {{ item.model }}</option>
					</select>
				</label>
				<XButton
					:shadow="false"
					:loading="create.isPending.value"
					:aria-disabled="busy || sourceEmpty || !connection || source === 'article' && articleDirty"
					@click="start"
				>
					{{ t(job ? 'notes.organization.restart' : 'notes.organization.start') }}
				</XButton>
			</div>
			<p
				v-if="source === 'article' && articleDirty || job?.status === 'completed' && articleDirty"
				role="status"
			>
				{{ t('notes.organization.saveDraft') }}
			</p>
			<div
				v-if="job"
				class="note-organization__progress"
				role="status"
				aria-live="polite"
			>
				<strong>{{ t(`notes.organization.status.${job.status}`) }}</strong>
				<p>
					{{ job.model }} · {{ t('notes.organization.steps', {n: job.completed_steps}) }} ·
					{{ getHumanSize(job.source_bytes) }}
				</p>
				<template v-if="active">
					<p>
						{{ job.phase === 'map'
							? t('notes.organization.mapping', {percent})
							: t('notes.organization.merging', {level: job.level}) }}
					</p>
					<progress
						v-if="job.phase === 'map'"
						:value="job.processed_bytes"
						:max="Math.max(1, job.source_bytes)"
						:aria-label="t('notes.organization.mapProgress')"
					/>
					<p>{{ t('notes.organization.leaveSafe') }}</p>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="busy"
						@click="change('cancel')"
					>
						{{ t('notes.organization.cancel') }}
					</XButton>
				</template>
				<p v-if="job.input_tokens || job.output_tokens">
					{{ job.input_tokens.toLocaleString() }} {{ t('notes.organization.inputTokens') }} ·
					{{ job.output_tokens.toLocaleString() }} {{ t('notes.organization.outputTokens') }}
					<span v-if="job.usage_partial"> · {{ t('notes.organization.partialUsage') }}</span>
				</p>
				<template v-if="['failed', 'interrupted', 'cancelled'].includes(job.status)">
					<p>{{ t('notes.organization.resumeHelp') }}</p>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="busy"
						@click="change('retry')"
					>
						{{ t('notes.organization.retry') }}
					</XButton>
				</template>
				<XButton
					v-if="!active"
					variant="tertiary"
					:shadow="false"
					:aria-disabled="busy"
					@click="!busy && (discardConfirm = true)"
				>
					{{ t('notes.organization.discard') }}
				</XButton>
			</div>
			<p
				v-if="errorMessage"
				class="note-organization__error"
				role="alert"
			>
				{{ errorMessage }}
			</p>
			<template v-if="job?.status === 'completed' && job.result">
				<h3>{{ t('notes.organization.preview') }}</h3>
				<p>{{ t('notes.organization.previewHelp') }}</p>
				<div class="note-organization__preview">
					<MarkdownBlock :source="job.result" />
				</div>
				<div class="note-organization__actions">
					<XButton
						:shadow="false"
						:aria-disabled="busy || articleDirty"
						@click="askApply('append')"
					>
						{{ t('notes.organization.append') }}
					</XButton>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="busy || articleDirty"
						@click="askApply('replace')"
					>
						{{ t('notes.organization.replace') }}
					</XButton>
				</div>
				<p
					v-if="adopted"
					role="status"
				>
					{{ t('notes.organization.adopted') }}
				</p>
			</template>
		</div>
		<Modal
			v-if="confirm"
			:loading="apply.isPending.value"
			:confirm-label="t('notes.organization.confirmApply')"
			@close="confirm = undefined"
			@submit="adopt"
		>
			<template #header>
				{{ t(confirm.mode === 'replace' ? 'notes.organization.replace' : 'notes.organization.append') }}
			</template>
			<template #text>
				<p>
					{{ t(confirm.mode === 'replace'
						? 'notes.organization.replaceConfirm'
						: 'notes.organization.appendConfirm') }}
				</p>
			</template>
		</Modal>
		<Modal
			v-if="discardConfirm"
			:loading="control.isPending.value"
			:confirm-label="t('notes.organization.discard')"
			@close="discardConfirm = false"
			@submit="change('discard')"
		>
			<template #header>
				{{ t('notes.organization.discard') }}
			</template>
			<template #text>
				<p>{{ t('notes.organization.discardConfirm') }}</p>
			</template>
		</Modal>
	</section>
</template>

<style scoped lang="scss">
.note-organization {
	grid-column: 1 / -1;
	border: 1px solid var(--grey-200);
	border-radius: .85rem;
	background: var(--white);
	overflow: clip;
	min-inline-size: 0;
}
.note-organization__toggle {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: .75rem;
	inline-size: 100%;
	min-block-size: 3rem;
	padding: .75rem 1rem;
	background: transparent;
	border: 0;
	text-align: start;
	color: var(--grey-900);
	cursor: pointer;
}
.note-organization__toggle > span {
	display: flex;
	align-items: center;
	gap: .5rem;
}
.note-organization__badge {
	font-size: .8rem;
	color: var(--grey-600);
	white-space: nowrap;
}
.note-organization__body {
	padding: 0 1rem 1rem;
	display: grid;
	gap: .85rem;
}
.note-organization__body p {
	margin: 0;
	color: var(--grey-700);
	font-size: .875rem;
	line-height: 1.65;
}
.note-organization__settings {
	display: grid;
	grid-template-columns: minmax(10rem, 1fr) minmax(12rem, 2fr) auto;
	align-items: end;
	gap: .75rem;
}
.note-organization__settings label {
	display: grid;
	gap: .4rem;
	min-inline-size: 0;
	color: var(--grey-700);
	font-size: .875rem;
}
.note-organization__progress {
	padding: .85rem;
	border-radius: .65rem;
	background: var(--grey-50);
	display: grid;
	gap: .5rem;
	justify-items: start;
}
.note-organization__progress progress {
	inline-size: 100%;
	block-size: .5rem;
	accent-color: var(--primary);
}
.note-organization__preview {
	max-block-size: 32rem;
	overflow: auto;
	padding: 1rem;
	border: 1px solid var(--grey-200);
	border-radius: .65rem;
	overflow-wrap: anywhere;
}
.note-organization__actions {
	display: flex;
	flex-wrap: wrap;
	gap: .65rem;
}
.note-organization__body .note-organization__error {
	color: var(--danger);
}
@media (width <= 700px) {
	.note-organization__settings {
		grid-template-columns: minmax(0, 1fr);
	}
	.note-organization__actions :deep(.button) {
		inline-size: 100%;
	}
	.note-organization__toggle {
		align-items: flex-start;
	}
	.note-organization__badge {
		font-size: .75rem;
	}
}
</style>
