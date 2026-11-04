<script setup lang="ts">
import {computed, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import {useNetworkActivity} from '@/composables/useNetworkActivity'
import {useTopModalDialog} from '@/composables/useTopModalDialog'
import type {NetworkLabel, NetworkTask} from '@/client/networkActivity'

const {t} = useI18n({useScope: 'global'})
const {tasks, now, visible, dismissed, expanded} = useNetworkActivity()
const detailsId = useId()
const {topModalDialog} = useTopModalDialog()
const portal = computed<string | HTMLElement>(() => topModalDialog.value ?? 'body')
const shownTasks = computed(() => tasks.value.slice(0, 12))
const summary = computed(() => {
	const first = tasks.value[0]
	if (!first) return ''
	return tasks.value.length === 1
		? t('network.loadingResource', {name: label(first)})
		: t('network.loadingResources', {
			name: label(first),
			count: tasks.value.length - 1,
		})
})
const secondary = computed(() => {
	const first = tasks.value[0]
	return first ? [
		t(`network.phases.${first.phase}`),
		elapsed(first.startedAt),
		...measurements(first),
	].join(' · ') : ''
})

function label(task: NetworkLabel) {
	const name = t(`network.resources.${task.resource}`)
	return task.resourceId ? t('network.resourceID', {name, id: task.resourceId}) : name
}
function elapsed(startedAt: number) {
	const seconds = Math.max(0, Math.floor((now.value - startedAt) / 1000))
	return seconds < 60 ? t('network.elapsedSeconds', {seconds})
		: t('network.elapsedMinutes', {minutes: Math.floor(seconds / 60), seconds: seconds % 60})
}
function bytes(value: number) {
	if (value < 1024) return `${value} B`
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
	return `${(value / 1024 / 1024).toFixed(1)} MiB`
}
function speed(task: NetworkTask) {
	// A previous chunk's sample is no longer a current transfer rate after a stall.
	return task.bytesPerSecond !== undefined && task.lastReceivedAt !== undefined
		&& now.value - task.lastReceivedAt < 2000
		? t('network.transferRate', {size: bytes(Math.round(task.bytesPerSecond))}) : ''
}
function measurements(task: NetworkTask) {
	if (!task.received) return []
	return [
		task.total
			? t('network.bytesOfTotal', {received: bytes(task.received), total: bytes(task.total)})
			: t('network.bytesReceived', {size: bytes(task.received)}),
		task.total ? `${Math.floor(task.received / task.total * 100)}%` : '',
		speed(task),
	].filter(Boolean)
}
</script>

<template>
	<Teleport :to="portal">
		<aside
			v-if="visible"
			class="network-activity d-print-none"
			:class="{'is-expanded': expanded}"
			:aria-label="t('network.activityTitle')"
		>
			<div class="activity-header">
				<button
					type="button"
					class="activity-toggle"
					:aria-expanded="expanded"
					:aria-controls="detailsId"
					@click="expanded = !expanded"
				>
					<Icon
						icon="spinner"
						spin
						aria-hidden="true"
					/>
					<span class="activity-copy">
						<span
							role="status"
							class="activity-title"
						>{{ summary }}</span>
						<span class="activity-secondary">{{ secondary }}</span>
					</span>
					<Icon
						:icon="expanded ? 'chevron-up' : 'chevron-down'"
						aria-hidden="true"
					/>
				</button>
				<button
					type="button"
					class="activity-dismiss"
					:aria-label="t('network.dismissActivity')"
					@click="dismissed = true"
				>
					<Icon
						icon="times"
						aria-hidden="true"
					/>
				</button>
			</div>
			<div
				v-show="expanded"
				:id="detailsId"
				class="activity-details"
			>
				<p class="activity-help">
					{{ t('network.continueUsingPage') }}
				</p>
				<ul>
					<li
						v-for="task in shownTasks"
						:key="task.id"
						class="activity-task"
					>
						<strong>{{ label(task) }}</strong>
						<span class="activity-stage">{{ t(`network.phases.${task.phase}`) }} · {{ elapsed(task.startedAt) }}</span>
						<template v-if="task.received">
							<div class="activity-measurements">
								<span
									v-for="measurement in measurements(task)"
									:key="measurement"
								>{{ measurement }}</span>
							</div>
							<progress
								v-if="task.total"
								:value="task.received"
								:max="task.total"
								:aria-label="t('network.resourceProgress', {name: label(task)})"
							/>
						</template>
					</li>
				</ul>
				<p
					v-if="tasks.length > shownTasks.length"
					class="activity-help"
				>
					{{ t('network.moreResources', {count: tasks.length - shownTasks.length}) }}
				</p>
			</div>
		</aside>
	</Teleport>
</template>

<style lang="scss" scoped>
.network-activity {
	position: fixed;
	inset-block-start: calc(var(--header-height) + var(--space-2));
	inset-inline-start: 50%;
	z-index: var(--layer-header);
	inline-size: max-content;
	max-inline-size: min(26rem, calc(100vw - var(--space-4)));
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	transform: translateX(-50%);

	&.is-expanded {
		inline-size: min(26rem, calc(100vw - var(--space-4)));
	}

	button {
		min-block-size: 2.75rem;
		border: 0;
		border-radius: var(--radius-lg);
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;

		&:focus-visible {
			@include focus-ring;
		}
	}
}

.activity-header {
	display: flex;
	align-items: center;
}

.activity-toggle {
	flex: 1;
	display: flex;
	align-items: center;
	gap: var(--space-3);
	min-inline-size: 0;
	padding: var(--space-2) var(--space-3);
	text-align: start;

	svg {
		flex-shrink: 0;
	}
}

.activity-copy {
	flex: 1;
	display: grid;
	gap: var(--space-1);
	min-inline-size: 0;
}

.activity-title {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.activity-secondary {
	max-inline-size: 38ch;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}

.activity-dismiss {
	flex-shrink: 0;
	inline-size: 2.75rem;
}

.activity-details {
	overflow-y: auto;
	max-block-size: min(22rem, calc(100dvh - var(--header-height) - 8rem));
	padding: 0 var(--space-4) var(--space-3);
	overscroll-behavior: contain;

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
}

.activity-help {
	margin: var(--space-2) 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.activity-task {
	display: grid;
	gap: var(--space-1);
	padding: var(--space-3) 0;
	border-block-start: 1px solid var(--border-default);

	strong {
		color: var(--text-primary);
		font-weight: 600;
	}

	progress {
		inline-size: 100%;
		block-size: .25rem;
		accent-color: var(--primary);
	}
}

.activity-stage,
.activity-measurements {
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}

.activity-measurements {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: var(--space-2);
}

@media (prefers-reduced-motion: reduce) {
	.activity-toggle :deep(.fa-spin) {
		animation: none;
	}
}
</style>
