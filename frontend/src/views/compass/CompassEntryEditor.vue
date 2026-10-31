<template>
	<CompassThemeScope
		:theme="pageTheme"
		class="compass-editor-page"
	>
		<CompassEntryForm
			v-if="stage === 'form' && formSpace"
			:key="sessionKey"
			ref="formRef"
			:space="formSpace"
			:entry="formEntry"
			:initial-kind="initialKind"
			@created="adopt"
			@theme="formTheme = $event"
		/>

		<div
			v-else-if="stage === 'loading' || stage === 'form'"
			class="compass-editor-skeleton"
			aria-busy="true"
		>
			<h1 class="is-sr-only">
				{{ isExisting ? t('compass.editor.editTitle') : t('compass.editor.newTitle') }}
			</h1>
			<p
				class="is-sr-only"
				role="status"
			>
				{{ t('compass.editor.loading') }}
			</p>
			<div
				class="compass-editor-skeleton__bar"
				aria-hidden="true"
			/>
			<div
				class="compass-editor-skeleton__layout"
				aria-hidden="true"
			>
				<div class="compass-editor-skeleton__sheet">
					<span class="compass-editor-skeleton__line compass-editor-skeleton__line--eyebrow" />
					<span class="compass-editor-skeleton__line compass-editor-skeleton__line--title" />
					<span class="compass-editor-skeleton__line compass-editor-skeleton__line--subtitle" />
					<span
						v-for="line in 6"
						:key="line"
						class="compass-editor-skeleton__line"
					/>
				</div>
				<div class="compass-editor-skeleton__aside">
					<span
						v-for="block in 4"
						:key="block"
						class="compass-editor-skeleton__block"
					/>
				</div>
			</div>
		</div>

		<section
			v-else-if="notice"
			class="compass-editor-notice"
			:aria-labelledby="noticeId"
		>
			<CompassGlyph
				kind="guide"
				class="compass-editor-notice__glyph"
			/>
			<h1
				:id="noticeId"
				class="compass-editor-notice__title"
			>
				{{ notice.title }}
			</h1>
			<p
				class="compass-editor-notice__text"
				:role="stage === 'failed' ? 'alert' : undefined"
			>
				{{ notice.text }}
			</p>
			<div class="compass-editor-notice__actions">
				<XButton
					v-if="stage === 'failed'"
					variant="primary"
					:shadow="false"
					:loading="retrying"
					:aria-disabled="retrying"
					@click="retry"
				>
					{{ t('misc.retry') }}
				</XButton>
				<XButton
					v-if="stage === 'trashed'"
					variant="primary"
					icon="undo"
					:shadow="false"
					:loading="restoring"
					:aria-disabled="restoring"
					@click="restoreEntry"
				>
					{{ t('compass.editor.restore') }}
				</XButton>
				<RouterLink
					class="compass-editor-notice__link"
					:to="notice.link.to"
				>
					{{ notice.link.label }}
				</RouterLink>
			</div>
		</section>
	</CompassThemeScope>
</template>

<script setup lang="ts">
import {
	computed,
	nextTick,
	ref,
	useId,
	watch,
} from 'vue'
import {useI18n} from 'vue-i18n'
import {
	useRoute,
	useRouter,
	type RouteLocationRaw,
} from 'vue-router'

import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import CompassEntryForm from '@/components/compass/editor/CompassEntryForm.vue'
import XButton from '@/components/input/Button.vue'

import {
	canWriteCompass,
	useSetCompassEntryMetaMutation,
	type CompassEntry,
	type CompassSpace,
} from '@/client/queries/compass'
import {
	useCompassAccountNamespace,
	useCompassEntry,
	useCompassSpace,
} from '@/composables/useCompass'
import {useTitle} from '@/composables/useTitle'
import {
	isCompassKind,
	resolveCompassTheme,
	type CompassEntryTheme,
	type CompassKind,
} from '@/helpers/compass/constants'
import {classifyCompassFailure} from '@/helpers/compass/errors'

const props = defineProps<{
	// The space to write in; 0 on the edit route, where the entry names its space.
	spaceId: number
	// 0 for a new entry.
	entryId: number
}>()

type Gate = 'loading' | 'failed' | 'missing' | 'readOnly' | 'trashed' | 'ready'
type Stage = Gate | 'form'

type Notice = {
	title: string
	text: string
	link: {
		to: RouteLocationRaw
		label: string
	}
}

// An entry created on the "new" page carries on at its own edit address in the very same desk.
type Adoption = {
	entryId: number
	spaceId: number
	namespace: string
	key: string
}

const {t} = useI18n({useScope: 'global'})
const route = useRoute()
const router = useRouter()
const namespace = useCompassAccountNamespace()
const noticeId = useId()

const adopted = ref<Adoption | null>(null)
const isExisting = computed(() => props.entryId > 0)
const initialKind = computed<CompassKind>(() => {
	const kind = route.query.kind
	return isCompassKind(kind) ? kind : 'note'
})

