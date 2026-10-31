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
import MarkdownBlock from './timeline/MarkdownBlock.vue'
import AronaAvatar from '@/components/ai/AronaAvatar.vue'
import ChatAttachmentCard from '@/components/ai/attachments/ChatAttachmentCard.vue'
import AgentReviewCard from '@/components/ai/AgentReviewCard.vue'
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
const {t} = useI18n({useScope: 'global'})
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
const running = computed(() => props.turn.status === 'running')
const result = computed(() => props.turn.result)
const steps = computed(() => result.value?.steps ?? NO_STEPS)
const lastStep = computed(() => steps.value.at(-1))
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
		<div class="assistant-message">
			<div class="assistant-identity">
				<AronaAvatar size="small" />
				<strong>{{ t('tcymc.text.task_assistant') }}</strong>
				<span
					v-if="result?.model"
					class="model-badge"
				>{{ result.model }}</span>
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
				v-if="result?.budget?.round_limit"
				class="step-note"
			>
				{{ t('agent.budgetProgress', {rounds: result.budget.rounds, roundLimit: result.budget.round_limit, operations: result.budget.operations, operationLimit: result.budget.operation_limit}) }}
			</p>
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
			<RunStatus
				v-if="running && !sending"
				:result="result"
				running
			/>
			<div
				v-if="!running && (turn.status === 'completed' || steps.length || result?.system_prompt)"
				class="run-meta"
			>
				<OutputSpeed
					v-if="turn.status === 'completed'"
					:step="lastStep"
				/>
				<RunStatus
					v-if="steps.length || result?.system_prompt"
					:result="result"
				>
					<details
						v-if="result?.system_prompt"
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
					@click="copy"
				>
					<Icon :icon="copied ? 'check' : 'copy'" /> {{ copied ? t('chat.copied') : t('chat.copy') }}
				</BaseButton>
				<BaseButton
					v-if="!running"
					class="message-action"
					:aria-disabled="busy"
					@click="!busy && emit('fork', turn.id!)"
				>
					<Icon icon="code-branch" /> {{ t('chat.forkHere') }}
				</BaseButton>
				<BaseButton
					class="message-action is-icon"
					:title="t('debug.openRun')"
					:aria-label="t('debug.openRun')"
					@click="openAgentDiagnostic(turn)"
				>
					<Icon icon="code" />
				</BaseButton>
			</div>
		</div>
	</article>
</template>

<style scoped lang="scss">
.chat-turn {
	content-visibility: auto;
	contain-intrinsic-size: auto 200px;
	margin-block: var(--space-4) var(--space-8);
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
	align-items: baseline;
	gap: 0 var(--space-4);
	min-block-size: var(--control-height-sm);
	margin-block-start: var(--space-3);
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	> details[open] {
		flex-basis: 100%;
	}
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
</style>
