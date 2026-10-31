<template>
	<CompassThemeScope
		:theme="space?.theme ?? COMPASS_DEFAULT_THEME"
		class="compass-settings"
	>
		<RouterLink
			v-if="!unavailable"
			:to="spaceRoute"
			class="compass-settings__back"
		>
			<Icon icon="arrow-left" />
			<span>{{ t('compass.settings.backToSpace') }}</span>
		</RouterLink>

		<header class="compass-settings__header">
			<p
				v-if="space"
				class="compass-settings__space"
			>
				{{ space.title }}
			</p>
			<h1 class="compass-settings__title">
				{{ t('compass.settings.title') }}
			</h1>
			<p
				v-if="space && showForm"
				class="compass-settings__lead"
			>
				{{ t('compass.settings.lead') }}
			</p>
		</header>

		<template v-if="firstLoad">
			<p
				class="is-sr-only"
				role="status"
			>
				{{ t('misc.loading') }}
			</p>
			<div
				class="compass-settings__skeleton"
				aria-hidden="true"
			>
				<span class="compass-settings__skeleton-sky" />
				<span class="compass-settings__skeleton-line" />
				<span class="compass-settings__skeleton-line is-short" />
				<span class="compass-settings__skeleton-line" />
			</div>
		</template>

		<div
			v-else-if="unavailable"
			class="compass-settings__state"
			role="alert"
		>
			<p>{{ t('compass.settings.unavailable') }}</p>
			<RouterLink
				:to="{name: 'compass.index'}"
				class="compass-settings__state-link"
			>
				{{ t('compass.settings.toCompass') }}
			</RouterLink>
		</div>

		<div
			v-else-if="!space"
			class="compass-settings__state"
			role="alert"
		>
			<p>{{ t('compass.settings.loadError') }}</p>
			<div class="compass-settings__state-actions">
				<XButton
					variant="secondary"
					:shadow="false"
					:loading="isFetching"
					@click="retry"
				>
					{{ t('misc.retry') }}
				</XButton>
				<RouterLink
					:to="{name: 'compass.index'}"
					class="compass-settings__state-link"
				>
					{{ t('compass.settings.toCompass') }}
				</RouterLink>
			</div>
		</div>

		<template v-else>
			<Message
				v-if="isError"
				variant="warning"
				class="compass-settings__stale"
			>
				<span>{{ t('compass.settings.stale') }}</span>
				<XButton
					variant="tertiary"
					:shadow="false"
					:loading="isFetching"
					@click="retry"
				>
					{{ t('misc.retry') }}
				</XButton>
			</Message>

			<CompassSpaceSettingsForm
				v-if="showForm"
				:key="space.id"
				:space="space"
			/>

			<section
				v-else
				class="compass-settings__readonly"
			>
				<p class="compass-settings__readonly-note">
					<Icon
						class="compass-settings__readonly-icon"
						icon="lock"
					/>
					<span>{{ t('compass.settings.readOnly') }}</span>
				</p>
				<dl class="compass-settings__summary">
					<div class="compass-settings__summary-row">
						<dt>{{ t('compass.settings.field.name') }}</dt>
						<dd class="compass-settings__summary-title">
							{{ space.title }}
						</dd>
					</div>
					<div class="compass-settings__summary-row">
						<dt>{{ t('compass.settings.field.motto') }}</dt>
						<dd
							class="compass-settings__summary-motto"
							:class="{'is-empty': space.motto.trim() === ''}"
						>
							{{ space.motto.trim() || t('compass.settings.noMotto') }}
						</dd>
					</div>
					<div class="compass-settings__summary-row">
						<dt>{{ t('compass.settings.field.theme') }}</dt>
						<dd class="compass-settings__summary-theme">
							<CompassThemeScope
								tag="span"
								:theme="space.theme"
								class="compass-settings__swatch"
								aria-hidden="true"
							/>
							<span>{{ t(`compass.theme.${space.theme}`) }}</span>
						</dd>
					</div>
					<div class="compass-settings__summary-row">
						<dt>{{ t('compass.sharing.summaryLabel') }}</dt>
						<dd>
							<CompassSharingSummary :team-id="space.team_id" />
						</dd>
					</div>
				</dl>
			</section>
		</template>
	</CompassThemeScope>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'

import XButton from '@/components/input/Button.vue'
import Icon from '@/components/misc/Icon'
import Message from '@/components/misc/Message.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import CompassSharingSummary from '@/components/compass/settings/CompassSharingSummary.vue'
import CompassSpaceSettingsForm from '@/components/compass/settings/CompassSpaceSettingsForm.vue'

import {canAdminCompass} from '@/client/queries/compass'
import {useCompassSpace} from '@/composables/useCompass'
import {useTitle} from '@/composables/useTitle'
import {COMPASS_DEFAULT_THEME} from '@/helpers/compass/constants'
import {classifyCompassFailure} from '@/helpers/compass/errors'

const props = defineProps<{
	spaceId: number
}>()

const {t} = useI18n({useScope: 'global'})

const {
	space,
	isPending,
	isError,
	isFetching,
	error,
	refetch,
} = useCompassSpace(() => props.spaceId)

