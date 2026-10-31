<template>
	<section
		class="compass-snapshot"
		:aria-labelledby="headingId"
	>
		<header class="compass-snapshot__header">
			<div class="compass-snapshot__heading-row">
				<h2
					:id="headingId"
					ref="heading"
					class="compass-snapshot__heading"
					tabindex="-1"
				>
					{{ t('compass.history.version', {revision}) }}
				</h2>
				<span
					v-if="isCurrent"
					class="compass-snapshot__current"
				>
					{{ t('compass.history.current') }}
				</span>
			</div>
			<p
				v-if="savedAt"
				class="compass-snapshot__saved"
			>
				<i18n-t
					:keypath="savedBy ? 'compass.history.savedBy' : 'compass.history.saved'"
					tag="span"
					scope="global"
				>
					<template #date>
						<time
							:datetime="formatISO(savedAt)"
							:title="formatDateLong(savedAt)"
						>{{ formatDisplayDate(savedAt) }}</time>
					</template>
					<template #person>
						{{ savedBy }}
					</template>
				</i18n-t>
			</p>
		</header>

		<template v-if="snapshot">
			<p class="compass-snapshot__changes">
				<Icon
					:icon="isCurrent || changedFields.length === 0 ? 'check' : 'code-branch'"
					aria-hidden="true"
				/>
				<span>{{ comparison }}</span>
			</p>

			<div
				v-if="canWrite && !isCurrent"
				class="compass-snapshot__actions"
			>
				<XButton
					v-if="entry.state !== 'trashed'"
					variant="secondary"
					:shadow="false"
					icon="undo"
					@click="restoreOpen = true"
				>
					{{ t('compass.history.restoreAction') }}
				</XButton>
				<p
					v-else
					class="compass-snapshot__blocked"
				>
					<Icon
						icon="trash-alt"
						aria-hidden="true"
					/>
					<span>
						{{ t('compass.history.restoreTrashed') }}
						<RouterLink :to="{name: 'compass.entry', params: {entryId: entry.id}}">
							{{ t('compass.history.openEntry') }}
						</RouterLink>
					</span>
				</p>
			</div>

			<CompassThemeScope
				:theme="snapshotTheme"
				class="compass-snapshot__frame"
			>
				<p class="compass-snapshot__label">
					<Icon
						icon="lock"
						aria-hidden="true"
					/>
					{{ t('compass.history.snapshot') }}
				</p>
				<div class="compass-snapshot__page">
					<p class="compass-snapshot__kicker">
						<CompassKindLabel :kind="snapshot.kind" />
						<span v-if="snapshot.category">{{ snapshot.category }}</span>
					</p>
					<h3 class="compass-snapshot__title">
						{{ snapshot.title }}
					</h3>
					<p
						v-if="snapshot.subtitle.trim()"
						class="compass-snapshot__subtitle"
					>
						{{ snapshot.subtitle.trim() }}
					</p>
					<blockquote
						v-if="quote"
						class="compass-snapshot__epigraph"
					>
						{{ quote }}
					</blockquote>
					<ul
						v-if="snapshot.tags.length > 0"
						class="compass-snapshot__tags"
						:aria-label="t('compass.reader.tags')"
					>
						<li
							v-for="tag in snapshot.tags"
							:key="tag"
						>
							#{{ tag }}
						</li>
					</ul>
					<CompassProse
						v-if="hasBody"
						class="compass-snapshot__body"
						:prepared="prepared"
						:space-id="entry.space_id"
						:font="prefs.font"
						:size="prefs.size"
					/>
					<p
						v-else
						class="compass-snapshot__empty"
					>
						{{ t('compass.history.emptyBody') }}
					</p>
				</div>
			</CompassThemeScope>
		</template>

		<p
			v-else-if="failure === 'missing'"
			class="compass-snapshot__state"
		>
			{{ t('compass.history.versionMissing') }}
		</p>

		<LoadError
			v-else-if="failure !== null && failure !== 'aborted'"
			:message="t('compass.history.versionFailed')"
			:retry="retry"
		/>

		<div
			v-else
			class="compass-snapshot__skeleton"
			role="status"
		>
			<span class="is-sr-only">{{ t('misc.loading') }}</span>
			<span
				v-for="line in 6"
				:key="line"
				aria-hidden="true"
			/>
		</div>

		<CompassRestoreDialog
			:enabled="restoreOpen"
			:entry="entry"
			:revision="revision"
			@close="restoreOpen = false"
			@stale="emit('stale')"
			@restored="onRestored"
		/>
	</section>
