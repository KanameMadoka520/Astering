<template>
	<Message
		variant="warning"
		class="compass-conflict"
	>
		<div class="compass-conflict__inner">
			<!-- Only the headline is announced; the latest version can be long. -->
			<p
				class="compass-conflict__headline"
				role="alert"
			>
				{{ headline }}
			</p>
			<p class="compass-conflict__changes">
				{{ changesText }}
			</p>
			<div
				class="compass-conflict__latest"
				role="region"
				tabindex="0"
				:aria-label="t('compass.conflict.latestLabel')"
			>
				<div
					v-if="latest.state !== 'active'"
					class="compass-conflict__state"
				>
					<CompassStateBadge :state="latest.state" />
				</div>
				<p class="compass-conflict__title">
					{{ latest.title || t('compass.conflict.untitled') }}
				</p>
				<p
					v-if="latest.subtitle"
					class="compass-conflict__subtitle"
				>
					{{ latest.subtitle }}
				</p>
				<blockquote
					v-if="latest.quote"
					class="compass-conflict__quote"
				>
					{{ latest.quote }}
				</blockquote>
				<CompassProse
					v-if="prepared"
					:prepared="prepared"
					size="small"
					class="compass-conflict__prose"
				/>
				<p
					v-else
					class="compass-conflict__empty"
				>
					{{ t('compass.conflict.emptyBody') }}
				</p>
			</div>
			<div class="compass-conflict__actions">
				<XButton
					variant="secondary"
					:shadow="false"
					:aria-disabled="busy"
					@click="!busy && emit('keepMine')"
				>
					{{ t('compass.conflict.keepMine') }}
				</XButton>
				<XButton
					variant="secondary"
					:shadow="false"
					:aria-disabled="busy"
					@click="!busy && emit('takeLatest')"
				>
					{{ t('compass.conflict.takeLatest') }}
				</XButton>
			</div>
			<p class="compass-conflict__hint">
				{{ t('compass.conflict.draftKept') }}
			</p>
		</div>
	</Message>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import CompassProse from '@/components/compass/base/CompassProse.vue'
import CompassStateBadge from '@/components/compass/base/CompassStateBadge.vue'
import XButton from '@/components/input/Button.vue'
import Message from '@/components/misc/Message.vue'
import type {CompassEntry, CompassSpace} from '@/client/queries/compass'
import {useCompassPeople} from '@/composables/useCompass'
import {
	changedCompassDraftFields,
	isBlankCompassHtml,
	type CompassDraftFields,
} from '@/helpers/compass/drafts'
import {prepareCompassHtml} from '@/helpers/compass/readerHtml'
import {formatDateShort} from '@/helpers/time/formatDate'
import {useAuthStore} from '@/stores/auth'
import {compassDraftFieldsOf, formatCompassFieldList} from './entryForm'

const props = withDefaults(defineProps<{
	latest: CompassEntry
	// What is on the desk right now.
	fields: CompassDraftFields
	space: CompassSpace
	busy?: boolean
}>(), {
	busy: false,
})

const emit = defineEmits<{
	keepMine: []
	takeLatest: []
}>()

const {t, locale} = useI18n({useScope: 'global'})
const authStore = useAuthStore()
const {personName} = useCompassPeople(() => props.space)

const headline = computed(() => {
	const {revision, updated, updated_by_id: by} = props.latest
	const time = formatDateShort(updated)
	if (time === '' || by <= 0) return t('compass.conflict.headlineShort', {revision})
	if (by === authStore.info?.id) {
		return t('compass.conflict.headlineSelf', {
			revision,
			time,
		})
	}
	return t('compass.conflict.headline', {
		revision,
		time,
		person: personName(by),
	})
})

const changed = computed(() => changedCompassDraftFields(props.fields, compassDraftFieldsOf(props.latest))
	.filter(field => field !== 'pinned'))

const changesText = computed(() => changed.value.length === 0
	? t('compass.conflict.sameText')
	: t('compass.conflict.changed', {
		fields: formatCompassFieldList(changed.value.map(field => t(`compass.fields.${field}`)), locale.value),
	}))

const prepared = computed(() => isBlankCompassHtml(props.latest.content)
	? null
	: prepareCompassHtml(props.latest.content, 'compass-conflict-section'))
</script>

<style lang="scss" scoped>
.compass-conflict__inner {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-inline-size: 0;

	p {
		margin: 0;
	}
}

.compass-conflict__headline {
	font-weight: var(--weight-semibold);
}

.compass-conflict__changes,
.compass-conflict__hint {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

// The latest version, read-only and bounded so the desk below stays within reach.
.compass-conflict__latest {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	max-block-size: 16rem;
	overflow: auto;
	padding: var(--space-3) var(--space-4);
	border: 1px solid var(--compass-rule-strong);
	border-radius: var(--radius-sm);
	background: var(--compass-paper);
	overflow-wrap: anywhere;
	overscroll-behavior: contain;

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-conflict__title {
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.25rem;
	font-weight: var(--weight-semibold);
	line-height: 1.35;
}

.compass-conflict__subtitle {
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
}

.compass-conflict__quote {
	margin: 0;
	padding-inline-start: var(--space-3);
	border-inline-start: 2px solid var(--compass-accent);
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	white-space: pre-line;
}

.compass-conflict__empty {
	color: var(--compass-ink-faint);
	font-size: var(--text-sm);
}

.compass-conflict__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);

	@media (pointer: coarse) {
		:deep(.button) {
			min-block-size: var(--target-min);
		}
	}
}
</style>
