<script setup lang="ts">
import {ref, onMounted, onBeforeUnmount} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Conversation} from '@/client/generated'
import {fetchConversationExport} from '@/client/queries/chatAttachments'
import {conversationPDF} from './pdf'
import {saveChatBlob} from './files'
const props = defineProps<{conversation: Conversation}>()
const emit = defineEmits<{close: []}>()
const {t} = useI18n({useScope: 'global'})
const dialog = ref<HTMLDialogElement>()
const format = ref<'pdf' | 'zip' | 'md' | 'json'>('pdf')
const working = ref(false)
const status = ref('')
const failure = ref('')
let controller: AbortController | undefined
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => controller?.abort())
async function start() {
	if (working.value) return
	working.value = true; failure.value = ''; status.value = t('chatFiles.exportPreparing')
	controller = new AbortController()
	const c = JSON.parse(JSON.stringify(props.conversation)) as Conversation
	try {
		const blob = format.value === 'pdf' ? await conversationPDF(c, {you: t('tcymc.text.you'), assistant: t('tcymc.text.task_assistant'), missing: t('chatFiles.missing'), unreadable: t('chatFiles.pdfFile'), drafts: t('chatFiles.drafts'), summary: t('chatFiles.summary'), generated: t('chatFiles.generated'), status: t('chatFiles.status'), model: t('chatFiles.model'), duration: t('chatFiles.duration'), steps: t('chatFiles.tools'), addition: t('aronaSteer.badge'), pending: t('aronaSteer.statusPending'), applied: t('aronaSteer.statusApplied')}, (done, total, stage) => { status.value = stage === 'pdf' ? t('chatFiles.pdfPreparing') : t('chatFiles.exportProgress', {done, total}) }, controller.signal) : await fetchConversationExport(c.id!, format.value, controller.signal)
		controller.signal.throwIfAborted()
		saveChatBlob(blob, `${(c.title || 'Arona').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.${format.value}`)
		status.value = t('chatFiles.exportDone')
	} catch (error) { if (!controller.signal.aborted) failure.value = t('chatFiles.exportFailed') + ' ' + (error instanceof Error ? error.message : '') }
	finally { working.value = false }
}
</script>

<template>
	<!-- Escape belongs to this dialog alone; the floating panel around it minimizes on Escape. -->
	<dialog
		ref="dialog"
		class="export-dialog"
		aria-labelledby="chat-export-title"
		@keydown.esc.stop
		@close="emit('close')"
	>
		<h2 id="chat-export-title">
			{{ t('chatFiles.export') }}
		</h2>
		<p class="export-hint">
			{{ t('chatFiles.exportHint') }}
		</p>
		<label class="export-format">{{ t('chatFiles.format') }}<span class="select">
			<select
				v-model="format"
				:disabled="working"
			><option value="pdf">{{ t('chatFiles.pdf') }}</option><option value="zip">{{ t('chatFiles.zip') }}</option><option value="md">{{ t('chatFiles.md') }}</option><option value="json">JSON</option></select>
		</span></label>
		<p class="export-note">
			{{ t(`chatFiles.hint_${format}`) }}
		</p>
		<p
			v-if="conversation.turns?.some(turn => turn.status === 'running')"
			class="export-note"
		>
			{{ t('chatFiles.runningSnapshot') }}
		</p>
		<progress
			v-if="working"
			:aria-label="status"
		/>
		<p
			role="status"
			class="export-status"
		>
			{{ status }}
		</p><p
			v-if="failure"
			role="alert"
			class="export-failure"
		>
			{{ failure }}
		</p>
		<div class="export-actions">
			<XButton
				variant="secondary"
				:shadow="false"
				@click="controller?.abort(); dialog?.close()"
			>
				{{ t('misc.close') }}
			</XButton><XButton
				icon="download"
				:shadow="false"
				:loading="working"
				@click="start"
			>
				{{ t('chatFiles.download') }}
			</XButton>
		</div>
	</dialog>
</template>

<style scoped lang="scss">
.export-dialog {
	inline-size: min(32rem, calc(100vw - 2rem));
	max-block-size: 85dvh;
	padding: var(--space-5);
	overflow: auto;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);

	&::backdrop {
		background: var(--scrim);
	}
}

h2 {
	margin-block: 0 var(--space-2);
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
}

p {
	margin-block: var(--space-2);
	font-size: var(--text-md);
	line-height: var(--leading-normal);
}

.export-hint,
.export-note {
	color: var(--text-secondary);
}

.export-note {
	font-size: var(--text-sm);
}

.export-format {
	display: grid;
	gap: var(--space-1);
	margin-block-start: var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);

	.select,
	select {
		inline-size: 100%;
	}

	select {
		font-weight: var(--weight-regular);
	}
}

.export-status:empty {
	display: none;
}

.export-failure {
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
}

progress {
	inline-size: 100%;
}

.export-actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: var(--space-2);
	margin-block-start: var(--space-4);
}
</style>
