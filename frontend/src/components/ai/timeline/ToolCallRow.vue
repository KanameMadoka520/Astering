<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'
import type {Action, Operation, ToolCall} from '@/client/generated'
import WebSearchEvidence from '@/components/ai/WebSearchEvidence.vue'
import TaskOrderReceipt from '@/components/ai/TaskOrderReceipt.vue'
import {parseTaskOrderResult} from '@/helpers/taskOrder'
import {usePreferredOpen} from '@/composables/useAronaDisplayPreferences'
import {argumentSummary, callArguments, callName, isSteeringReplan} from '@/helpers/aronaTimeline'

// Plain props only: a completed row keeps identical props between live frames and does not re-render.
const props = withDefaults(defineProps<{
	label: string
	call?: ToolCall
	action?: Action
	operation?: Operation
	receiving?: boolean
	defaultOpen?: boolean
}>(), {
	call: undefined,
	action: undefined,
	operation: undefined,
})
const {t, n} = useI18n({useScope: 'global'})
const {open, onToggle} = usePreferredOpen(() => props.defaultOpen)

// A rejected review decision is never shown as a proposal still waiting, nor as another call's result.
type RowState = 'succeeded' | 'failed' | 'running' | 'rejected' | 'skipped' | 'draft'
const ICONS: Record<RowState, IconProp> = {succeeded: 'check', failed: 'exclamation-circle', running: 'ellipsis-h', rejected: 'times', skipped: 'redo', draft: 'code'}
const state = computed<RowState>(() => {
	if (isSteeringReplan(props.action, props.operation)) return 'skipped'
	if (props.action) return props.action.success ? 'succeeded' : 'failed'
	if (props.operation) return props.operation.status === 'rejected' ? 'rejected' : 'running'
	return 'draft'
})
const stateText = computed(() => {
	switch (state.value) {
		case 'succeeded': return t('tcymc.text.succeeded')
		case 'failed': return t('tcymc.text.failed')
		case 'running': return t('flow.toolExecuting')
		case 'rejected': return t('aronaRun.toolRejected')
		case 'skipped': return t('aronaSteer.skippedTool')
		default: return props.receiving ? t('flow.toolDraft') : t('flow.toolProposed')
	}
})
const duration = computed(() => typeof props.action?.duration_ms === 'number'
	? t('chat.seconds', {value: n(props.action.duration_ms / 1000, {minimumFractionDigits: 2, maximumFractionDigits: 2})})
	: '')
const argumentText = computed(() => {
	if (props.action) return argumentSummary(props.action.arguments)
	if (props.operation?.arguments) return argumentSummary(props.operation.arguments)
	// Unwrapped only when the backend would run the inner tool; a malformed envelope stays one invoke_tool row.
	return argumentSummary(callArguments(props.call))
})
const externalSource = computed(() => {
	const external = props.operation?.external
	if (external) return `${external.server_name || external.server_id} · ${external.tool}`
	const tool = props.action?.tool ?? props.operation?.tool ?? callName(props.call)
	if (tool !== 'call_mcp_tool') return ''
	try {
		const raw = props.action?.arguments ?? props.operation?.arguments ?? callArguments(props.call)
		const args = JSON.parse(raw)
		if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
		return [args.server_id, args.tool_name].filter(value => typeof value === 'string').join(' · ')
	} catch {
		return ''
	}
})
const taskOrder = computed(() => {
	if (props.action?.tool !== 'reorder_view_tasks' || !props.action.success || props.operation?.external) return undefined
	try {
		return parseTaskOrderResult(JSON.parse(props.action.result ?? ''), JSON.parse(props.action.arguments ?? ''))
	} catch {
		return undefined
	}
})
function pretty(value?: string) {
	if (!value) return t('chat.unavailable')
	try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
}
</script>

