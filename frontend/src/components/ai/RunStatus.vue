<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useNow} from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import {useAronaPresenting} from '@/composables/useAronaPresentation'
import {useQuery} from '@tanstack/vue-query'
import type {RunResult} from '@/client/generated'
import {aiSettingsQuery} from '@/client/queries/tcyAi'
import CacheUsage from '@/components/ai/CacheUsage.vue'
import {toolLabels} from '@/components/ai/toolLabels'
import {callName, compactionStatus, liveStepIndex} from '@/helpers/aronaTimeline'
import {
	contextOccupancy,
	currentRequest,
	inFlight,
	subagentCounts,
	turnTotals,
	type ContextSource,
	type RequestUsage,
	type WorkUsage,
} from '@/helpers/aronaRunMetrics'

const props = withDefaults(defineProps<{
	result?: RunResult
	running?: boolean
}>(), {
	result: undefined,
})
const {t, n} = useI18n({useScope: 'global'})
const open = ref(false)
// The clock ticks only while a model request streams on screen; compaction and tool stages never tick it.
const presenting = useAronaPresenting()
const {now, pause, resume} = useNow({interval: 1000, controls: true})
watch(() => props.running && props.result?.stage === 'model' && presenting.value, ticking => {
	if (!ticking) return pause()
	// Shown again after a pause, the clock reads the real time at once instead of a second later.
	now.value = new Date()
	resume()
}, {immediate: true})

const request = computed(() => currentRequest(props.result, props.running ? now.value.getTime() : undefined))
const context = computed(() => contextOccupancy(props.result))
const totals = computed(() => turnTotals(props.result, props.running))
const pending = computed(() => inFlight(props.result, props.running))
const subagents = computed(() => subagentCounts(props.result))
const segments = computed(() => props.result?.segment_count ?? 0)
const hasWork = computed(() => Boolean(props.result?.steps?.length || props.result?.auto_compactions?.length || props.result?.subagents?.length))
const labels = computed(() => toolLabels(t))

// Read from the settings the assistant page already loaded; this row never fetches them itself.
const settings = useQuery({...aiSettingsQuery(), enabled: false})
// Auto-compaction is a connection setting. A turn that compacted had it on, whatever the setting says now.
const autoCompactOff = computed(() => {
	const result = props.result
	const data = settings.data.value
	if (!data || result?.auto_compactions?.length) return false
	const id = result?.configuration?.connection_id || data.assistant
	return Boolean(id && data.connections.find(connection => connection.id === id)?.disable_auto_compact)
})

const TOOL_STAGES: ReadonlySet<string> = new Set(['model', 'validation', 'prepare', 'execute'])
const stageDetail = computed(() => {
	const result = props.result
	if (result?.stage === 'compacting') {
		const progress = result.auto_compactions?.filter(event => compactionStatus(event) === 'running').at(-1)?.progress
		return progress?.batch && progress.batches && progress.attempt ? t('flow.compactBatch', {batch: n(progress.batch), total: n(progress.batches), attempt: n(progress.attempt)}) : ''
	}
	if (!TOOL_STAGES.has(result?.stage ?? '')) return ''
	// During the model stage only the streaming round's own drafts count, never the previous round's.
	const tool = result?.stage === 'model'
		? callName(result.steps?.[liveStepIndex(result, props.running)]?.tool_calls?.at(-1))
		: result?.operations?.at(-1)?.tool || result?.actions?.at(-1)?.tool || ''
	return tool ? labels.value[tool] || tool : ''
})

