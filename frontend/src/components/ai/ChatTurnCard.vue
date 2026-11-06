<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import {openAgentDiagnostic} from '@/helpers/diagnostics'
import {finalAnswer, hidesLastStepText, liveStepIndex, NO_ACTIONS, NO_COMPACTIONS, NO_OPERATIONS, NO_STEPS, NO_SUBAGENTS, sameItems} from '@/helpers/aronaTimeline'
import OutputSpeed from './OutputSpeed.vue'
import WebSearchEvidence from './WebSearchEvidence.vue'
import RunStatus from './RunStatus.vue'
import TurnTimeline from './timeline/TurnTimeline.vue'
import ToolCallRow from './timeline/ToolCallRow.vue'
import {toolLabels} from './toolLabels'
import {useAronaDisplayPreferences} from '@/composables/useAronaDisplayPreferences'
import MarkdownBlock from './timeline/MarkdownBlock.vue'
import AronaAvatar from '@/components/ai/AronaAvatar.vue'
import ChatAttachmentCard from '@/components/ai/attachments/ChatAttachmentCard.vue'
import AgentReviewCard from '@/components/ai/AgentReviewCard.vue'
import MessageTimestamp from './MessageTimestamp.vue'
import TurnSteering from './TurnSteering.vue'
import type {ChatTurn, Operation, ReviewInput} from '@/client/generated'

const props = withDefaults(defineProps<{
	conversationId?: string
	turn: ChatTurn
	busy: boolean
	sending?: boolean
	reviewBusy?: boolean
}>(), {
	reviewBusy: false,
	sending: false,
	conversationId: '',
})
const emit = defineEmits<{
	fork: [id: string]
	review: [input: ReviewInput]
}>()
const {t, n} = useI18n({useScope: 'global'})
const {preferences} = useAronaDisplayPreferences()
const labels = computed(() => toolLabels(t))
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
const running = computed(() => props.turn.status === 'running')
const result = computed(() => props.turn.result)
const steps = computed(() => result.value?.steps ?? NO_STEPS)
const actions = computed(() => result.value?.actions ?? NO_ACTIONS)
const lastStep = computed(() => steps.value.at(-1))
const duration = computed(() => result.value?.duration_ms == null ? '' : t('aronaRun.totalTime', {
	value: t('chat.seconds', {
		value: n(result.value.duration_ms / 1000, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}),
	}),
}))
const compactions = computed(() => result.value?.auto_compactions ?? NO_COMPACTIONS)
const subagents = computed(() => result.value?.subagents ?? NO_SUBAGENTS)
const streamingIndex = computed(() => liveStepIndex(result.value, running.value))
// A rejected review leaves a receipt but no action; the timeline shows it on its own call. The array keeps its
// identity while the decisions are unchanged, so completed rounds keep identical props between live frames.
const rejected = computed<readonly Operation[]>(previous => {
	const next = (result.value?.operations ?? NO_OPERATIONS).filter(operation => operation.status === 'rejected')
	if (!next.length) return NO_OPERATIONS
	return previous && sameItems(previous, next) ? previous : next
})
// Every round stays in the timeline; only the final answer moves below it, at the same left edge.
const answer = computed(() => finalAnswer(result.value, running.value))
const hideLastText = computed(() => hidesLastStepText(result.value, running.value))
const searches = computed(() => (result.value?.actions ?? []).filter(action => action.search))
// What `finished` means for each settled state; a running turn has no reply time, whatever it holds.
const FINISHED_LABELS: Partial<Record<NonNullable<ChatTurn['status']>, string>> = {
	completed: 'aronaTime.replied',
	failed: 'aronaTime.failed',
	stopped: 'aronaTime.stopped',
	interrupted: 'aronaTime.interrupted',
	awaiting_approval: 'aronaTime.paused',
	awaiting_input: 'aronaTime.paused',
	paused: 'aronaTime.paused',
}
const finishedLabel = computed(() => {
	const key = !running.value && !props.sending && props.turn.status ? FINISHED_LABELS[props.turn.status] : undefined
	return key ? t(key) : ''
})
async function copy() {
	try {
		await navigator.clipboard.writeText(answer.value)
		copied.value = true
		clearTimeout(copiedTimer)
		copiedTimer = setTimeout(() => { copied.value = false }, 2000)
	} catch {
		copied.value = false
	}
}
onBeforeUnmount(() => clearTimeout(copiedTimer))

// One polite status per turn that only changes with the stage, never with counters or streamed text.
const finishedHere = ref(false)
watch(running, (isRunning, wasRunning) => { if (wasRunning && !isRunning) finishedHere.value = true })
const announcement = computed(() => {
	if (props.sending) return t('chat.sending')
	if (running.value) return t(`flow.stage_${result.value?.stage || 'model'}`)
	if (result.value?.pause) return t(result.value.pause === 'budget' ? 'flow.stage_budget' : 'flow.stage_review')
	return finishedHere.value && props.turn.status === 'completed' ? t('flow.stage_completed') : ''
})
</script>

