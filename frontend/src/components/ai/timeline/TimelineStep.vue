<script setup lang="ts">
import {computed, reactive, ref, watch} from 'vue'
import {useNow} from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import {useAronaPresenting} from '@/composables/useAronaPresentation'
import type {Action, ModelStep, Operation} from '@/client/generated'
import CacheUsage from '@/components/ai/CacheUsage.vue'
import {toolLabels} from '@/components/ai/toolLabels'
import {useAronaDisplayPreferences, usePreferredOpen} from '@/composables/useAronaDisplayPreferences'
import {characterCount, groupEntries, NO_OPERATIONS, stepEntries} from '@/helpers/aronaTimeline'
import {requestUsage} from '@/helpers/aronaRunMetrics'
import MarkdownBlock from './MarkdownBlock.vue'
import ToolCallRow from './ToolCallRow.vue'

// The parent passes the step object, the turn's whole actions array, operations only to the live round and the
// round's own rejected decisions as a stable array, so a completed round keeps identical props between frames and is
// skipped by the renderer.
const props = withDefaults(defineProps<{
	step: ModelStep
	actions: readonly Action[]
	operations: readonly Operation[]
	rejected?: readonly Operation[]
	live: boolean
	streaming: boolean
	hideText: boolean
	multiRound: boolean
}>(), {
	rejected: () => NO_OPERATIONS,
})
const {t, n} = useI18n({useScope: 'global'})
const {preferences} = useAronaDisplayPreferences()
const labels = computed(() => toolLabels(t))
const entries = computed(() => stepEntries(props.step, props.actions, props.operations, props.rejected))
const items = computed(() => groupEntries(entries.value))
const showMeta = computed(() => props.multiRound || entries.value.length > 0)
const text = computed(() => {
	const value = props.step.text ?? ''
	return !props.hideText && value.trim() ? value : ''
})
const usage = computed(() => requestUsage(props.step.usage))

// Only the streaming round's header ticks, and only on screen; every other round reads its saved duration.
const presenting = useAronaPresenting()
const {now, pause, resume} = useNow({interval: 1000, controls: true})
watch(() => props.streaming && presenting.value, ticking => {
	if (!ticking) return pause()
	// Shown again after a pause, the clock reads the real time at once instead of a second later.
	now.value = new Date()
	resume()
}, {immediate: true})
const elapsed = computed(() => {
	const started = props.step.started ? Date.parse(props.step.started) : NaN
	if (props.streaming && Number.isFinite(started)) return Math.max(props.step.duration_ms ?? 0, now.value.getTime() - started)
	return props.step.duration_ms ?? null
})

function seconds(ms: number) {
	return t('chat.seconds', {value: n(ms / 1000, {minimumFractionDigits: 2, maximumFractionDigits: 2})})
}
function characters(value?: string) {
	const count = characterCount(value)
	return t('aronaRun.characters', {count: n(count)}, count)
}
function label(tool: string) {
	return labels.value[tool] || tool || t('aronaRun.unnamedTool')
}

const header = computed(() => {
	const parts: string[] = []
	const input = usage.value?.input
	if (elapsed.value !== null) parts.push(seconds(elapsed.value))
	if (input != null) parts.push(t('aronaRun.input', {value: n(input)}))
	return parts.join(' · ')
})
const usageLine = computed(() => {
	const value = usage.value
	if (!value) return props.live ? t('flow.usagePending') : t('aronaRun.usageUnreported')
	const parts: string[] = []
	if (value.input !== null) parts.push(value.cached === null ? t('aronaRun.input', {value: n(value.input)}) : t('aronaRun.inputCached', {value: n(value.input), cached: n(value.cached)}))
	if (value.output !== null) parts.push(value.reasoning === null ? t('aronaRun.output', {value: n(value.output)}) : t('aronaRun.outputReasoning', {value: n(value.output), reasoning: n(value.reasoning)}))
	return parts.length ? parts.join(' · ') : t('aronaRun.usageUnreported')
})
const timingLine = computed(() => {
	const parts: string[] = []
	if (props.step.first_token_ms != null) parts.push(t('aronaRun.firstToken', {value: seconds(props.step.first_token_ms)}))
	if (props.step.first_text_ms != null) parts.push(t('aronaRun.firstText', {value: seconds(props.step.first_text_ms)}))
	return parts.join(' · ')
})
const reasoningSummary = computed(() => {
	const parts = [t('chat.providerReasoning'), characters(props.step.reasoning)]
	if (props.streaming) parts.push(t('aronaRun.receiving'))
	return parts.join(' · ')
})

