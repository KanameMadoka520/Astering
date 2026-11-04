<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'

export type StorageSegment = {
	key: string,
	bytes: number,
	count?: number,
}

const props = defineProps<{
	totalBytes: number,
	complete: boolean,
	asOf: string,
	segments: StorageSegment[],
	trashBytes: number,
	trashCount: number,
	previewBytes: number,
	conversationBytes: number,
	conversationCount: number,
	busy: boolean,
}>()
const emit = defineEmits<{
	filter: [value: 'trash' | 'previews' | 'large' | 'conversations'],
}>()
const {t, locale} = useI18n({useScope: 'global'})
const visibleSegments = computed(() => props.segments.filter(segment => segment.bytes > 0))
function bytes(value: number) {
	if (!value) return '0 B'
	const index = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))))
	const amount = new Intl.NumberFormat(locale.value, {maximumFractionDigits: 1}).format(value / 1024 ** index)
	return `${amount} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]}`
}
function number(value: number) { return new Intl.NumberFormat(locale.value).format(value) }
const scannedAt = computed(() => {
	const value = new Date(props.asOf)
	return Number.isNaN(value.getTime()) ? '' : new Intl.DateTimeFormat(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value)
})
</script>

<template>
	<section
		class="storage-summary"
		:aria-label="t('storage.overview')"
	>
		<div class="storage-summary__head">
			<div>
				<p class="storage-summary__eyebrow">
					{{ t('storage.ownStorage') }}
				</p>
				<p class="storage-summary__total">
					<span v-if="!complete">≥ </span>{{ bytes(totalBytes) }}
				</p>
			</div>
			<p class="storage-summary__scan">
				{{ t('storage.scannedAt', {time: scannedAt}) }}
			</p>
		</div>
		<div
			class="storage-summary__bar"
			aria-hidden="true"
		>
			<span
				v-for="segment in visibleSegments"
				:key="segment.key"
				:class="`is-${segment.key}`"
				:style="{flexGrow: segment.bytes}"
			/>
		</div>
		<ul class="storage-summary__legend">
			<li
				v-for="segment in segments"
				:key="segment.key"
			>
				<span
					class="storage-summary__dot"
					:class="`is-${segment.key}`"
				/>
				<span>{{ t(`storage.categories.${segment.key}`) }}<small v-if="segment.count !== undefined">{{ t('storage.itemCount', {count: number(segment.count)}) }}</small>
				</span>
				<strong>{{ bytes(segment.bytes) }}</strong>
			</li>
		</ul>
		<p class="storage-summary__note">
			{{ t('storage.logicalNote') }}
		</p>
		<p
			v-if="!complete"
			class="storage-summary__incomplete"
			role="status"
		>
			{{ t('storage.incomplete') }}
		</p>
	</section>
	<div
		class="storage-suggestions"
		:aria-label="t('storage.reviewSuggestions')"
	>
		<XButton
			variant="secondary"
			:shadow="false"
			:aria-disabled="busy"
			class="storage-suggestion"
			@click="!busy && emit('filter', 'trash')"
		>
			<span class="storage-suggestion__icon">
				<Icon icon="trash-alt" />
			</span>
			<span>
				<strong>{{ t('storage.suggestions.trash') }}</strong>
				<small>{{ t('storage.itemsAndSize', {count: number(trashCount), size: bytes(trashBytes)}) }}</small>
			</span>
			<Icon icon="chevron-right" />
		</XButton>
		<XButton
			variant="secondary"
			:shadow="false"
			:aria-disabled="busy"
			class="storage-suggestion"
			@click="!busy && emit('filter', 'previews')"
		>
			<span class="storage-suggestion__icon">
				<Icon icon="image" />
			</span>
			<span>
				<strong>{{ t('storage.suggestions.previews') }}</strong>
				<small>{{ bytes(previewBytes) }} · {{ t('storage.suggestions.previewsHint') }}</small>
			</span>
			<Icon icon="chevron-right" />
		</XButton>
		<XButton
			variant="secondary"
			:shadow="false"
			:aria-disabled="busy"
			class="storage-suggestion"
			@click="!busy && emit('filter', 'large')"
		>
			<span class="storage-suggestion__icon">
				<Icon icon="arrow-down" />
			</span>
			<span>
				<strong>{{ t('storage.suggestions.large') }}</strong>
				<small>{{ t('storage.suggestions.largeHint') }}</small>
			</span>
			<Icon icon="chevron-right" />
		</XButton>
		<XButton
			variant="secondary"
			:shadow="false"
			:aria-disabled="busy"
			class="storage-suggestion"
			@click="!busy && emit('filter', 'conversations')"
		>
			<span class="storage-suggestion__icon">
				<Icon :icon="['far', 'comments']" />
			</span>
			<span>
				<strong>{{ t('storage.suggestions.conversations') }}</strong>
				<small>{{ t('storage.itemsAndSize', {count: number(conversationCount), size: bytes(conversationBytes)}) }}</small>
			</span>
			<Icon icon="chevron-right" />
		</XButton>
	</div>