</template>

<script setup lang="ts">
import {computed, ref, useId, useTemplateRef, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import CompassKindLabel from '@/components/compass/base/CompassKindLabel.vue'
import CompassProse from '@/components/compass/base/CompassProse.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import XButton from '@/components/input/Button.vue'
import Icon from '@/components/misc/Icon'
import LoadError from '@/components/misc/state/LoadError.vue'
import {
	canWriteCompass,
	compassEntryText,
	type CompassEntry,
	type CompassEntryText,
} from '@/client/queries/compass'
import {useCompassRevision} from '@/composables/useCompass'
import {useCompassReadingPrefs} from '@/composables/useCompassReadingPrefs'
import {resolveCompassTheme, type CompassTheme} from '@/helpers/compass/constants'
import {changedCompassDraftFields, type CompassDraftFields} from '@/helpers/compass/drafts'
import {classifyCompassFailure} from '@/helpers/compass/errors'
import {
	compassPlainText,
	prepareCompassHtml,
} from '@/helpers/compass/readerHtml'
import {
	formatDateLong,
	formatDisplayDate,
	formatISO,
} from '@/helpers/time/formatDate'
import CompassRestoreDialog from './CompassRestoreDialog.vue'

const props = withDefaults(defineProps<{
	entry: CompassEntry
	revision: number
	// What an entry that inherits its theme looks like; the default theme until the space has loaded.
	spaceTheme?: CompassTheme
	personName: (userId: number) => string
}>(), {
	spaceTheme: undefined,
})

const emit = defineEmits<{
	stale: []
}>()

const {t, locale} = useI18n({useScope: 'global'})
const {prefs} = useCompassReadingPrefs()

const {
	snapshot,
	error,
	isError,
	isFetching,
	refetch,
} = useCompassRevision(() => props.entry.id, () => props.revision)

const headingId = useId()
const heading = useTemplateRef<HTMLElement>('heading')

const failure = computed(() => isError.value ? classifyCompassFailure(error.value) : null)
const isCurrent = computed(() => props.revision === props.entry.revision)
const canWrite = computed(() => canWriteCompass(props.entry))
const savedAt = computed(() => snapshot.value?.created)
const savedBy = computed(() => snapshot.value ? props.personName(snapshot.value.updated_by_id) : '')
const snapshotTheme = computed(() => resolveCompassTheme(snapshot.value?.theme, props.spaceTheme))

const content = computed(() => snapshot.value?.content ?? '')
const prepared = computed(() => prepareCompassHtml(content.value, 'compass-version'))
// A version that only holds pictures still has a body; its images stay readable through the space.
const hasBody = computed(() => prepared.value.images.length > 0 || compassPlainText(content.value).trim() !== '')
const quote = computed(() => snapshot.value?.quote.trim() ?? '')

function comparable(source: CompassEntryText): CompassDraftFields {
	return {
		...compassEntryText(source),
		pinned: false,
	}
}

// Pinning is not part of a version; only the text the restore would bring back is compared.
const changedFields = computed<(keyof CompassDraftFields)[]>(() => {
	if (!snapshot.value || isCurrent.value) return []
	return changedCompassDraftFields(comparable(snapshot.value), comparable(props.entry))
		.filter(field => field !== 'pinned')
})

const listFormat = computed(() => new Intl.ListFormat(locale.value, {
	style: 'long',
	type: 'conjunction',
}))

const comparison = computed(() => {
	if (isCurrent.value) return t('compass.history.isCurrent')
	if (changedFields.value.length === 0) return t('compass.history.same')
	const fields = changedFields.value.map(field => t(`compass.history.field.${field}`))
	return t('compass.history.changed', {fields: listFormat.value.format(fields)})
})

function retry() {
	if (isFetching.value) return
	refetch()
}

const restoreOpen = ref(false)

// Another version on screen means the open question was about a different one.
watch(() => props.revision, () => {
	restoreOpen.value = false
})

// The dialog hands focus back to its trigger after fading out, but the restored version is now the
// current one and has no Restore button; the version heading takes focus once the page is interactive.
// Without a fade (reduced motion) the dialog can close before the route shows the new version, so both are awaited.
function focusHeadingAfterDialog(framesLeft = 30) {
	requestAnimationFrame(() => {
		if ((document.querySelector('dialog[open]') || !isCurrent.value) && framesLeft > 0) {
			focusHeadingAfterDialog(framesLeft - 1)
			return
		}
		if (!document.activeElement || document.activeElement === document.body) heading.value?.focus()
	})
}

function onRestored() {
	restoreOpen.value = false
	focusHeadingAfterDialog()
}

function focusHeading() {
	heading.value?.focus()
}

defineExpose({focusHeading})
</script>

<style lang="scss" scoped>
.compass-snapshot {
	min-inline-size: 0;
}

.compass-snapshot__header {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	margin-block-end: var(--space-3);
}

.compass-snapshot__heading-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
}