function seconds(ms: number) {
	return t('chat.seconds', {value: n(ms / 1000, {minimumFractionDigits: 2, maximumFractionDigits: 2})})
}
function percent(value: number) {
	return n(value, {style: 'percent', maximumFractionDigits: 1})
}
function unreported() {
	return props.running ? t('flow.usagePending') : t('aronaRun.usageUnreported')
}
function outputPart(output: number | null, reasoning: number | null): string[] {
	if (output === null) return []
	return [reasoning === null ? t('aronaRun.output', {value: n(output)}) : t('aronaRun.outputReasoning', {value: n(output), reasoning: n(reasoning)})]
}
function requestUsageParts(usage: RequestUsage | null, live: boolean): string[] {
	if (!usage) return [live ? t('flow.usagePending') : t('aronaRun.usageUnreported')]
	const parts: string[] = []
	if (usage.input !== null) parts.push(usage.cached === null ? t('aronaRun.input', {value: n(usage.input)}) : t('aronaRun.inputCached', {value: n(usage.input), cached: n(usage.cached)}))
	parts.push(...outputPart(usage.output, usage.reasoning))
	return parts.length ? parts : [t('aronaRun.usageUnreported')]
}
function usageBrief(usage: RequestUsage | null, fallback: string): string {
	const parts = usage ? [...(usage.input === null ? [] : [t('aronaRun.input', {value: n(usage.input)})]), ...outputPart(usage.output, null)] : []
	return parts.length ? parts.join(' · ') : fallback
}
// "2 subagents (5 requests · input … · output …)": a part of the total, labeled with only what was reported.
function workItem(item: string, work: WorkUsage, fallback: string, requests = 0): string {
	let usage = usageBrief(work.usage, fallback)
	if (work.usage && work.reported < work.count) usage += ` · ${t('aronaRun.partialItems', {reported: n(work.reported), total: n(work.count)})}`
	if (requests) usage = `${t('aronaRun.requestCount', {count: n(requests)}, requests)} · ${usage}`
	return t('aronaRun.withUsage', {item, usage})
}
function compactionCount(count: number) {
	return t('aronaRun.compactionCount', {count: n(count)}, count)
}
function subagentCount(count: number) {
	return t('aronaRun.subagentCount', {count: n(count)}, count)
}

type Row = {scope: 'request' | 'context' | 'turn' | 'inflight' | 'segment' | 'subagents', label: string, text: string, detail?: string}

const requestRow = computed((): Row | null => {
	const value = request.value
	if (!value) return null
	const round = value.round ?? '–'
	const parts: string[] = []
	if (value.elapsedMs !== null) parts.push(seconds(value.elapsedMs))
	if (value.firstTokenMs !== null) parts.push(t('aronaRun.firstToken', {value: seconds(value.firstTokenMs)}))
	if (value.firstTextMs !== null) parts.push(t('aronaRun.firstText', {value: seconds(value.firstTextMs)}))
	if (value.live) {
		parts.push(value.streaming ? t('flow.streaming') : t('flow.waitingData'))
		if (value.observedCharacters !== null) parts.push(t('flow.observedCharacters', {count: n(value.observedCharacters)}))
	}
	parts.push(...requestUsageParts(value.usage, value.live))
	return {
		scope: 'request',
		label: value.live ? t('aronaRun.currentRequest', {round}) : t('aronaRun.lastRequest', {round}),
		text: parts.join(' · '),
	}
})

// Provider measurements and estimates are told apart on every reading.
const SOURCE_KEYS: Record<ContextSource, string> = {
	provider: 'aronaRun.contextProvider',
	request: 'aronaRun.contextProvider',
	calibrated: 'aronaRun.contextCalibrated',
	estimate: 'aronaRun.contextEstimate',
}

const contextRow = computed((): Row => {
	const value = context.value
	if (!value) return {scope: 'context', label: t('aronaRun.context'), text: unreported()}
	const parts = [
		value.cached === null ? t('cacheEfficiency.tokens', {value: n(value.input)}) : t('aronaRun.contextCached', {value: n(value.input), cached: n(value.cached)}),
		t(SOURCE_KEYS[value.source]),
	]
	// Without a known capacity there is nothing honest to divide by.
	parts.push(value.window !== null && value.percent !== null
		? t('aronaRun.contextShare', {percent: percent(value.percent), window: n(value.window)})
		: t('aronaRun.capacityUnset'))
	// A threshold is only shown while auto-compaction is on for the connection; zero means none.
	if (autoCompactOff.value) parts.push(t('aronaRun.compactOff'))
	else if (value.threshold !== null) {
		parts.push(value.window === null
			? t('aronaRun.compactThresholdPolicy', {value: n(value.threshold)})
			: t('aronaRun.compactThreshold', {value: n(value.threshold)}))
	}
	if (!props.running && value.maxOutput !== null) parts.push(t('aronaRun.maxOutput', {value: n(value.maxOutput)}))
	return {
		scope: 'context',
		label: value.round === null ? t('aronaRun.context') : t('aronaRun.contextRound', {round: value.round}),
		text: parts.join(' · '),
	}
})