<template>
	<article
		class="chat-turn"
		:class="{'is-running': running}"
		:data-turn-id="turn.id"
	>
		<div class="user-message">
			<div>
				<strong class="is-sr-only">{{ t('tcymc.text.you') }}</strong><p>{{ turn.prompt }}</p><div
					v-if="turn.attachments?.length && conversationId"
					class="message-attachments"
				>
					<ChatAttachmentCard
						v-for="file in turn.attachments"
						:key="file.id"
						:conversation-id="conversationId"
						:file="file"
					/>
				</div>
			</div>
		</div>
		<p class="user-meta">
			<MessageTimestamp
				:value="turn.started"
				:label="t('aronaTime.sent')"
				hide-label
			/>
		</p>
		<TurnSteering
			:entries="turn.steering"
			:status="turn.status"
			:turn-id="turn.id"
			:conversation-id="conversationId"
		/>
		<div class="assistant-message">
			<div class="assistant-identity">
				<AronaAvatar size="small" />
				<strong>{{ t('tcymc.text.task_assistant') }}</strong>
				<span
					v-if="result?.model"
					class="model-badge"
				>{{ result.model }}</span>
				<MessageTimestamp
					v-if="finishedLabel"
					:value="turn.finished"
					:label="finishedLabel"
				/>
				<span
					class="is-sr-only"
					role="status"
				>{{ announcement }}</span>
			</div>
			<TurnTimeline
				v-if="steps.length || compactions.length"
				:steps="steps"
				:actions="result?.actions ?? NO_ACTIONS"
				:operations="result?.operations ?? NO_OPERATIONS"
				:rejected="rejected"
				:running="running"
				:streaming-index="streamingIndex"
				:hide-last-text="hideLastText"
				:compactions="compactions"
				:subagents="subagents"
			/>
			<!-- Older records can retain real tool receipts without model diagnostics. Show the
			     receipts themselves, without inventing a model round, thinking or usage. -->
			<div
				v-if="!steps.length && actions.length"
				class="action-receipts"
			>
				<ToolCallRow
					v-for="(action, index) in actions"
					:key="action.result_ref || index"
					:label="labels[action.tool ?? ''] || action.tool || t('aronaRun.unnamedTool')"
					:action="action"
					:default-open="preferences.expandToolDetails"
				/>
			</div>
			<MarkdownBlock
				v-if="answer"
				class="chat-markdown"
				:source="answer"
			/>
			<p
				v-if="sending || (running && !steps.length && !compactions.length)"
				class="thinking-status"
			>
				<Icon icon="bolt" /> {{ t(sending ? 'chat.sending' : 'chat.waiting') }}
			</p>
			<AgentReviewCard
				:turn="turn"
				:busy="reviewBusy || running"
				@review="emit('review', $event)"
			/>
			<p
				v-if="result?.error"
				class="run-error"
				role="status"
			>
				{{ result.error }}
			</p>
			<p
				v-if="turn.status === 'interrupted'"
				class="run-error"
			>
				{{ t('chat.interrupted') }}
			</p>
			<p
				v-if="turn.status === 'stopped'"
				class="step-note"
			>
				{{ t('chat.stopped') }}
			</p>

			<div
				v-if="turn.retryable"
				class="retry-panel"
			>
				<XButton
					:disabled="busy || reviewBusy"
					:loading="reviewBusy"
					icon="redo"
					@click="emit('review', {turn_id: turn.id!, decision: 'retry', operation_id: '', arguments: '', answer: ''})"
				>
					{{ t('chat.retryResume') }}
				</XButton>
				<p class="step-note">
					{{ t('chat.retryResumeHint') }}
				</p>
			</div>

			<!-- Live status sits below the answer, so it can leave without moving text being read. -->
			<div
				v-if="!sending"
				class="run-meta"
				:class="{'is-live': running}"
			>
				<span
					v-if="!running && duration"
					class="run-duration"
				>{{ duration }}</span>
				<OutputSpeed
					v-if="!running && turn.status === 'completed'"
					:step="lastStep"
				/>
				<RunStatus
					:result="result"
					:running="running"
				>
					<details
						v-if="result?.system_prompt && !running"
						class="request-details"
					>
						<summary>{{ t('chat.requestDetails') }}</summary>
						<details
							v-if="result.configuration"
							class="run-configuration"
						>
							<summary>{{ t('assistantUI.runConfiguration') }}</summary><pre>{{ JSON.stringify(result.configuration, null, 2) }}</pre>
						</details>
						<p>{{ t('chat.requestedModel') }}: {{ result.requested_model }} · {{ result.protocol }}</p>
						<code>{{ result.endpoint }}</code>
						<pre>{{ result.system_prompt }}</pre>
						<p>{{ t('chat.metricNotes') }}</p>
					</details>
					<BaseButton
						class="message-action run-diagnostic"
						:title="t('debug.openRun')"
						:aria-label="t('debug.openRun')"
						@click="openAgentDiagnostic(turn)"
					>
						<Icon icon="code" /> {{ t('debug.openRun') }}
					</BaseButton>
				</RunStatus>
			</div>
			<WebSearchEvidence
				v-for="(action, index) in searches"
				:key="`search-${index}`"
				:result="action.search!"
			/>
			<div class="message-actions">
				<BaseButton
					v-if="answer"
					class="message-action"
					:title="copied ? t('chat.copied') : t('chat.copy')"
					:aria-label="copied ? t('chat.copied') : t('chat.copy')"
					@click="copy"
				>
					<Icon :icon="copied ? 'check' : 'copy'" />
					<span class="message-action-label">{{ copied ? t('chat.copied') : t('chat.copy') }}</span>
				</BaseButton>
				<BaseButton
					v-if="!running"
					class="message-action"
					:aria-disabled="busy"
					:title="t('chat.forkHere')"
					:aria-label="t('chat.forkHere')"
					@click="!busy && emit('fork', turn.id!)"
				>
					<Icon icon="code-branch" />
					<span class="message-action-label">{{ t('chat.forkHere') }}</span>
				</BaseButton>
			</div>
		</div>
	</article>
