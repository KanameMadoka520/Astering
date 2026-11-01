<template>
	<CompassSkyHeader
		class="compass-hero"
		:space-id="space.id"
		:background="space"
	>
		<div class="compass-hero__layout">
			<div class="compass-hero__identity">
				<p class="compass-hero__eyebrow">
					<span class="compass-hero__visibility">
						<Icon
							:icon="isTeamSpace ? 'users' : 'lock'"
							class="compass-hero__visibility-icon"
						/>
						{{ visibilityLabel }}
					</span>
					<template v-if="!canWrite">
						<span
							class="compass-hero__dot"
							aria-hidden="true"
						>·</span>
						<span>{{ t('compass.hero.readOnly') }}</span>
					</template>
				</p>
				<h1 class="compass-hero__title">
					{{ space.title }}
				</h1>
				<p
					v-if="motto"
					class="compass-hero__motto"
				>
					{{ motto }}
				</p>
				<p class="compass-hero__meta">
					<span>{{ t('compass.hero.entries', {n: space.entry_count}, space.entry_count) }}</span>
					<template v-if="space.pinned_count > 0">
						<span
							class="compass-hero__dot"
							aria-hidden="true"
						>·</span>
						<span>{{ t('compass.hero.lights', {n: space.pinned_count}, space.pinned_count) }}</span>
					</template>
					<template v-if="space.updated">
						<span
							class="compass-hero__dot"
							aria-hidden="true"
						>·</span>
						<span>
							{{ t('compass.hero.updatedPrefix') }}
							<time
								:datetime="space.updated"
								:title="formatDateLong(space.updated)"
							>{{ formatDisplayDate(space.updated) }}</time>
						</span>
					</template>
				</p>
				<!-- Who can open the space and where it is kept, readable by touch and keyboard (not a tooltip). -->
				<details class="compass-hero__privacy d-print-none">
					<summary class="compass-hero__privacy-summary">
						{{ t('compass.hero.privacyTitle') }}
					</summary>
					<p class="compass-hero__privacy-text">
						{{ visibilityHint }} {{ t('compass.space.storageNote') }}
					</p>
				</details>
				<p
					v-if="canWrite && newDraft"
					class="compass-hero__draft d-print-none"
				>
					<span>{{ t('compass.hero.newDraft') }}</span>
					<RouterLink
						class="compass-hero__draft-link"
						:to="{name: 'compass.entry.new', params: {spaceId: space.id}}"
					>
						{{ t('compass.hero.continueWriting') }}
					</RouterLink>
				</p>
			</div>

			<div
				class="compass-hero__actions d-print-none"
				role="group"
				:aria-label="t('compass.hero.actions')"
			>
				<CompassSpaceSwitcher :current-space-id="space.id" />
				<XButton
					v-if="canAdmin"
					variant="secondary"
					icon="cog"
					:shadow="false"
					:to="{name: 'compass.space.settings', params: {spaceId: space.id}}"
					:aria-label="t('compass.settings.title')"
					:title="t('compass.settings.title')"
				/>
				<CompassSpaceExport :space="space" />
				<XButton
					v-if="canWrite"
					icon="feather"
					:shadow="false"
					:to="{name: 'compass.entry.new', params: {spaceId: space.id}}"
				>
					{{ t('compass.editor.newTitle') }}
				</XButton>
			</div>
		</div>
	</CompassSkyHeader>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {useEventListener} from '@vueuse/core'
import XButton from '@/components/input/Button.vue'
import Icon from '@/components/misc/Icon'
import CompassSkyHeader from './CompassSkyHeader.vue'
import CompassSpaceExport from './CompassSpaceExport.vue'
import CompassSpaceSwitcher from './CompassSpaceSwitcher.vue'
import {
	canAdminCompass,
	canWriteCompass,
	type CompassSpace,
} from '@/client/queries/compass'
import {useCompassAccountNamespace} from '@/composables/useCompass'
import {useTeam} from '@/composables/useTeams'
import {compassDraftKey, loadCompassDraft} from '@/helpers/compass/drafts'
import {formatDateLong, formatDisplayDate} from '@/helpers/time/formatDate'

