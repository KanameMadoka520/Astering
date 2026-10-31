<template>
	<CompassSkyHeader
		class="compass-hero"
		:space-id="space.id"
		:background="space"
	>
		<div class="compass-hero__layout">
			<div class="compass-hero__identity">
				<p class="compass-hero__eyebrow">
					<span
						class="compass-hero__visibility"
						:title="visibilityHint"
					>
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
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
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
import {useTeam} from '@/composables/useTeams'
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
