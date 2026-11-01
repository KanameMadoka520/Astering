<template>
	<Modal
		:enabled="drafts !== null"
		:loading="loggingOut"
		:confirm-label="confirmLabel"
		:danger="removeDrafts"
		@close="drafts = null"
		@submit="logout"
	>
		<template #header>
			{{ $t('user.auth.logoutDrafts.title') }}
		</template>
		<template #text>
			<template v-if="drafts && ownDrafts > 0">
				<p>{{ $t('user.auth.logoutDrafts.text') }}</p>
				<ul class="logout-drafts">
					<li v-if="drafts.compass">
						{{ $t('user.auth.logoutDrafts.compass', {n: drafts.compass}, drafts.compass) }}
					</li>
					<li v-if="drafts.tasks">
						{{ $t('user.auth.logoutDrafts.tasks', {n: drafts.tasks}, drafts.tasks) }}
					</li>
				</ul>
				<p>{{ $t('user.auth.logoutDrafts.keepExplain') }}</p>
			</template>
			<p v-if="drafts?.legacy">
				{{ $t('user.auth.logoutDrafts.legacy', {n: drafts.legacy}, drafts.legacy) }}
			</p>
			<label
				v-if="ownDrafts > 0"
				class="logout-drafts__remove"
			>
				<input
					v-model="removeDrafts"
					type="checkbox"
					data-cy="logoutRemoveDrafts"
				>
				{{ $t('user.auth.logoutDrafts.remove') }}
			</label>
		</template>
	</Modal>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'

import Modal from '@/components/misc/Modal.vue'
import {clearAccountDrafts, countLocalDrafts, type DraftScope, type LocalDraftCount} from '@/helpers/localDrafts'
import {editorDraftNamespace} from '@/helpers/draftScope'
import {compassAccountNamespace} from '@/helpers/compass/storage'
import {getApiBaseUrl} from '@/helpers/apiUrl'
import {useAuthStore} from '@/stores/auth'

const {t} = useI18n()
const authStore = useAuthStore()

// Logging out keeps this account's unsaved drafts in this browser; removing them is an explicit choice.
const drafts = ref<LocalDraftCount | null>(null)
const removeDrafts = ref(false)
const loggingOut = ref(false)
const ownDrafts = computed(() => (drafts.value?.compass ?? 0) + (drafts.value?.tasks ?? 0))
const confirmLabel = computed(() => {
	if (removeDrafts.value) return t('user.auth.logoutDrafts.confirmRemove')
	return ownDrafts.value > 0 ? t('user.auth.logoutDrafts.confirmKeep') : t('user.auth.logout')
})

function draftScope(): DraftScope {
	const id = authStore.info?.id
	return {
		compass: id ? compassAccountNamespace(getApiBaseUrl(), id) : '',
		editor: editorDraftNamespace(),
	}
}

/** Logs out right away when this browser holds no unsaved writing, otherwise asks first. */
function request() {
	if (loggingOut.value) return
	const found = countLocalDrafts(draftScope())
	removeDrafts.value = false
	if (found.compass + found.tasks + found.legacy === 0) {
		void logout()
		return
	}
	drafts.value = found
}

async function logout() {
	if (loggingOut.value) return
	loggingOut.value = true
	if (removeDrafts.value) clearAccountDrafts(draftScope())
	try {
		await authStore.logout()
	} finally {
		loggingOut.value = false
		drafts.value = null
	}
}

defineExpose({request})
</script>

<style lang="scss" scoped>
.logout-drafts {
	margin-block: var(--space-2);
	padding-inline-start: var(--space-5);
	list-style: disc;
}

.logout-drafts__remove {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	margin-block-start: var(--space-3);
	font-weight: var(--weight-medium);
}
</style>