const props = defineProps<{
	space: CompassSpace
}>()

const {t} = useI18n({useScope: 'global'})

const isTeamSpace = computed(() => props.space.team_id > 0)
const team = useTeam(() => props.space.team_id)
const teamName = computed(() => team.data.value?.name || t('compass.space.teamFallback'))

const visibilityLabel = computed(() => isTeamSpace.value
	? t('compass.space.team', {team: teamName.value})
	: t('compass.space.personal'))
const visibilityHint = computed(() => isTeamSpace.value
	? t('compass.space.teamHint', {team: teamName.value})
	: t('compass.space.personalHint'))

const canWrite = computed(() => canWriteCompass(props.space))
const canAdmin = computed(() => canAdminCompass(props.space))
const motto = computed(() => props.space.motto.trim())

// A new entry started here and kept on this device for this account (the editor's "new" slot) is otherwise
// only found by pressing Write again.
const namespace = useCompassAccountNamespace()
const storageChanges = ref(0)
useEventListener(window, 'storage', () => storageChanges.value++)
const newDraft = computed(() => {
	void storageChanges.value
	if (namespace.value === '') return null
	return loadCompassDraft(compassDraftKey(namespace.value, props.space.id, 0), props.space.id, 0)
})
</script>

<style lang="scss" scoped>
.compass-hero__layout {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--space-5) var(--space-6);
}

// Text stays on the clear start side of the sky; the astrolabe fades in only past it.
.compass-hero__identity {
	display: flex;
	flex: 1 1 22rem;
	flex-direction: column;
	gap: var(--space-3);
	min-inline-size: 0;
	max-inline-size: 40rem;
}

.compass-hero__eyebrow {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	letter-spacing: .02em;
}

.compass-hero__visibility {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
	overflow-wrap: anywhere;
}

.compass-hero__visibility-icon {
	flex: none;
	inline-size: .875em;
	color: var(--compass-accent);
}

.compass-hero__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: clamp(2rem, 4vw, 3rem);
	font-weight: 600;
	line-height: 1.12;
	letter-spacing: -.01em;
	overflow-wrap: anywhere;
	text-wrap: balance;
}

.compass-hero__motto {
	max-inline-size: 36em;
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	font-size: clamp(1.125rem, 1.7vw, 1.3rem);
	line-height: 1.6;
	white-space: pre-line;
	overflow-wrap: anywhere;
	quotes: '\201C' '\201D' '\2018' '\2019';

	&::before {
		content: open-quote;
	}

	&::after {
		content: close-quote;
	}
}

.compass-hero__meta {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--space-1) var(--space-2);
	margin-block-start: var(--space-1);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.compass-hero__dot {
	color: var(--compass-ink-faint);
}

.compass-hero__privacy {
	max-inline-size: 36em;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.compass-hero__privacy-summary {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	color: var(--compass-ink-soft);
	font-weight: var(--weight-medium);
	cursor: pointer;

	&:hover {
		color: var(--compass-ink);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-hero__privacy-text {
	margin-block-start: var(--space-1);
}

.compass-hero__draft {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-2);
	color: var(--compass-ink);
	font-size: var(--text-sm);
}

.compass-hero__draft-link {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	color: var(--compass-accent);
	font-weight: var(--weight-medium);

	&:hover {
		text-decoration: underline;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-hero__actions {
	display: flex;
	flex: 0 1 auto;
	flex-wrap: wrap;
	align-items: center;
	justify-content: flex-end;
	gap: var(--space-2);

	@media screen and (max-width: $tablet - 1px) {
		flex-basis: 100%;
		justify-content: flex-start;
	}
}

@media print {
	.compass-hero__title {
		font-size: 22pt;
	}
}
</style>