useTitle(() => space.value
	? t('compass.settings.documentTitle', {space: space.value.title})
	: t('compass.settings.title'))

const spaceRoute = computed(() => ({
	name: 'compass.space',
	params: {spaceId: props.spaceId},
}))

const canAdmin = computed(() => canAdminCompass(space.value))

// Once open, the form stays for this space even if a refetch lowers the permission: unmounting it
// would silently drop unsaved changes, while a save reports the lost right in place.
const editableSpaceId = ref(0)
watch(() => canAdmin.value ? (space.value?.id ?? 0) : 0, id => {
	if (id > 0) editableSpaceId.value = id
}, {immediate: true})
const showForm = computed(() => canAdmin.value ||
	(space.value !== undefined && editableSpaceId.value === space.value.id))

// A space that is gone or was never visible gets no Retry: asking again cannot change the answer.
const unavailable = computed(() => {
	if (props.spaceId <= 0) return true
	if (space.value || !isError.value) return false
	const failure = classifyCompassFailure(error.value)
	return failure === 'missing' || failure === 'forbidden'
})

const firstLoad = computed(() => !unavailable.value && !space.value && isPending.value)

function retry() {
	if (isFetching.value) return
	refetch()
}
</script>

<style lang="scss" scoped>
.compass-settings {
	max-inline-size: 70rem;
	margin-inline: auto;
}

.compass-settings__back {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	margin-block-end: var(--space-4);
	color: var(--compass-accent);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);

	&:hover span {
		text-decoration: underline;
		text-underline-offset: .2em;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-settings__header {
	max-inline-size: 40rem;
	margin-block-end: var(--space-6);
}

.compass-settings__space {
	margin: 0 0 var(--space-1);
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	font-size: var(--text-lg);
	overflow-wrap: anywhere;
}

.compass-settings__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: clamp(1.6rem, 1.3rem + 1.2vw, 2.1rem);
	font-weight: var(--weight-semibold);
	line-height: 1.2;
	letter-spacing: .005em;
}

.compass-settings__lead {
	margin-block: var(--space-2) 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-base);
	line-height: 1.7;
}

.compass-settings__skeleton {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	max-inline-size: 40rem;
}

.compass-settings__skeleton-sky,
.compass-settings__skeleton-line {
	display: block;
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);
}

.compass-settings__skeleton-sky {
	block-size: 9rem;
	margin-block-end: var(--space-3);
	border-radius: var(--radius-lg);
}

.compass-settings__skeleton-line {
	block-size: 2.25rem;

	&.is-short {
		inline-size: 60%;
	}
}

.compass-settings__state {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-3);
	max-inline-size: 40rem;
	padding: var(--space-4) var(--space-5);
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-md);
	background: var(--surface);

	p {
		margin: 0;
		line-height: var(--leading-normal);
	}
}

.compass-settings__state-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-3);
}

.compass-settings__state-link {
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
	text-decoration: underline;
	text-underline-offset: .2em;

	&:focus-visible {
		@include focus-ring;
	}

	@media (pointer: coarse) {
		display: inline-flex;
		align-items: center;
		min-block-size: var(--target-min);
	}
}

.compass-settings__stale {
	max-inline-size: 40rem;
	margin-block-end: var(--space-5);

	:deep(.message) {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
}

.compass-settings__readonly {
	display: flex;
	flex-direction: column;
	gap: var(--space-5);
	max-inline-size: 40rem;
}

.compass-settings__readonly-note {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	margin: 0;
	color: var(--compass-ink-soft);
	line-height: var(--leading-normal);
}

.compass-settings__readonly-icon {
	flex: none;
	margin-block-start: .25rem;
}

.compass-settings__summary {
	display: flex;
	flex-direction: column;
	margin: 0;
	border-block: 1px solid var(--compass-rule);
}

.compass-settings__summary-row {
	display: grid;
	grid-template-columns: minmax(0, 9rem) minmax(0, 1fr);
	gap: var(--space-1) var(--space-4);
	padding-block: var(--space-4);

	& + & {
		border-block-start: 1px solid var(--compass-rule);
	}

	dt {
		color: var(--text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	dd {
		min-inline-size: 0;
		margin: 0;
		color: var(--compass-ink);
		overflow-wrap: anywhere;
	}

	@media screen and (max-width: $tablet) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.compass-settings__summary-title {
	font-family: var(--compass-serif);
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
}

.compass-settings__summary-motto {
	font-family: var(--compass-serif);
	font-style: italic;
	font-synthesis: none;
	line-height: 1.6;
	white-space: pre-line;

	&.is-empty {
		color: var(--text-tertiary);
		font-family: inherit;
		font-style: normal;
	}
}

.compass-settings__summary-theme {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.compass-settings__swatch {
	display: inline-block;
	flex: none;
	inline-size: 2rem;
	block-size: 1.25rem;
	border: 1px solid var(--compass-rule-strong);
	border-radius: var(--radius-sm);
	background: linear-gradient(135deg, var(--compass-sky-from), var(--compass-sky-via) 55%, var(--compass-sky-to));
}
</style>
