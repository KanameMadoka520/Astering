<template>
	<Modal
		:enabled="enabled"
		:loading="restoring"
		:aria-label="t('compass.history.restoreTitle', {revision})"
		@close="close"
	>
		<Card
			:title="t('compass.history.restoreTitle', {revision})"
			:shadow="false"
			:padding="false"
			:show-close="true"
			class="compass-restore-dialog has-text-start"
			@close="close"
		>
			<div class="compass-restore-dialog__body">
				<p class="compass-restore-dialog__entry">
					{{ entry.title }}
				</p>
				<p>
					{{ t('compass.history.restoreExplain', {revision, next: entry.revision + 1}) }}
				</p>
				<p class="compass-restore-dialog__note">
					{{ t('compass.history.restoreKeeps') }}
				</p>
				<Message
					v-if="hasDraft"
					variant="warning"
				>
					{{ t('compass.history.restoreDraft') }}
				</Message>
				<div
					v-if="failure"
					role="alert"
				>
					<Message variant="warning">
						{{ failure }}
					</Message>
				</div>
			</div>
			<template #footer>
				<XButton
					variant="secondary"
					:shadow="false"
					@click="close"
				>
					{{ t('misc.cancel') }}
				</XButton>
				<!-- aria-disabled, not disabled: the button keeps focus while the request runs. -->
				<XButton
					variant="primary"
					:shadow="false"
					icon="undo"
					:loading="restoring"
					:aria-disabled="restoring"
					@click="confirm"
				>
					{{ t('compass.history.restoreConfirm', {revision}) }}
				</XButton>
			</template>
		</Card>
	</Modal>
</template>

<script setup lang="ts">
import {ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRoute, useRouter} from 'vue-router'
import XButton from '@/components/input/Button.vue'
import Card from '@/components/misc/Card.vue'
import Message from '@/components/misc/Message.vue'
import Modal from '@/components/misc/Modal.vue'
import {
	useRestoreCompassRevisionMutation,
	type CompassEntry,
} from '@/client/queries/compass'
import {useCompassAccountNamespace} from '@/composables/useCompass'
import {compassDraftKey, hasCompassDraft} from '@/helpers/compass/drafts'
import {classifyCompassFailure} from '@/helpers/compass/errors'
import {getErrorText} from '@/message'

const props = defineProps<{
	enabled: boolean
	entry: CompassEntry
	revision: number
}>()

const emit = defineEmits<{
	close: []
	// The entry moved on or changed state; the page should reload it and its versions.
	stale: []
	restored: [revision: number]
}>()

const {t} = useI18n({useScope: 'global'})
const route = useRoute()
const router = useRouter()
const namespace = useCompassAccountNamespace()
const {
	isPending: restoring,
	mutateAsync: restore,
} = useRestoreCompassRevisionMutation()

const hasDraft = ref(false)
const failure = ref('')

// Read when the dialog opens: a draft saved in another tab a minute ago still counts.
watch(() => props.enabled, enabled => {
	if (!enabled) return
	failure.value = ''
	hasDraft.value = namespace.value !== ''
		&& hasCompassDraft(compassDraftKey(namespace.value, props.entry.space_id, props.entry.id))
}, {immediate: true})

function close() {
	if (restoring.value) return
	emit('close')
}

async function confirm() {
	if (restoring.value) return
	const entryId = props.entry.id
	const revision = props.revision
	const startedAt = route.fullPath
	failure.value = ''

	let savedRevision: number
	try {
		const saved = await restore({
			entryId,
			spaceId: props.entry.space_id,
			revision,
			expectedRevision: props.entry.revision,
		})
		savedRevision = saved.revision ?? 0
	} catch (e) {
		const kind = classifyCompassFailure(e)
		if (kind === 'aborted') return
		// Closed or pointed at another version meanwhile: the answer belongs to nothing on screen.
		if (!props.enabled || props.entry.id !== entryId || props.revision !== revision) return
		if (kind === 'conflict') {
			failure.value = t('compass.history.restoreConflict')
			emit('stale')
		} else if (kind === 'invalidState') {
			failure.value = t('compass.history.restoreInTrash')
			emit('stale')
		} else if (kind === 'network') {
			failure.value = t('compass.history.restoreOffline')
		} else {
			failure.value = getErrorText(e) || t('compass.history.restoreFailed')
		}
		return
	}

	if (!props.enabled || props.entry.id !== entryId || props.revision !== revision) return
	emit('restored', savedRevision)
	if (route.fullPath !== startedAt) return
	await router.replace({
		name: 'compass.entry.history',
		params: {entryId},
		query: savedRevision > 0 ? {revision: savedRevision} : {},
	})
}
</script>

<style lang="scss" scoped>
.compass-restore-dialog__body {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	max-inline-size: 32rem;
	padding: var(--space-4);
	line-height: var(--leading-normal);

	p {
		margin: 0;
	}
}

.compass-restore-dialog__entry {
	color: var(--text-strong);
	font-weight: var(--weight-semibold);
	overflow-wrap: anywhere;
}

.compass-restore-dialog__note {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
</style>