const metaOpen = ref(false)
const replyOpen = ref(false)
const {open: reasoningOpen, onToggle: onReasoningToggle} = usePreferredOpen(() => preferences.value.expandReasoning)
// Groups follow the tool-details preference until the user toggles one of them.
const groupChoice = reactive(new Map<string, boolean>())
function groupOpen(key: string) {
	return groupChoice.get(key) ?? preferences.value.expandToolDetails
}
function onGroupToggle(key: string, event: Event) {
	const next = (event.target as HTMLDetailsElement).open
	if (next !== groupOpen(key)) groupChoice.set(key, next)
}
</script>

<template>
	<div
		class="timeline-step"
		:class="{'is-live': live}"
		:data-round="step.round"
	>
		<details
			v-if="showMeta"
			class="step-meta"
			@toggle="metaOpen = ($event.target as HTMLDetailsElement).open"
		>
			<summary>
				<Icon
					class="disclosure-icon"
					icon="chevron-right"
				/>
				<strong>{{ t('chat.round', {count: step.round}) }}</strong>
				<span v-if="header">· {{ header }}</span>
			</summary>
			<div
				v-if="metaOpen"
				class="step-meta-body"
			>
				<p v-if="step.model">
					{{ t('aronaRun.stepModel', {model: step.model}) }}
				</p>
				<p>{{ usageLine }}</p>
				<p v-if="timingLine">
					{{ timingLine }}
				</p>
				<CacheUsage :usages="[step.usage]" />
				<p v-if="step.loaded_tools?.length">
					{{ t('assistantUI.toolFootprint', {count: step.loaded_tools.length, total: step.catalog_tool_count, size: ((step.tool_schema_bytes ?? 0) / 1024).toFixed(1), full: ((step.catalog_schema_bytes ?? 0) / 1024).toFixed(1)}) }}<br><code>{{ step.loaded_tools.join(', ') }}</code><small v-if="step.loaded_tools.includes('invoke_tool')"> · {{ t('cacheEfficiency.deferredTools') }}</small>
				</p>
				<p v-if="step.http_status">
					HTTP {{ step.http_status }}<span v-if="step.request_id"> · {{ t('debug.upstreamID') }}: {{ step.request_id }}</span>
				</p>
				<p v-if="!live && step.requested_streaming && !step.streaming">
					{{ t('flow.streamIgnored') }}
				</p>
				<p v-if="step.stop_reason">
					{{ t('aronaRun.stopReason', {reason: step.stop_reason}) }}
				</p>
				<p v-if="!step.reasoning">
					{{ t('chat.noReasoning') }}
				</p>
			</div>
		</details>
		<details
			v-if="step.reasoning"
			class="reasoning"
			:open="reasoningOpen"
			@toggle="onReasoningToggle"
		>
			<summary>
				<Icon
					class="disclosure-icon"
					icon="chevron-right"
				/>
				<span>{{ reasoningSummary }}</span>
			</summary>
			<p
				v-if="reasoningOpen"
				tabindex="0"
			>
				{{ step.reasoning }}
			</p>
		</details>
		<template v-if="text">
			<!-- The live round may be the final answer, so it always streams in place. -->
			<MarkdownBlock
				v-if="preferences.showIntermediate || live"
				class="step-reply"
				:source="text"
				:streaming="streaming"
			/>
			<details
				v-else
				class="step-reply-collapsed"
				@toggle="replyOpen = ($event.target as HTMLDetailsElement).open"
			>
				<summary>
					<Icon
						class="disclosure-icon"
						icon="chevron-right"
					/>
					<span>{{ t('aronaRun.intermediateReply') }} · {{ t('chat.round', {count: step.round}) }} · {{ characters(text) }}</span>
				</summary>
				<MarkdownBlock
					v-if="replyOpen"
					class="step-reply"
					:source="text"
				/>
			</details>
		</template>
		<template
			v-for="item in items"
			:key="item.key"
		>
			<ToolCallRow
				v-if="item.kind === 'entry'"
				:label="label(item.entry.tool)"
				:call="item.entry.call"
				:action="item.entry.action"
				:operation="item.entry.operation"
				:receiving="streaming"
				:default-open="preferences.expandToolDetails"
			/>
			<details
				v-else
				class="tool-group"
				:open="groupOpen(item.key)"
				@toggle="onGroupToggle(item.key, $event)"
			>
				<summary>
					<Icon
						class="disclosure-icon"
						icon="chevron-right"
					/>
					<Icon
						class="group-icon"
						icon="layer-group"
					/>
					<strong>{{ t('aronaRun.groupCount', {tool: label(item.tool), count: n(item.entries.length)}) }}</strong>
					<span v-if="item.succeeded">· {{ t('aronaRun.succeededCount', {count: n(item.succeeded)}) }}</span>
					<span
						v-if="item.failed"
						class="group-failed"
					>· <Icon icon="exclamation-circle" /> {{ t('aronaRun.failedCount', {count: n(item.failed)}) }}</span>
					<span v-if="item.rejected">· {{ t('aronaRun.rejectedCount', {count: n(item.rejected)}) }}</span>
					<span v-if="item.pending">· {{ t('aronaRun.pendingCount', {count: n(item.pending)}) }}</span>
					<span v-if="item.durationMs !== null">· {{ t('aronaRun.totalDuration', {value: seconds(item.durationMs)}) }}</span>
				</summary>
				<div
					v-if="groupOpen(item.key)"
					class="group-body"
				>
					<ToolCallRow
						v-for="entry in item.entries"
						:key="entry.key"
						:label="label(entry.tool)"
						:call="entry.call"
						:action="entry.action"
						:operation="entry.operation"
						:receiving="streaming"
						:default-open="preferences.expandToolDetails"
					/>
				</div>
			</details>
		</template>
	</div>
