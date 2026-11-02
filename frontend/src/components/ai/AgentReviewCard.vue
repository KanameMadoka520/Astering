<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import type {ChatTurn, ReviewInput} from '@/client/generated'
import {DESTRUCTIVE_TOOLS, toolLabels} from './toolLabels'
import BucketImpactPreview from './BucketImpactPreview.vue'
import TaskOrderPreview from './TaskOrderPreview.vue'
const props = defineProps<{turn: ChatTurn; busy: boolean}>()
const emit = defineEmits<{review: [input: ReviewInput]}>()
const {t, locale} = useI18n({useScope: 'global'})
const args = ref('')
const answer = ref('')
const editing = ref(false)
const pending = computed(() => props.turn.result?.pending)
const toolName = computed(() => {
	const tool = pending.value?.tool ?? ''
	return toolLabels(t)[tool] || tool
})
const external = computed(() => pending.value?.external)
const orderTool = computed(() => !external.value && pending.value?.tool === 'reorder_view_tasks')
const imageTool = computed(() => ['insert_chat_image', 'update_task_description_image', 'remove_task_description_image']
	.includes(pending.value?.tool ?? ''))
const reviewHint = computed(() => external.value ? t('tcy.mcp.externalReview')
	: imageTool.value ? t(pending.value?.tool === 'remove_task_description_image'
		? 'tcy.chatImages.removeHint' : pending.value?.tool === 'update_task_description_image'
			? 'tcy.chatImages.updateHint' : 'tcy.chatImages.shareHint')
		: pending.value?.tool === 'set_task_routine_progress'
			? t('agent.routineReview.absoluteProgress')
			: pending.value?.tool === 'set_task_repeat_bucket' ? t('agent.repeatPolicy.futureOnly') : '')
const destructive = computed(() => external.value?.destructive === true
	|| DESTRUCTIVE_TOOLS.has(pending.value?.tool ?? ''))
// Deleting a bucket removes the bucket only; the generic wording would suggest its tasks go too.
const destructiveWarning = computed(() => external.value ? t('tcy.mcp.destructiveWarning')
	: pending.value?.tool === 'delete_bucket'
		? t('agent.bucketImpact.deleteWarning')
		: t('agent.destructiveWarning'))