<template>
	<div
		class="tool-row"
		:class="`is-${state}`"
	>
		<details
			class="tool-disclosure"
			:open="open"
			@toggle="onToggle"
		>
			<summary>
				<Icon
					class="disclosure-icon"
					icon="chevron-right"
				/>
				<Icon
					class="state-icon"
					:icon="ICONS[state]"
				/>
				<span class="tool-name">{{ label }}</span>
				<span
					v-if="externalSource"
					class="tool-args"
					:title="externalSource"
				>{{ t('tcy.mcp.externalSource', {name: externalSource}) }}</span>
				<span class="tool-state">{{ stateText }}</span>
				<span
					v-if="duration"
					class="tool-time"
				>{{ duration }}</span>
				<span
					v-if="argumentText"
					class="tool-args"
				>{{ argumentText }}</span>
			</summary>
			<!-- Arguments and results can be large; render them only while open. -->
			<div
				v-if="open"
				class="tool-body"
			>
				<p
					v-if="state === 'skipped'"
					class="tool-note"
				>
					{{ t('aronaSteer.skippedNote') }}
				</p>
				<template v-if="action">
					<WebSearchEvidence
						v-if="action.search"
						:result="action.search"
					/>
					<strong>{{ t('chat.arguments') }}</strong>
					<pre tabindex="0">{{ pretty(action.arguments) }}</pre>
					<strong>{{ t('chat.actualResult') }}</strong>
					<pre tabindex="0">{{ pretty(action.result) }}</pre>
				</template>
				<template v-else-if="operation">
					<p
						v-if="state === 'rejected'"
						class="tool-note"
					>
						{{ t('aronaRun.rejectedNote') }}
					</p>
					<strong>{{ t('chat.arguments') }}</strong>
					<pre tabindex="0">{{ pretty(operation.arguments || call?.function?.arguments) }}</pre>
				</template>
				<template v-else>
					<strong>{{ t('aronaRun.proposedArguments') }}</strong>
					<pre tabindex="0">{{ pretty(call?.function?.arguments) }}</pre>
				</template>
			</div>
		</details>
		<TaskOrderReceipt
			v-if="taskOrder"
			:result="taskOrder"
		/>
	</div>
</template>

<style scoped lang="scss">
.tool-row {
	min-inline-size: 0;
	padding-inline-start: var(--space-3);
	border-inline-start: 2px solid var(--border-subtle);
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

summary {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
	min-block-size: var(--target-min);
	list-style: none;
	white-space: nowrap;
	border-radius: var(--radius-sm);
	cursor: pointer;

	&::-webkit-details-marker {
		display: none;
	}

	&:hover {
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.disclosure-icon {
	flex-shrink: 0;
	inline-size: .65em;
	transition: transform var(--motion-fast) var(--ease-standard);
}

.tool-disclosure[open] > summary > .disclosure-icon {
	transform: rotate(90deg);
}

.state-icon {
	flex-shrink: 0;
	inline-size: .85em;
}

// Every text part may shrink, so a long name or status never pushes the row past a 320px screen.
.tool-name,
.tool-state,
.tool-args {
	min-inline-size: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.tool-name {
	flex: 0 1 auto;
	color: var(--text-secondary);
	font-weight: var(--weight-medium);
}

.tool-state {
	flex: 0 1 auto;
}

.tool-time {
	flex-shrink: 0;
	font-variant-numeric: tabular-nums;
}

.tool-args {
	flex: 1 1 0;
	font-family: var(--font-mono);
	font-size: var(--text-xs);
}

.is-failed summary,
.is-failed .tool-name {
	color: var(--danger-text);
}

// Declined in review and never executed: a dashed rail, like a stopped subagent, so it never reads as finished work.
.tool-row.is-rejected,
.tool-row.is-skipped {
	border-inline-start-style: dashed;
}

.tool-note {
	margin: var(--space-1) 0 0;
	color: var(--text-secondary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
	overflow-wrap: anywhere;
}

.tool-body {
	padding-block: var(--space-1) var(--space-2);

	> strong {
		display: block;
		margin-block-start: var(--space-2);
		color: var(--text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}
}

pre {
	max-block-size: 20rem;
	margin-block: var(--space-1) 0;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	border-radius: var(--radius-sm);
	font-family: var(--font-mono);
	font-size: var(--text-xs);

	&:focus-visible {
		@include focus-ring;
	}
}

@media (width <= 480px) {
	.tool-args {
		display: none;
	}
}
</style>
