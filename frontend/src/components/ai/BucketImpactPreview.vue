<script setup lang="ts">
import {computed, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Operation} from '@/client/generated'

// What a pending bucket tool will do, in sentences built from the server's preview (pending.before is
// the state it read, pending.after the result it plans). Only fields the server sent are described.
const props = defineProps<{operation: Operation}>()
const {t} = useI18n({useScope: 'global'})
const headingId = useId()

type ImpactKey =
	| 'bucket'
	| 'tasks-moved'
	| 'tasks-deleted'
	| 'done-tasks'
	| 'default-bucket'
	| 'done-bucket'
	| 'samples'
	| 'move'
	| 'done-state'
	| 'create'
	| 'update'
	| 'warning'
	| 'note'
type Sample = {id: number, title: string, done: boolean}
type Impact = {key: ImpactKey, sentences: string[], samples?: Sample[], notes?: string[]}
type Snapshot = Record<string, unknown>

function isRecord(value: unknown): value is Snapshot {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// create_bucket snapshots the board ({view, buckets}); the other tools snapshot one entity in an array.
function snapshot(value?: string): Snapshot | undefined {
	try {
		const parsed: unknown = JSON.parse(value ?? '')
		const entity: unknown = Array.isArray(parsed) ? parsed[0] : parsed
		return isRecord(entity) ? entity : undefined
	} catch {
		return undefined
	}
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

// A bucket or task by its title, else by its id; id 0 means "none" and has no name.
function named(id: number | undefined, title: unknown): string | undefined {
	const known = text(title)
	if (known) return t('agent.bucketImpact.quoted', {title: known})
	return id ? `#${id}` : undefined
}

function limitText(limit: number) {
	return limit > 0 ? t('agent.bucketImpact.limitValue', {limit}, limit) : t('agent.bucketImpact.limitNone')
}

function createImpacts(after: Snapshot): Impact[] {
	const title = named(0, after.title)
	if (!title) return []
	const sentences = [t('agent.bucketImpact.create', {title})]
	const left = count(after.after_bucket_id)
	const leftName = named(left, after.after_bucket_title)
	if (left === 0) sentences.push(t('agent.bucketImpact.positionFirst'))
	else if (leftName) sentences.push(t('agent.bucketImpact.positionAfter', {bucket: leftName}))
	const limit = count(after.limit)
	if (limit === 0) sentences.push(t('agent.bucketImpact.noLimit'))
	else if (limit !== undefined) sentences.push(t('agent.bucketImpact.limit', {limit}, limit))
	return [{key: 'create', sentences}]
}

function updateImpacts(before: Snapshot | undefined, after: Snapshot): Impact[] {
	const impacts: Impact[] = []
	const bucket = named(count(before?.bucket_id) ?? count(before?.id), before?.title)
	if (bucket) impacts.push({key: 'bucket', sentences: [t('agent.bucketImpact.updateBucket', {bucket})]})

	const changes: string[] = []
	const titleBefore = text(before?.title)
	const title = text(after.title)
	if (titleBefore && title && title !== titleBefore) {
		changes.push(t('agent.bucketImpact.rename', {title: named(0, title)}))
	}
	const limitBefore = count(before?.limit)
	const limit = count(after.limit)
	if (limitBefore !== undefined && limit !== undefined && limit !== limitBefore) {
		changes.push(t('agent.bucketImpact.limitChange', {from: limitText(limitBefore), to: limitText(limit)}))
	}
	const leftBefore = count(before?.after_bucket_id)
	const left = count(after.after_bucket_id)
	const leftName = named(left, after.after_bucket_title)
	if (leftBefore !== undefined && left !== undefined && left !== leftBefore) {
		if (left === 0) changes.push(t('agent.bucketImpact.moveFirst'))
		else if (leftName) changes.push(t('agent.bucketImpact.moveAfter', {bucket: leftName}))
	}
	const comparable = Boolean(titleBefore && title) && limitBefore !== undefined && limit !== undefined
		&& leftBefore !== undefined && left !== undefined
	if (changes.length) impacts.push({key: 'update', sentences: changes})
	else if (comparable) impacts.push({key: 'update', sentences: [t('agent.bucketImpact.unchanged')]})

	const tasks = count(after.task_count)
	const warning = text(after.warning)
	if (warning?.startsWith('limit_below_task_count') && tasks !== undefined && limit) {
		const sentence = t('agent.bucketImpact.limitBelowCount', {count: tasks, limit}, tasks)
		impacts.push({key: 'warning', sentences: [sentence]})
	} else if (warning) {
		// A warning this card has no wording for is still shown, as the server wrote it.
		impacts.push({key: 'warning', sentences: [warning]})
	}
	return impacts
}

function moveImpacts(before: Snapshot | undefined, after: Snapshot): Impact[] {
	const impacts: Impact[] = []
	const task = named(count(before?.task_id) ?? count(before?.id), before?.title)
	const from = named(count(before?.bucket_id), before?.bucket_title)
	const to = named(count(after.bucket_id), after.bucket_title)
	const target = named(0, before?.target_bucket_title)
	const listed = strings(after.effects)
	const effects = new Set(listed.length ? listed : strings(before?.effects))
	const repeating = effects.has('repeating_task_advances_dates')

	if (task && to) {
		let sentence: string
		if (effects.has('already_in_bucket')) {
			sentence = t('agent.bucketImpact.alreadyThere', {task, bucket: to})
		} else if (repeating && target) {
			sentence = effects.has('stays_in_current_bucket')
				? t('agent.bucketImpact.repeatingStays', {task, target, bucket: to})
				: t('agent.bucketImpact.repeatingReturns', {task, target, bucket: to})
		} else if (from) {
			sentence = t('agent.bucketImpact.move', {task, from, to})
		} else {
			sentence = t('agent.bucketImpact.moveInto', {task, to})
		}
		impacts.push({key: 'move', sentences: [sentence]})
	}

	const state: string[] = []
	if (effects.has('marks_task_done')) {
		state.push(t('agent.bucketImpact.becomesDone'))
		const boards = Array.isArray(after.done_views) ? after.done_views.length : 0
		if (effects.has('also_moves_into_done_bucket_of_other_views') && boards > 0) {
			state.push(t('agent.bucketImpact.otherDoneBuckets', {count: boards}, boards))
		}
	} else if (effects.has('reopens_task')) {
		state.push(t('agent.bucketImpact.reopened'))
	} else if (repeating) {
		state.push(t('agent.bucketImpact.repeatingDone'))
	} else if (typeof after.done === 'boolean') {
		state.push(after.done ? t('agent.bucketImpact.staysDone') : t('agent.bucketImpact.staysOpen'))
	}
	if (state.length) impacts.push({key: 'done-state', sentences: state})
	return impacts
}

function viewImpacts(before: Snapshot | undefined, after: Snapshot): Impact[] {
	const impacts: Impact[] = []
	const titles = new Map<number, string>()
	const buckets = before?.buckets
	if (Array.isArray(buckets)) {
		buckets.forEach((bucket: unknown) => {
			if (!isRecord(bucket)) return
			const id = count(bucket.id)
			const title = text(bucket.title)
			if (id && title) titles.set(id, title)
		})
	}
	const slot = (id: number, title?: unknown) => id
		? named(id, title ?? titles.get(id))
		: t('agent.bucketImpact.notSet')

	const defaultBefore = count(before?.default_bucket_id)
	const defaultBucket = count(after.default_bucket_id)
	if (defaultBucket !== undefined) {
		const to = slot(defaultBucket, after.default_bucket_title)
		let sentence = t('agent.bucketImpact.defaultUnset')
		if (defaultBefore !== undefined && defaultBefore !== defaultBucket) {
			sentence = t('agent.bucketImpact.defaultChange', {from: slot(defaultBefore), to})
		} else if (defaultBucket) {
			sentence = t('agent.bucketImpact.defaultStays', {bucket: to})
		}
		const sentences = [sentence]
		if (!defaultBucket) sentences.push(t('agent.bucketImpact.defaultLeftmost'))
		impacts.push({key: 'default-bucket', sentences})
	}

	const doneBefore = count(before?.done_bucket_id)
	const doneBucket = count(after.done_bucket_id)
	if (doneBucket !== undefined) {
		const to = slot(doneBucket, after.done_bucket_title)
		let sentence = t('agent.bucketImpact.doneUnset')
		if (doneBefore !== undefined && doneBefore !== doneBucket) {
			sentence = t('agent.bucketImpact.doneChange', {from: slot(doneBefore), to})
		} else if (doneBucket) {
			sentence = t('agent.bucketImpact.doneStays', {bucket: to})
		}
		impacts.push({key: 'done-bucket', sentences: [sentence]})
	}

	const stale = strings(after.stale_ids_cleared).flatMap(field => {
		if (field === 'default_bucket_id') return [t('agent.bucketImpact.staleDefault')]
		if (field === 'done_bucket_id') return [t('agent.bucketImpact.staleDone')]
		return []
	})
	if (stale.length) impacts.push({key: 'warning', sentences: stale})
	if (text(after.note)) impacts.push({key: 'note', sentences: [t('agent.bucketImpact.viewNote')]})
	return impacts
}

function deleteImpacts(before: Snapshot | undefined, after: Snapshot): Impact[] {
	const impacts: Impact[] = []
	const bucket = named(count(before?.bucket_id) ?? count(after.deleted_bucket_id), before?.title)
	if (bucket) impacts.push({key: 'bucket', sentences: [t('agent.bucketImpact.deleteBucket', {bucket})]})

	const moved = count(after.tasks_moved) ?? count(before?.tasks_moved)
	const destination = named(
		count(before?.move_to_bucket_id) ?? count(after.move_to_bucket_id),
		before?.move_to_bucket_title,
	)
	if (moved === 0) {
		impacts.push({key: 'tasks-moved', sentences: [t('agent.bucketImpact.noTasksToMove')]})
	} else if (moved !== undefined) {
		const sentence = destination
			? t('agent.bucketImpact.tasksMoved', {count: moved, bucket: destination}, moved)
			: t('agent.bucketImpact.tasksMovedElsewhere', {count: moved}, moved)
		impacts.push({key: 'tasks-moved', sentences: [sentence]})
	}

	// Deleting a bucket never deletes tasks; the server repeats that in every preview as tasks_deleted.
	const deleted = count(after.tasks_deleted) ?? count(before?.tasks_deleted) ?? 0
	const deletion = deleted
		? t('agent.bucketImpact.tasksDeleted', {count: deleted}, deleted)
		: t('agent.bucketImpact.noTasksDeleted')
	impacts.push({key: 'tasks-deleted', sentences: [deletion]})

	const done = count(before?.done_tasks_moved)
	if (moved && done !== undefined) {
		const sentence = done
			? t('agent.bucketImpact.doneTasks', {count: done}, done)
			: t('agent.bucketImpact.noDoneTasks')
		impacts.push({key: 'done-tasks', sentences: [sentence]})
	}

	const clears = strings(before?.clears)
	if (before?.is_default_bucket === true || clears.includes('default_bucket_id')) {
		impacts.push({key: 'default-bucket', sentences: [t('agent.bucketImpact.deleteDefault')]})
	}
	if (before?.is_done_bucket === true || clears.includes('done_bucket_id')) {
		impacts.push({key: 'done-bucket', sentences: [t('agent.bucketImpact.deleteDone')]})
	}

	const listed = before?.sample_tasks
	const samples = (Array.isArray(listed) ? listed : []).flatMap((sample: unknown): Sample[] => {
		if (!isRecord(sample)) return []
		const id = count(sample.id)
		const title = text(sample.title)
		return id && title ? [{id, title, done: sample.done === true}] : []
	})
	// The server lists at most 20 tasks and leaves out titles from projects the user cannot read.
	const hidden = count(before?.hidden_sample_tasks) ?? 0
	const rest = moved === undefined ? 0 : Math.max(0, moved - samples.length - hidden)
	if (samples.length || hidden) {
		impacts.push({
			key: 'samples',
			sentences: samples.length ? [t('agent.bucketImpact.samples')] : [],
			samples,
			notes: [
				...(hidden ? [t('agent.bucketImpact.samplesHidden', {count: hidden}, hidden)] : []),
				...(rest ? [t('agent.bucketImpact.samplesMore', {count: rest}, rest)] : []),
			],
		})
	}
	return impacts
}

const impacts = computed<Impact[]>(() => {
	const after = snapshot(props.operation.after)
	if (!after) return []
	const before = snapshot(props.operation.before)
	switch (props.operation.tool) {
		case 'create_bucket': return createImpacts(after)
		case 'update_bucket': return updateImpacts(before, after)
		case 'move_task_to_bucket': return moveImpacts(before, after)
		case 'set_view_buckets': return viewImpacts(before, after)
		case 'delete_bucket': return deleteImpacts(before, after)
		default: return []
	}
})
</script>

<template>
	<section
		v-if="impacts.length"
		class="bucket-impact"
		:aria-labelledby="headingId"
	>
		<h4 :id="headingId">
			{{ t('agent.bucketImpact.title') }}
		</h4>
		<ul class="impact-list">
			<li
				v-for="impact in impacts"
				:key="impact.key"
				:data-impact="impact.key"
			>
				<span
					v-for="(sentence, index) in impact.sentences"
					:key="index"
					class="impact-sentence"
				>{{ sentence }}</span>
				<ul
					v-if="impact.samples?.length"
					class="impact-samples"
				>
					<li
						v-for="sample in impact.samples"
						:key="sample.id"
					>
						{{ sample.title }}<span
							v-if="sample.done"
							class="sample-done"
						> · {{ t('agent.bucketImpact.sampleDone') }}</span>
					</li>
				</ul>
				<span
					v-for="(note, index) in impact.notes"
					:key="`note-${index}`"
					class="impact-sentence"
				>{{ note }}</span>
			</li>
		</ul>
	</section>
</template>

<style scoped lang="scss">
.bucket-impact {
	margin-block: var(--space-2);
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);
	color: var(--text-primary);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;
}

h4 {
	margin-block: 0 var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.impact-list {
	display: grid;
	gap: var(--space-1);
	margin: 0;
	padding-inline-start: var(--space-4);
	list-style: disc;

	> li::marker {
		color: var(--text-tertiary);
	}
}

.impact-sentence + .impact-sentence {
	margin-inline-start: var(--space-1);
}

// The reassurance that no task is deleted is the line a reviewer looks for first.
[data-impact='tasks-deleted'] {
	font-weight: var(--weight-semibold);
}

[data-impact='warning']::marker {
	color: var(--warning);
}

.impact-samples {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1);
	margin-block: var(--space-1);
	padding: 0;
	list-style: none;

	li {
		max-inline-size: 100%;
		padding-inline: var(--space-2);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text-primary);
	}
}

.sample-done {
	color: var(--text-secondary);
}
</style>