// Bucket tools put their effect (task destinations, default and done bucket changes) in pending.after.
const BUCKET_WRITE_TOOLS = new Set([
	'create_bucket',
	'update_bucket',
	'move_task_to_bucket',
	'set_view_buckets',
	'delete_bucket',
])
const bucketImpact = computed(() => {
	if (!BUCKET_WRITE_TOOLS.has(pending.value?.tool ?? '')) return false
	try {
		const after: unknown = JSON.parse(pending.value?.after ?? '')
		return typeof after === 'object' && after !== null && !Array.isArray(after)
	} catch {
		return false
	}
})
const imageFields = computed(() => {
	if (!imageTool.value) return []
	try {
		const fields = JSON.parse(pending.value?.arguments ?? '{}')
		if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return []
		return ['id', 'attachment_id', 'image_index', 'position', 'block_index', 'alt', 'title']
			.filter(key => fields[key] !== undefined && fields[key] !== null)
			.map(key => ({
				key,
				value: key === 'position' && ['start', 'end', 'before', 'after'].includes(fields[key])
					? t(`tcy.chatImages.${fields[key]}`) : fields[key] === ''
						? t('tcy.chatImages.emptyText') : String(fields[key]),
			}))
	} catch {
		return []
	}
})
const pause = computed(() => props.turn.result?.pause)
watch(() => pending.value?.id, () => {
	args.value = pretty(pending.value?.arguments)
	editing.value = false
}, {immediate: true})
function pretty(value?: string) {
	// External JSON may contain IDs or exact decimals outside JavaScript's numeric precision.
	// Parsing validates the editor below; it must never rewrite a remote argument or snapshot.
	if (external.value) return value ?? ''
	try { return JSON.stringify(JSON.parse(value ?? ''), null, 2) } catch { return value ?? '' }
}
const valid = computed(() => { try { const parsed = JSON.parse(args.value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) } catch { return false } })
// Where an argument's current value sits in the snapshot when the names differ (the argument asks for a
// state, the snapshot records it), and argument names whose generic label would mislead for that tool.
const SNAPSHOT_FIELDS: Record<string, Record<string, string>> = {
	set_project_completed: {completed: 'is_completed'},
	check_in_task_routine: {
		completed: 'routine.completed_today',
		date: 'routine.date',
	},
	set_task_routine_progress: {
		amount: 'routine.current_amount',
		date: 'routine.date',
	},
	configure_task_routine: {
		enabled: 'routine.enabled',
		paused: 'routine.paused',
		timezone: 'routine.timezone',
		period: 'routine.period',
		reset_hour: 'routine.reset_hour',
		reset_minute: 'routine.reset_minute',
		week_start: 'routine.week_start',
		month_day: 'routine.month_day',
		target: 'routine.target',
		unit: 'routine.unit',
	},
}
function snapshotValue(entity: Record<string, unknown>, path: string): unknown {
	return path.split('.').reduce<unknown>((value, key) =>
		value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, entity)
}
const FIELD_LABELS: Record<string, Record<string, string>> = {
	check_in_task_routine: {
		completed: 'routine_completed',
		date: 'routine_date',
	},
	set_task_routine_progress: {
		amount: 'routine_amount',
		date: 'routine_date',
	},
	configure_task_routine: {
		period: 'routine_period',
		reset_hour: 'routine_reset_hour',
		reset_minute: 'routine_reset_minute',
		week_start: 'routine_week_start',
		month_day: 'routine_month_day',
		target: 'routine_target',
		unit: 'routine_unit',
	},
}
// Arguments that name the target or carry a concurrency token rather than a change.
const NOT_CHANGES = ['id', 'updates', 'task_id']
const BUCKET_LOCATORS = ['project_id', 'view_id', 'bucket_id', 'task_id']
const TOOL_NOT_CHANGES: Record<string, string[]> = {
	update_project_announcement: ['project_id', 'revision'],
	configure_task_routine: ['revision'],
	check_in_task_routine: ['revision'],
	set_task_routine_progress: ['revision'],
	set_task_repeat_bucket: BUCKET_LOCATORS,
	...Object.fromEntries([...BUCKET_WRITE_TOOLS].map((tool): [string, string[]] => [tool, BUCKET_LOCATORS])),
}
const rows = computed(() => {
	const tool = pending.value?.tool ?? ''
	// The impact preview describes bucket changes; the field table would list locators instead.
	if (bucketImpact.value || external.value || orderTool.value) return []
	try {
		const before = JSON.parse(pending.value?.before ?? 'null')
		const proposed = JSON.parse(pending.value?.arguments ?? '{}')
		if (!Array.isArray(before)) return []
		return before.flatMap((task: Record<string, unknown>) => {
			const changes = proposed.updates?.find((u: {id: number}) => u.id === task.id)?.changes ?? proposed
			return Object.entries(changes).filter(([field]) => !NOT_CHANGES.includes(field) && !TOOL_NOT_CHANGES[tool]?.includes(field)).map(([field, after]) => ({
				// An announcement snapshot names its project instead of carrying an id.
				id: task.id ?? task.task_id ?? task.project_id,
				title: task.title,
				field,
				label: FIELD_LABELS[tool]?.[field] ?? field,
				before: snapshotValue(task, SNAPSHOT_FIELDS[tool]?.[field] ?? field),
				after,
			}))
		})
	} catch { return [] }
})
function display(value: unknown, field: string) {
	const tool = pending.value?.tool
	if (tool === 'configure_task_routine') {
		if (field === 'period' && typeof value === 'string' && ['daily', 'weekly', 'monthly'].includes(value)) {
			return t(`routineSchedule.${value}`)
		}
		if (field === 'unit' && value === '') return t('agent.routineReview.noUnit')
		if (field === 'week_start' && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) {
			return new Intl.DateTimeFormat(locale.value, {weekday: 'long', timeZone: 'UTC'})
				.format(new Date(Date.UTC(2024, 0, 7 + value)))
		}
	}
	if (tool === 'set_task_repeat_bucket') {
		if (field === 'repeat_return_mode' && typeof value === 'string' && ['default', 'keep', 'bucket'].includes(value)) {
			return t(`agent.repeatPolicy.${value}`)
		}
		if (field === 'repeat_return_bucket_id' && typeof value === 'number') {
			return value > 0 ? t('agent.repeatPolicy.bucketId', {id: value}) : t('agent.repeatPolicy.noBucket')
		}
	}
	return typeof value === 'string' ? value : JSON.stringify(value) ?? '—'
}
function decide(decision: ReviewInput['decision']) {
	if (props.busy) return
	emit('review', {turn_id: props.turn.id!, operation_id: pending.value?.id ?? '', decision, arguments: decision === 'edit' ? args.value : '', answer: answer.value})
}
</script>