</template>

<style scoped lang="scss">
.timeline-step {
	min-inline-size: 0;
}

// Metadata rows share one thin rule; consecutive rows read as a single calm rail.
.step-meta,
.reasoning,
.step-reply-collapsed,
.tool-group {
	min-inline-size: 0;
	padding-inline-start: var(--space-3);
	border-inline-start: 2px solid var(--border-subtle);
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

.is-live > .step-meta,
.is-live > .reasoning,
.is-live > .step-reply-collapsed,
.is-live > .tool-group,
.is-live > .tool-row {
	border-inline-start-color: var(--border-strong);
}

.step-meta {
	margin-block-start: var(--space-2);
}

summary {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-2);
	min-block-size: var(--target-min);
	list-style: none;
	border-radius: var(--radius-sm);
	cursor: pointer;
	overflow-wrap: anywhere;

	&::-webkit-details-marker {
		display: none;
	}

	&:hover {
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
	}

	strong {
		color: var(--text-secondary);
		font-weight: var(--weight-medium);
	}

	> span {
		min-inline-size: 0;
		font-variant-numeric: tabular-nums;
	}
}

.disclosure-icon {
	flex-shrink: 0;
	inline-size: .65em;
	transition: transform var(--motion-fast) var(--ease-standard);
}

details[open] > summary > .disclosure-icon {
	transform: rotate(90deg);
}

.group-icon {
	flex-shrink: 0;
	inline-size: .85em;
}

.group-failed {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	color: var(--danger-text);

	svg {
		inline-size: .85em;
	}
}

.step-meta-body {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding-block: var(--space-1) var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;

	p {
		margin: 0;
		overflow-wrap: anywhere;
	}

	code {
		overflow-wrap: anywhere;
	}
}

.reasoning > p {
	max-block-size: 20rem;
	margin-block: var(--space-1) var(--space-2);
	overflow-y: auto;
	padding: var(--space-3);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	color: var(--text-secondary);
	white-space: pre-wrap;
	overflow-wrap: anywhere;

	&:focus-visible {
		@include focus-ring;
	}
}

// Interim text shares the final answer's typography and left edge.
.step-reply {
	margin-block-start: var(--space-2);
}

.step-reply + .tool-row,
.step-reply + .tool-group {
	margin-block-start: var(--space-2);
}

.step-reply-collapsed .step-reply {
	margin-block: var(--space-1) var(--space-2);
}

.group-body {
	padding-block-end: var(--space-1);
}
</style>