</template>

<style scoped lang="scss">
.action-receipts {
	min-inline-size: 0;
}

.chat-turn {
	content-visibility: auto;
	contain-intrinsic-size: auto 200px;
	margin-block: var(--space-4) var(--space-8);
	min-inline-size: 0;
}

// A running turn must lay out even off screen, so its live rounds and status never measure as a placeholder.
.chat-turn.is-running {
	content-visibility: visible;
}

.user-message {
	display: flex;
	gap: var(--space-3);
	inline-size: fit-content;
	max-inline-size: min(85%, 40rem);
	margin-inline-start: auto;
	padding: var(--space-2) var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface-sunken);
	color: var(--text-primary);
	font-size: var(--text-base);
	line-height: var(--leading-normal);
}

.user-message > div {
	min-inline-size: 0;
}

.user-message p {
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.user-meta {
	margin: var(--space-1) 0 0;
	text-align: end;

	// No valid send time: the timestamp renders nothing, and the row takes no space.
	&:empty {
		display: none;
	}
}

.message-attachments {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin-block-start: var(--space-2);
}

.assistant-message {
	min-inline-size: 0;
	margin-block-start: var(--space-5);
}

.assistant-identity {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-2);
	min-block-size: var(--control-height-sm);
	margin-block-end: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);

	strong {
		color: var(--text-primary);
		font-weight: var(--weight-semibold);
	}
}

.model-badge {
	min-inline-size: 0;
	max-inline-size: 100%;
	padding-inline: var(--space-2);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-full);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: 1.5;
	overflow-wrap: anywhere;
}

summary {
	cursor: pointer;
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;
	border-radius: var(--radius-sm);

	&:focus-visible {
		@include focus-ring;
	}
}

// Same offset as an interim reply, so the final round's text does not jump when it becomes the answer.
.chat-markdown {
	margin-block-start: var(--space-2);
}

.step-note {
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

pre {
	max-block-size: 20rem;
	margin-block: var(--space-2);
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	font-family: var(--font-mono);
	font-size: var(--text-xs);
}

.thinking-status {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-md);
}

.run-error {
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-md);
	overflow-wrap: anywhere;
}

.retry-panel {
	margin-block: var(--space-3);
}

.run-meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-3);
	min-block-size: var(--control-height-sm);
	margin-block-start: var(--space-3);
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	&.is-live {
		display: block;
	}

	> details[open] {
		flex-basis: 100%;
	}
}

.run-duration {
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}

.request-details {
	color: var(--text-tertiary);

	> summary {
		padding-block: var(--space-1);
	}

	> p {
		margin-block: var(--space-2);
	}

	code {
		display: block;
		overflow-wrap: anywhere;
	}
}

.run-configuration {
	margin-block: var(--space-2);
}

.message-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1);
	margin-block-start: var(--space-2);
}

.message-action {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-1);
	min-block-size: var(--control-height-sm);
	min-inline-size: var(--control-height-sm);
	padding-inline: var(--space-2);
	border-radius: var(--radius-sm);
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&.is-icon {
		padding-inline: 0;
	}

	&[aria-disabled='true'] {
		opacity: .5;
		cursor: not-allowed;
	}

	svg {
		inline-size: .85em;
	}
}

@media (width <= 768px) {
	.chat-turn {
		margin-block: var(--space-3) var(--space-5);
	}

	.assistant-message {
		margin-block-start: var(--space-3);
	}

	.assistant-identity {
		column-gap: var(--space-2);
		font-size: var(--text-sm);
	}

	.run-meta {
		column-gap: var(--space-2);
		margin-block-start: var(--space-2);
		font-size: var(--text-sm);
	}

	.message-actions {
		gap: 0;
		margin-block-start: 0;
	}

	.message-action {
		min-inline-size: 2.75rem;
		min-block-size: 2.75rem;
		font-size: 1rem;
	}

	.message-action-label {
		display: none;
	}

	.run-diagnostic {
		justify-content: flex-start;
		max-inline-size: 100%;
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
}
</style>