<template>
	<section
		v-if="pause"
		class="agent-review"
		:class="{'is-destructive': pause === 'review' && destructive}"
		:aria-label="t('agent.reviewTitle')"
	>
		<template v-if="pause === 'review' && pending">
			<h3><Icon icon="eye" /> {{ t('agent.reviewTitle') }}</h3>
			<p class="review-description">
				{{ t('agent.reviewDescription') }}
			</p>
			<p class="review-target">
				<strong :title="pending.tool">{{ toolName }}</strong> · {{ t('agent.targets', {count: pending.units}) }}
			</p>
			<dl
				v-if="external"
				class="review-external"
			>
				<dt>{{ t('tcy.mcp.externalConnection') }}</dt>
				<dd>{{ external.server_name || external.server_id }}</dd>
				<dt>{{ t('tcy.mcp.externalTool') }}</dt>
				<dd><code>{{ external.tool }}</code></dd>
			</dl>
			<dl
				v-if="imageFields.length"
				class="review-external"
			>
				<template
					v-for="field in imageFields"
					:key="field.key"
				>
					<dt>{{ t(`tcy.chatImages.fields.${field.key}`) }}</dt>
					<dd>{{ field.value }}</dd>
				</template>
			</dl>
			<p v-if="reviewHint">
				{{ reviewHint }}
			</p>
			<p
				v-if="destructive"
				class="destructive-warning"
			>
				<Icon icon="exclamation-circle" />{{ destructiveWarning }}
			</p>
			<TaskOrderPreview
				v-if="orderTool"
				:operation="pending"
			/>
			<BucketImpactPreview
				v-if="bucketImpact"
				:operation="pending"
			/>
			<div
				v-if="rows.length"
				class="change-table"
			>
				<table>
					<thead><tr><th>{{ t('agent.task') }}</th><th>{{ t('agent.field') }}</th><th>{{ t('agent.before') }}</th><th>{{ t('agent.after') }}</th></tr></thead><tbody>
						<tr
							v-for="(row, index) in rows"
							:key="index"
						>
							<td>#{{ row.id }} {{ row.title }}</td><td>{{ t(`agent.fields.${row.label}`, row.field) }}</td><td>{{ display(row.before, row.field) }}</td><td>{{ display(row.after, row.field) }}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<details v-else>
				<summary>{{ t('agent.exactArguments') }}</summary><pre>{{ pretty(pending.arguments) }}</pre>
			</details>
			<details><summary>{{ t('agent.snapshot') }}</summary><pre>{{ pretty(pending.before) }}</pre></details>
			<details v-if="bucketImpact">
				<summary>{{ t('agent.bucketImpact.afterSnapshot') }}</summary><pre>{{ pretty(pending.after) }}</pre>
			</details>
			<label v-if="editing">{{ t('agent.editArguments') }}<textarea
				v-model="args"
				class="textarea argument-editor"
				rows="10"
				maxlength="64000"
				spellcheck="false"
			/></label>
			<p v-if="editing && !valid">
				{{ t('agent.invalidJSON') }}
			</p>
			<div class="review-actions">
				<XButton
					v-if="!editing"
					icon="check"
					:disabled="busy"
					@click="decide('approve')"
				>
					{{ t('agent.approve') }}
				</XButton>
				<XButton
					v-if="editing"
					:disabled="busy || !valid"
					@click="decide('edit')"
				>
					{{ t('agent.updatePreview') }}
				</XButton>
				<XButton
					variant="secondary"
					:disabled="busy"
					@click="editing = !editing"
				>
					{{ editing ? t('misc.cancel') : t('agent.edit') }}
				</XButton>
				<XButton
					variant="secondary"
					class="reject-button"
					danger
					:disabled="busy"
					@click="decide('reject')"
				>
					{{ t('agent.reject') }}
				</XButton>
			</div>
		</template>
		<template v-else-if="pause === 'question'">
			<h3>{{ t('agent.questionTitle') }}</h3><p>{{ turn.result?.question }}</p>
			<div class="review-actions">
				<XButton
					v-for="choice in turn.result?.choices"
					:key="choice"
					variant="secondary"
					:disabled="busy"
					@click="answer = choice"
				>
					{{ choice }}
				</XButton>
			</div>
			<label>{{ t('agent.answer') }}<textarea
				v-model="answer"
				class="textarea"
				maxlength="12000"
				rows="3"
			/></label>
			<XButton
				:disabled="busy || !answer.trim()"
				@click="decide('answer')"
			>
				{{ t('agent.sendAnswer') }}
			</XButton>
		</template>
		<template v-else-if="pause === 'budget'">
			<h3>{{ t('agent.budgetPaused') }}</h3><p>{{ t('agent.budgetExplanation') }}</p>
			<p>{{ t('agent.budgetProgress', {rounds: turn.result?.budget?.rounds, roundLimit: turn.result?.budget?.round_limit, operations: turn.result?.budget?.operations, operationLimit: turn.result?.budget?.operation_limit}) }}</p>
			<XButton
				:disabled="busy"
				@click="decide('continue')"
			>
				{{ t('agent.continue') }}
			</XButton>
		</template>
	</section>