const turnRow = computed((): Row | null => {
	const value = totals.value
	// Nothing has finished yet: the request row already covers the work in flight.
	if (props.running && !value.requests && !value.compactions.count && !value.subagents.count) return null
	let label = t('aronaRun.turnTotal', {count: n(value.requests)}, value.requests)
	if (value.allSearchRequests) label += ` · ${t('aronaRun.searchRequests', {count: n(value.allSearchRequests)}, value.allSearchRequests)}`
	if (props.running) label += ` · ${t('aronaRun.turnSettled')}`
	const parts: string[] = []
	const reported = value.input !== null || value.output !== null
	if (!reported) parts.push(unreported())
	if (value.input !== null) parts.push(t('aronaRun.input', {value: n(value.input)}))
	// Same requests as the input beside it; when some did not report cache, the row says how many did.
	if (value.cacheRate !== null) {
		parts.push(value.cacheMeasured < value.requests
			? t('aronaRun.cacheRateCoverage', {rate: percent(value.cacheRate), measured: n(value.cacheMeasured), total: n(value.requests)})
			: t('aronaRun.cacheRate', {rate: percent(value.cacheRate)}))
	}
	parts.push(...outputPart(value.output, value.reasoning))
	if (value.partial && reported) {
		parts.push(value.reportedRequests < value.requests
			? t('aronaRun.partial', {reported: n(value.reportedRequests), total: n(value.requests)})
			: t('aronaRun.partialSome'))
	}
	const result = props.result
	if (!props.running && result) {
		if (result.duration_ms != null) parts.push(t('aronaRun.totalTime', {value: seconds(result.duration_ms)}))
		if (result.first_token_ms != null) parts.push(t('aronaRun.firstToken', {value: seconds(result.first_token_ms)}))
		if (result.first_text_ms != null) parts.push(t('aronaRun.firstText', {value: seconds(result.first_text_ms)}))
	}
	// Compactions and subagents are itemized inside the total, never added on top of it.
	let detail: string | undefined
	if (value.compactions.count || value.subagents.count) {
		const fallback = t('aronaRun.usageUnreported')
		const items = [t('aronaRun.modelRequests', {count: n(value.modelRequests)}, value.modelRequests)]
		if (value.searchRequests) items.push(t('aronaRun.searchCount', {count: n(value.searchRequests)}, value.searchRequests))
		if (value.compactions.count) items.push(workItem(compactionCount(value.compactions.count), value.compactions, fallback, value.compactions.requests))
		if (value.subagents.count) items.push(workItem(subagentCount(value.subagents.count), value.subagents, fallback, value.subagents.requests))
		detail = t('aronaRun.includes', {items: items.join(' · ')})
	}
	return {scope: 'turn', label, text: parts.join(' · '), detail}
})

// Running work the server has not added to the turn usage yet; shown apart so it is never mixed into the total.
const inflightRow = computed((): Row | null => {
	const value = pending.value
	// The streaming request alone is already the request row; repeat it here only once its usage is reported.
	if (!value || (!value.compactions && !value.subagents && !value.reported)) return null
	const sources: string[] = []
	if (value.request) sources.push(t('aronaRun.inFlightRequest'))
	if (value.compactions) sources.push(compactionCount(value.compactions))
	if (value.subagents) sources.push(subagentCount(value.subagents))
	const work: WorkUsage = {count: Number(value.request) + value.compactions + value.subagents, reported: value.reported, usage: value.usage}
	return {scope: 'inflight', label: t('aronaRun.inFlight'), text: workItem(sources.join(' + '), work, t('flow.usagePending'))}
})

const segmentRow = computed((): Row | null => segments.value > 1
	? {scope: 'segment', label: t('aronaRun.segment'), text: t(props.running ? 'aronaRun.segmentRunning' : 'aronaRun.segmentDone', {count: n(segments.value)})}
	: null)

const subagentsRow = computed((): Row | null => {
	const counts = subagents.value
	const total = counts.running + counts.completed + counts.failed + counts.stopped
	if (!total) return null
	const parts = [t('aronaRun.subagent.experimental')]
	if (counts.running) parts.push(t('aronaRun.subagentRunningCount', {count: n(counts.running)}))
	if (counts.completed) parts.push(t('aronaRun.subagentCompletedCount', {count: n(counts.completed)}))
	if (counts.failed) parts.push(t('aronaRun.failedCount', {count: n(counts.failed)}))
	if (counts.stopped) parts.push(t('aronaRun.subagentStoppedCount', {count: n(counts.stopped)}))
	return {scope: 'subagents', label: subagentCount(total), text: parts.join(' · ')}
})

const rows = computed(() => [requestRow.value, contextRow.value, turnRow.value, inflightRow.value, segmentRow.value, subagentsRow.value]
	.filter((row): row is Row => row !== null))