const entryQuery = useCompassEntry(() => props.entryId)
const entry = entryQuery.entry

const spaceId = computed(() => {
	if (!isExisting.value) return props.spaceId
	if (entry.value) return entry.value.space_id
	return adopted.value?.entryId === props.entryId ? adopted.value.spaceId : 0
})
const spaceQuery = useCompassSpace(spaceId)
const space = spaceQuery.space

// Coming back to a "new entry" address in this same view must not find the adopted desk under its old key
// (it is bound to the created entry and would save over it), so every return gets a fresh generation.
const newDeskGeneration = ref(0)
watch(() => props.entryId, entryId => {
	if (entryId === 0) newDeskGeneration.value++
}, {flush: 'sync'})

// One desk per account, entry and space. Adopting a just-created entry keeps the key, so the editor,
// its cursor and its undo history stay; any other entry or space starts a fresh desk.
const sessionKey = computed(() => {
	const current = adopted.value
	if (current && current.entryId === props.entryId && current.namespace === namespace.value) return current.key
	return isExisting.value
		? `${namespace.value}|entry:${props.entryId}`
		: `${namespace.value}|new:${props.spaceId}:${initialKind.value}:${newDeskGeneration.value}`
})

// When the page began showing this entry: a cached copy older than that is refreshed before the desk
// opens, so drafts are compared against the latest version.
const openedAt = ref(Date.now())
watch(() => props.entryId, () => {
	openedAt.value = Date.now()
})

function failureGate(error: unknown): Gate {
	const kind = classifyCompassFailure(error)
	if (kind === 'aborted') return 'loading'
	return kind === 'missing' || kind === 'forbidden' ? 'missing' : 'failed'
}

function spaceWait(): Gate | null {
	if (space.value) return null
	const error = spaceQuery.error.value
	return error ? failureGate(error) : 'loading'
}

function entryGate(): Gate {
	const current = entry.value
	const error = entryQuery.error.value
	// A cached copy of an entry that is gone now must not open; a network hiccup may (drafts keep the text).
	if (error && (!current || failureGate(error) === 'missing')) return failureGate(error)
	if (!current || (entryQuery.isFetching.value && entryQuery.dataUpdatedAt.value < openedAt.value)) return 'loading'
	const waiting = spaceWait()
	if (waiting) return waiting
	if (!canWriteCompass(current)) return 'readOnly'
	return current.state === 'trashed' ? 'trashed' : 'ready'
}

function newEntryGate(): Gate {
	if (props.spaceId <= 0) return 'missing'
	const waiting = spaceWait()
	if (waiting) return waiting
	return canWriteCompass(space.value) ? 'ready' : 'readOnly'
}

const gate = computed<Gate>(() => isExisting.value ? entryGate() : newEntryGate())

// Once a desk is open it stays open for its session: a later refetch (trashed elsewhere, permissions
// changed, offline) is explained when saving, never by unmounting the text being written.
const openedSession = ref('')
watch([gate, sessionKey], ([currentGate, key]) => {
	if (currentGate === 'ready') openedSession.value = key
}, {immediate: true})

const stage = computed<Stage>(() => openedSession.value === sessionKey.value || gate.value === 'ready'
	? 'form'
	: gate.value)

const lastSpace = ref<CompassSpace>()
watch(space, value => {
	if (value) lastSpace.value = value
}, {immediate: true})
const formSpace = computed(() => space.value ?? (lastSpace.value?.id === spaceId.value ? lastSpace.value : undefined))
const formEntry = computed(() => isExisting.value ? entry.value : undefined)

const formRef = ref<InstanceType<typeof CompassEntryForm> | null>(null)
const formTheme = ref<CompassEntryTheme>()
watch(sessionKey, () => {
	formTheme.value = undefined
})
const pageTheme = computed(() => resolveCompassTheme(formTheme.value ?? entry.value?.theme, formSpace.value?.theme))

useTitle(() => isExisting.value
	? entry.value?.title || t('compass.editor.editTitle')
	: t('compass.editor.newTitle'))

function adopt(created: CompassEntry) {
	adopted.value = {
		entryId: created.id,
		spaceId: created.space_id,
		namespace: namespace.value,
		key: sessionKey.value,
	}
	router.replace({
		name: 'compass.entry.edit',
		params: {entryId: created.id},
	})
}

const compassLink = computed(() => ({
	to: {name: 'compass.index'},
	label: t('compass.editor.toCompass'),
}))

const readerLink = computed(() => ({
	to: {
		name: 'compass.entry',
		params: {entryId: props.entryId},
	},
	label: t('compass.editor.openEntry'),
}))