</template>

<style scoped lang="scss">
.review-external {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	gap: var(--space-2) var(--space-3);
	overflow-wrap: anywhere;

	dd { margin: 0; }
}

.agent-review {
	margin-block: var(--space-3);
	padding: var(--space-3) var(--space-4);
	border: 1px solid var(--border-default);
	border-inline-start: 3px solid var(--primary);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);
	color: var(--text-primary);
	font-size: var(--text-md);
	overflow-wrap: anywhere;

	&.is-destructive {
		border-inline-start-color: var(--danger);
	}
}

h3 {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	margin-block: 0 var(--space-2);
	color: var(--text-primary);
	font-size: var(--text-base);
	font-weight: var(--weight-semibold);

	svg {
		color: var(--text-tertiary);
	}
}

p,
label,
details {
	margin-block: var(--space-2);
}

.review-description {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.destructive-warning {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-3);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-sm);

	svg {
		flex-shrink: 0;
		color: var(--danger-text);
	}
}

label {
	display: block;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

summary {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	cursor: pointer;
}

.review-actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin-block-start: var(--space-3);
}

.change-table {
	max-inline-size: 100%;
	overflow-x: auto;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
}

table {
	inline-size: 100%;
	border-collapse: collapse;
	font-size: var(--text-sm);
}

th,
td {
	min-inline-size: 6rem;
	max-inline-size: 20rem;
	padding: var(--space-2);
	border-block-end: 1px solid var(--border-subtle);
	text-align: start;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

th {
	background: var(--surface-sunken);
	color: var(--text-secondary);
	font-weight: var(--weight-semibold);
}

tbody tr:last-child td {
	border-block-end: 0;
}

pre {
	max-block-size: 20rem;
	overflow: auto;
	white-space: pre-wrap;
	font-family: var(--font-mono);
	font-size: var(--text-xs);
}

.argument-editor {
	font-family: var(--font-mono);
	font-size: var(--text-sm);
}
</style>