</template>

<style scoped lang="scss">
.storage-summary {
	padding: clamp(1rem, 3vw, 1.75rem);
	border: 1px solid var(--border-subtle);
	border-radius: 1.25rem;
	background: var(--surface-raised);
}
.storage-summary__head {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	justify-content: space-between;
	gap: .75rem 1rem;
}
.storage-summary__eyebrow,
.storage-summary__scan,
.storage-summary__note {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.storage-summary__total {
	margin: .25rem 0 0;
	font-size: clamp(2rem, 4vw, 2.75rem);
	font-weight: 700;
	line-height: 1.15;
	letter-spacing: -.04em;
	font-variant-numeric: tabular-nums;
}
.storage-summary__bar {
	display: flex;
	gap: 3px;
	block-size: .8rem;
	margin-block: 1.5rem;
	overflow: hidden;
	border-radius: 1rem;
	background: var(--surface-sunken);
	span {
		min-inline-size: 3px;
		border-radius: 2px;
	}
}
.storage-summary__legend {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 1rem 2rem;
	margin: 0 0 1.25rem;
	padding: 0;
	list-style: none;
	li {
		display: flex;
		align-items: center;
		gap: .65rem;
		min-inline-size: 0;
		font-size: var(--text-sm);
	}
	strong {
		margin-inline-start: auto;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	small {
		display: block;
		color: var(--text-secondary);
	}
}
.storage-summary__dot {
	flex: none;
	inline-size: .6rem;
	block-size: .6rem;
	border-radius: 50%;
}
.is-files {
	background: #4082ee;
}
.is-images {
	background: #4082ee;
}
.is-video {
	background: #7380d0;
}
.is-audio {
	background: #4da5a7;
}
.is-documents {
	background: #51a0d0;
}
.is-other {
	background: #9ba7b5;
}
.is-trash {
	background: #b69178;
}
.is-previews {
	background: #729acb;
}
.is-conversations {
	background: #27a88e;
}
.is-attachments {
	background: #df9b41;
}
.is-legacy_attachments {
	background: #df9b41;
}
.is-settings {
	background: #9b80c4;
}
.storage-summary__incomplete {
	margin-block: .75rem 0;
	color: var(--warning);
	font-size: var(--text-sm);
}
.storage-suggestions {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: .75rem;
	margin-block: 1rem 1.5rem;
}
.storage-suggestion {
	justify-content: stretch;
	min-block-size: 5.25rem;
	padding: 1rem;
	border-color: var(--border-subtle);
	border-radius: 1rem;
	background: var(--surface-raised);
	color: var(--text-primary);
	text-align: start;
	:deep(> span) {
		display: flex;
		flex: 1;
		align-items: center;
		gap: .75rem;
		min-inline-size: 0;
	}
	strong,
	small {
		display: block;
		white-space: normal;
	}
	strong {
		font-size: var(--text-sm);
	}
	small {
		margin-block-start: .2rem;
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}
	:deep(svg:last-child) {
		flex: none;
		margin-inline-start: auto;
		color: var(--text-secondary);
		font-size: .75rem;
	}
}
.storage-suggestion__icon {
	display: grid;
	flex: none;
	place-items: center;
	inline-size: 2.5rem;
	block-size: 2.5rem;
	border-radius: .8rem;
	background: var(--surface-sunken);
	color: var(--primary);
}
@media (width <= 768px) {
	.storage-summary__legend {
		gap: 1rem;
	}
	.storage-suggestion {
		padding: .8rem;
	}
}
@media (width <= 480px) {
	.storage-summary__legend,
	.storage-suggestions {
		grid-template-columns: minmax(0, 1fr);
	}
	.storage-suggestion {
		min-block-size: 4.5rem;
	}
}
</style>