const notice = computed<Notice | null>(() => {
	switch (stage.value) {
		case 'failed':
			return {
				title: t('compass.editor.loadFailedTitle'),
				text: t('misc.loadError'),
				link: compassLink.value,
			}
		case 'missing':
			return isExisting.value
				? {
					title: t('compass.editor.missingEntryTitle'),
					text: t('compass.editor.missingEntryText'),
					link: compassLink.value,
				}
				: {
					title: t('compass.editor.missingSpaceTitle'),
					text: t('compass.editor.missingSpaceText'),
					link: compassLink.value,
				}
		case 'readOnly':
			return isExisting.value
				? {
					title: t('compass.editor.readOnlyTitle'),
					text: t('compass.editor.readOnlyEntryText'),
					link: readerLink.value,
				}
				: {
					title: t('compass.editor.readOnlyTitle'),
					text: t('compass.editor.readOnlySpaceText'),
					link: {
						to: {
							name: 'compass.space',
							params: {spaceId: props.spaceId},
						},
						label: t('compass.editor.openSpace'),
					},
				}
		case 'trashed':
			return {
				title: t('compass.editor.trashedTitle'),
				text: t('compass.editor.trashedText'),
				link: readerLink.value,
			}
	}
	return null
})

const retrying = ref(false)

async function retry() {
	if (retrying.value) return
	retrying.value = true
	await Promise.all([
		isExisting.value ? entryQuery.refetch() : null,
		spaceId.value > 0 ? spaceQuery.refetch() : null,
	])
	retrying.value = false
}

const setMeta = useSetCompassEntryMetaMutation()
const restoring = computed(() => setMeta.isPending.value)

async function restoreEntry() {
	const current = entry.value
	if (!current || setMeta.isPending.value) return
	try {
		await setMeta.mutateAsync({
			entryId: current.id,
			spaceId: current.space_id,
			change: {state: 'active'},
		})
	} catch {
		// The mutation reports its own failures.
		return
	}
	if (props.entryId !== current.id) return
	// The button that had focus is gone; writing starts at the title.
	await nextTick()
	formRef.value?.focusTitle()
}
</script>

<style lang="scss" scoped>
.compass-editor-page {
	display: block;
}

// ---------------------------------------------------------------------------
// First load: the shape of the desk, quietly.
// ---------------------------------------------------------------------------

.compass-editor-skeleton {
	max-inline-size: 72rem;
	margin-inline: auto;
}

.compass-editor-skeleton__bar {
	block-size: 3.25rem;
	margin-block-end: var(--space-5);
	border-block-end: 1px solid var(--compass-rule);
}

.compass-editor-skeleton__layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-5);

	> * {
		justify-self: center;
		inline-size: 100%;
		max-inline-size: 46rem;
	}

	@media screen and (width >= 1024px) {
		grid-template-columns: minmax(0, 46rem) 18rem;
		justify-content: center;
		gap: var(--space-8);

		> * {
			max-inline-size: none;
		}
	}
}

.compass-editor-skeleton__sheet {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	min-block-size: 24rem;
	padding: clamp(1.25rem, 4vw, 2.75rem) clamp(1rem, 4.5vw, 3.25rem);
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-lg);
	background: var(--compass-paper);
}

.compass-editor-skeleton__line {
	display: block;
	inline-size: 100%;
	block-size: .85rem;
	border-radius: var(--radius-full);
	background: var(--surface-active);

	&:last-child {
		inline-size: 62%;
	}
}

.compass-editor-skeleton__line--eyebrow {
	inline-size: 7rem;
	block-size: .7rem;
}

.compass-editor-skeleton__line--title {
	inline-size: 70%;
	block-size: 2.1rem;
	margin-block: var(--space-1) var(--space-2);
	border-radius: var(--radius-sm);
}

.compass-editor-skeleton__line--subtitle {
	inline-size: 48%;
	block-size: 1.1rem;
	margin-block-end: var(--space-6);
}

.compass-editor-skeleton__aside {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

.compass-editor-skeleton__block {
	display: block;
	block-size: 3.25rem;
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-md);
	background: var(--compass-paper);
}

// ---------------------------------------------------------------------------
// Why the desk cannot open
// ---------------------------------------------------------------------------

.compass-editor-notice {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--space-3);
	max-inline-size: 34rem;
	margin: clamp(2rem, 10vh, 6rem) auto;
	padding: var(--space-6) var(--space-5);
	border: 1px solid var(--compass-rule);
	border-radius: var(--radius-lg);
	background: var(--compass-paper);
	text-align: center;
}

.compass-editor-notice__glyph {
	--compass-glyph-size: 1.5rem;
}

.compass-editor-notice__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.6rem;
	line-height: 1.3;
}

.compass-editor-notice__text {
	margin: 0;
	color: var(--compass-ink-soft);
	line-height: 1.6;
}

.compass-editor-notice__actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: center;
	gap: var(--space-2) var(--space-4);
	margin-block-start: var(--space-2);

	@media (pointer: coarse) {
		:deep(.button) {
			min-block-size: var(--target-min);
		}
	}
}

.compass-editor-notice__link {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
	text-decoration: underline;
	text-underline-offset: .2em;

	&:focus-visible {
		@include focus-ring;
	}
}
</style>