.compass-snapshot__heading {
	margin: 0;
	color: var(--compass-ink);
	font-size: var(--text-xl);
	font-weight: var(--weight-semibold);
	font-variant-numeric: tabular-nums;

	// Only scripts focus it (after a restore, or on phones after picking a version).
	&:focus {
		outline: none;
	}
}

.compass-snapshot__current {
	padding: .1rem var(--space-2);
	border: 1px solid var(--compass-accent);
	border-radius: var(--radius-full);
	color: var(--compass-accent);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
}

.compass-snapshot__saved {
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
}

.compass-snapshot__changes {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	margin: 0 0 var(--space-4);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);

	svg {
		flex: none;
		color: var(--compass-ink-faint);
	}
}

.compass-snapshot__actions {
	margin-block-end: var(--space-5);
}

.compass-snapshot__blocked {
	display: flex;
	align-items: baseline;
	gap: var(--space-2);
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);

	a {
		color: var(--compass-accent);
		font-weight: var(--weight-medium);
		text-decoration: underline;
		text-underline-offset: .2em;

		&:focus-visible {
			@include focus-ring;
		}
	}
}

// A page laid under glass: the copy is readable but visibly not the live entry.
.compass-snapshot__frame {
	border: 1px solid var(--compass-rule-strong);
	border-radius: var(--radius-lg);
	background: var(--surface-sunken);
	box-shadow: inset 0 1px 3px hsla(220, 25%, 15%, .06);
	overflow: hidden;
}

.compass-snapshot__label {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
	padding: var(--space-2) var(--space-4);
	border-block-end: 1px dashed var(--compass-rule-strong);
	color: var(--compass-ink-faint);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .06em;
	text-transform: uppercase;
}

.compass-snapshot__page {
	padding: var(--space-6) clamp(var(--space-4), 4vw, var(--space-8)) var(--space-8);
}

.compass-snapshot__kicker {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);
	margin: 0 0 var(--space-3);
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
}

.compass-snapshot__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: clamp(1.6rem, 3vw, 2.2rem);
	font-weight: 600;
	line-height: 1.25;
	text-wrap: balance;
	overflow-wrap: break-word;
}

.compass-snapshot__subtitle {
	margin: var(--space-2) 0 0;
	color: var(--compass-ink-soft);
	font-family: var(--compass-serif);
	font-size: 1.1rem;
	line-height: 1.55;
}

.compass-snapshot__epigraph {
	margin: var(--space-6) 0 var(--space-4);
	padding-inline-start: 1.1em;
	border-inline-start: 2px solid var(--compass-accent);
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.2rem;
	line-height: 1.7;
	white-space: pre-line;
}

.compass-snapshot__tags {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-3);
	margin: var(--space-3) 0 0;
	padding: 0;
	color: var(--compass-accent);
	font-size: var(--text-sm);
	list-style: none;
	overflow-wrap: anywhere;
}

.compass-snapshot__body {
	margin-block-start: var(--space-6);
}

.compass-snapshot__empty {
	margin: var(--space-6) 0 0;
	color: var(--compass-ink-faint);
	font-family: var(--compass-serif);
}

.compass-snapshot__state {
	margin: 0;
	padding-block: var(--space-4);
	color: var(--compass-ink-soft);
}

.compass-snapshot__skeleton {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding-block: var(--space-4);

	> span:not(.is-sr-only) {
		display: block;
		inline-size: 100%;
		block-size: .9rem;
		border-radius: var(--radius-xs);
		background: var(--surface-active);
	}

	> span:nth-child(2) {
		inline-size: 60%;
		block-size: 1.75rem;
		margin-block-end: var(--space-2);
	}

	> span:last-child {
		inline-size: 45%;
	}
}
</style>
