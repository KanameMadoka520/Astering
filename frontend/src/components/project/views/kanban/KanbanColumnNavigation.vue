<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue'
import {useEventListener, useMediaQuery, useResizeObserver} from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import type {BucketResponse} from '@/client/queries/kanban'
import BaseButton from '@/components/base/BaseButton.vue'
import {scrollKanbanColumnIntoView} from './scrollKanbanColumnIntoView'

const props = defineProps<{
	board: HTMLElement | null
	buckets: BucketResponse[]
	canCreate?: boolean
}>()
const emit = defineEmits<{
	select: [bucket: BucketResponse]
	create: []
}>()
const {t} = useI18n({useScope: 'global'})
const mobile = useMediaQuery('(max-width: 768px)')
const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
const activeId = ref<number | null>(null)
const activeIndex = computed(() => Math.max(0, props.buckets.findIndex(bucket => bucket.id === activeId.value)))
const active = computed(() => props.buckets[activeIndex.value])
let frame: number | undefined

function measureActive() {
	frame = undefined
	const board = props.board
	if (!mobile.value || !board?.isConnected) return
	const rtl = getComputedStyle(board).direction === 'rtl'
	const bounds = board.getBoundingClientRect()
	let nearest: number | null = null
	let distance = Infinity
	for (const bucket of props.buckets) {
		const lane = board.querySelector<HTMLElement>(`[data-bucket-id="${bucket.id}"]`)
		if (!lane) continue
		const rect = lane.getBoundingClientRect()
		const delta = Math.abs(rtl ? rect.right - bounds.right : rect.left - bounds.left)
		if (delta < distance) {
			distance = delta
			nearest = bucket.id
		}
	}
	activeId.value = nearest
}

function scheduleMeasure() {
	if (frame !== undefined || !mobile.value) return
	frame = requestAnimationFrame(measureActive)
}

useEventListener(() => props.board, 'scroll', scheduleMeasure, {passive: true})
useResizeObserver(() => props.board, scheduleMeasure)
watch([() => props.buckets.map(bucket => bucket.id).join(','), mobile], scheduleMeasure, {flush: 'post'})
onBeforeUnmount(() => {
	if (frame !== undefined) cancelAnimationFrame(frame)
})

async function selectBucket(id: number) {
	const bucket = props.buckets.find(item => item.id === id)
	if (!bucket) return
	const originalBoard = props.board
	activeId.value = id
	emit('select', bucket)
	// Selecting a collapsed column expands it first; only the board scrolls, never the whole page.
	await nextTick()
	const board = props.board
	if (!board || board !== originalBoard) return
	scrollKanbanColumnIntoView(board, id, {behavior: reducedMotion.value ? 'auto' : 'smooth'})
}

function step(direction: number) {
	const target = props.buckets[activeIndex.value + direction]
	if (target) void selectBucket(target.id)
}
</script>

<template>
	<nav
		v-if="mobile && buckets.length > 0"
		class="kanban-column-navigation d-print-none"
		:aria-label="t('project.kanban.columnNavigation')"
	>
		<BaseButton
			class="kanban-column-navigation__step"
			:aria-label="t('project.kanban.previousColumn')"
			:aria-disabled="activeIndex === 0"
			@click="step(-1)"
		>
			<Icon icon="chevron-left" />
		</BaseButton>
		<label class="kanban-column-navigation__picker">
			<span class="is-sr-only">{{ t('project.kanban.jumpToColumn') }}</span>
			<select
				:value="active?.id"
				@change="selectBucket(Number(($event.target as HTMLSelectElement).value))"
			>
				<option
					v-for="(bucket, index) in buckets"
					:key="bucket.id"
					:value="bucket.id"
				>
					{{ index + 1 }}. {{ bucket.title }}
				</option>
			</select>
			<span
				class="kanban-column-navigation__position"
				aria-hidden="true"
			>{{ activeIndex + 1 }} / {{ buckets.length }}</span>
		</label>
		<BaseButton
			class="kanban-column-navigation__step"
			:aria-label="t('project.kanban.nextColumn')"
			:aria-disabled="activeIndex >= buckets.length - 1"
			@click="step(1)"
		>
			<Icon icon="chevron-right" />
		</BaseButton>
		<BaseButton
			v-if="canCreate"
			class="kanban-column-navigation__step"
			:aria-label="t('project.kanban.addBucket')"
			@click="emit('create')"
		>
			<Icon icon="plus" />
		</BaseButton>
	</nav>
</template>

<style scoped lang="scss">
.kanban-column-navigation {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	min-inline-size: 0;
	margin-block-end: var(--space-2);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
}

.kanban-column-navigation__step {
	display: inline-flex;
	flex: 0 0 44px;
	align-items: center;
	justify-content: center;
	block-size: 44px;
	border-radius: var(--radius-sm);
	color: var(--text-secondary);

	&[aria-disabled='true'] {
		opacity: .35;
	}

	&:focus-visible {
		@include focus-ring;
		outline-offset: -2px;
	}

	[dir='rtl'] & svg {
		transform: scaleX(-1);
	}
}

.kanban-column-navigation__picker {
	display: flex;
	flex: 1 1 auto;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;

	select {
		flex: 1 1 auto;
		inline-size: 0;
		min-inline-size: 0;
		min-block-size: 44px;
		border: 0;
		background: var(--surface);
		color: var(--text-primary);
		font-size: var(--text-md);
		text-overflow: ellipsis;
	}
}

.kanban-column-navigation__position {
	flex-shrink: 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}
</style>