const summary = computed(() => {
	const value = totals.value
	if (!value.requests) return t('chat.requestDetails')
	const parts = [t('aronaRun.summary', {count: n(value.requests)}, value.requests)]
	if (value.input !== null) parts.push(t('aronaRun.summaryInput', {value: n(value.input)}))
	parts.push(...outputPart(value.output, null))
	if (value.input === null && value.output === null) parts.push(t('aronaRun.usageUnreported'))
	if (value.compactions.count) parts.push(compactionCount(value.compactions.count))
	if (value.subagents.count) parts.push(subagentCount(value.subagents.count))
	if (props.result?.duration_ms != null) parts.push(t('aronaRun.totalTime', {value: seconds(props.result.duration_ms)}))
	return parts.join(' · ')
})
</script>

<template>
	<div
		v-if="running"
		class="run-status live-run-panel"
	>
		<!-- Figures change every frame; screen readers get the stage line and the card's polite status instead. -->
		<p class="run-stage">
			<span
				class="working-orbit"
				aria-hidden="true"
			/>
			<strong>{{ t(`flow.stage_${result?.stage || 'model'}`) }}<template v-if="stageDetail"> · {{ stageDetail }}</template></strong>
		</p>
		<dl
			v-if="hasWork || context"
			class="run-figures"
			aria-hidden="true"
		>
			<div
				v-for="row in rows"
				:key="row.scope"
				:data-scope="row.scope"
			>
				<dt>{{ row.label }}</dt>
				<dd>{{ row.text }}</dd>
				<dd
					v-if="row.detail"
					class="run-detail"
				>
					{{ row.detail }}
				</dd>
			</div>
		</dl>
	</div>
	<details
		v-else
		class="run-status run-summary"
		@toggle="open = ($event.target as HTMLDetailsElement).open"
	>
		<summary>{{ summary }}</summary>
		<template v-if="open">
			<dl
				v-if="hasWork"
				class="run-figures"
			>
				<div
					v-for="row in rows"
					:key="row.scope"
					:data-scope="row.scope"
				>
					<dt>{{ row.label }}</dt>
					<dd>{{ row.text }}</dd>
					<dd
						v-if="row.detail"
						class="run-detail"
					>
						{{ row.detail }}
					</dd>
					<dd
						v-if="row.scope === 'turn'"
						class="run-cache"
					>
						<CacheUsage :usages="totals.requestUsages" />
					</dd>
				</div>
			</dl>
			<p
				v-if="hasWork"
				class="run-note"
			>
				{{ t('aronaRun.scopeNoteRuntime') }} {{ t('aronaRun.scopeNoteCache') }}
			</p>
			<slot />
		</template>
	</details>
</template>

<style scoped lang="scss">
.run-status {
	min-inline-size: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.live-run-panel {
	margin-block-start: var(--space-3);
}

.run-stage {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--control-height-sm);
	margin: 0;

	strong {
		min-inline-size: 0;
		color: var(--text-primary);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}
}

.run-figures {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	margin: var(--space-1) 0 0;
	padding-inline-start: var(--space-3);
	border-inline-start: 2px solid var(--border-subtle);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;

	> div {
		display: grid;
		grid-template-columns: minmax(6rem, 11rem) minmax(0, 1fr);
		gap: 0 var(--space-3);
	}

	dt {
		color: var(--text-tertiary);
		overflow-wrap: anywhere;
	}

	dd {
		min-inline-size: 0;
		margin: 0;
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}
}

// Provisional figures are visibly set apart from the settled total.
[data-scope='inflight'] dd {
	color: var(--text-tertiary);
}

.run-detail,
.run-cache {
	grid-column: 2;
	margin-block-start: var(--space-1);
}

.run-detail {
	color: var(--text-tertiary);
}

.run-summary {
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	> summary {
		min-block-size: var(--target-min);
		padding-block: var(--space-1);
		border-radius: var(--radius-sm);
		cursor: pointer;
		font-variant-numeric: tabular-nums;
		line-height: var(--leading-normal);
		overflow-wrap: anywhere;

		&:hover {
			color: var(--text-primary);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	.run-figures {
		margin-block: var(--space-1) var(--space-2);
	}
}

.run-note {
	margin: 0 0 var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.working-orbit {
	display: inline-block;
	flex-shrink: 0;
	inline-size: .75rem;
	block-size: .75rem;
	border: 2px solid var(--border-default);
	border-block-start-color: var(--primary);
	border-radius: 50%;
	animation: working-spin .85s linear infinite;
}

@keyframes working-spin {
	to {
		transform: rotate(360deg);
	}
}

@media (width <= 480px) {
	.run-figures > div {
		grid-template-columns: minmax(0, 1fr);
	}

	.run-detail,
	.run-cache {
		grid-column: 1;
	}
}

@media (prefers-reduced-motion: reduce) {
	.working-orbit {
		animation: none;
	}
}
</style>
