<script setup lang="ts">
import {
	ref,
	computed,
} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouteQuery} from '@vueuse/router'

import {useTitle} from '@/composables/useTitle'
import {useClampedPage} from '@/composables/useClampedPage'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {useAuthStore} from '@/stores/auth'
import {formatDateSince} from '@/helpers/time/formatDate'
import {useQuery} from '@tanstack/vue-query'
import {sessionsQuery, useDeleteSessionMutation} from '@/client/queries/sessions'
import {normalizePageNumber} from '@/client/queries/pagination'
import type {Session} from '@/client/generated'
import LoadError from '@/components/misc/state/LoadError.vue'
import Pagination from '@/components/misc/Pagination.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'

const {t} = useI18n({useScope: 'global'})
useTitle(() => `${t('user.settings.sessions.title')} - ${t('user.settings.title')}`)

const authStore = useAuthStore()
const page = useRouteQuery('page', '1', {transform: normalizePageNumber})
// The page shows its own load error: an unknown list must not read as "no other sessions".
const sessionQuery = useQuery(computed(() => ({...sessionsQuery(page.value), meta: {handlesError: true}})))
const sessions = computed(() => sessionQuery.data.value?.items ?? [])
const totalPages = computed(() => sessionQuery.data.value?.total_pages ?? 0)
useClampedPage(page, sessionQuery)
const reloading = useDelayedLoading(sessionQuery.isPlaceholderData)
const deleteMutation = useDeleteSessionMutation()

const showDeleteModal = ref(false)
const sessionToDelete = ref<Session | null>(null)

function confirmDelete(session: Session) {
	sessionToDelete.value = session
	showDeleteModal.value = true
}

// The dialog stays open (and busy) until the session is revoked; a failure leaves it open to retry or cancel.
async function deleteSession() {
	const session = sessionToDelete.value
	if (deleteMutation.isPending.value || !session?.id) return

	try {
		await deleteMutation.mutateAsync(session.id)
	} catch { return }
	if (sessionToDelete.value?.id !== session.id) return
	showDeleteModal.value = false
	sessionToDelete.value = null
}
</script>

<template>
	<div class="settings-page">
		<PageHeader
			:title="$t('user.settings.sessions.title')"
			:description="$t('user.settings.sessions.description')"
		/>
		<Card :loading="sessionQuery.isPending.value">
			<LoadError
				v-if="sessionQuery.isError.value && !sessionQuery.data.value"
				:message="$t('user.settings.accessLoadError')"
				:retry="() => sessionQuery.refetch()"
			/>

			<div
				v-if="sessions.length > 0"
				class="has-horizontal-overflow loader-container"
				:class="{'is-loading': reloading}"
			>
				<table class="table">
					<thead>
						<tr>
							<th>{{ $t('user.settings.sessions.deviceInfo') }}</th>
							<th>{{ $t('user.settings.sessions.ipAddress') }}</th>
							<th>{{ $t('user.settings.sessions.lastActive') }}</th>
							<th class="has-text-end">
								{{ $t('misc.actions') }}
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="session in sessions"
							:key="session.id"
						>
							<td>
								{{ session.device_info }}
								<span
									v-if="session.id === authStore.currentSessionId"
									class="tag is-primary mis-2"
								>
									{{ $t('user.settings.sessions.current') }}
								</span>
							</td>
							<td>{{ session.ip_address }}</td>
							<td>{{ formatDateSince(session.last_active) }}</td>
							<td class="has-text-end">
								<XButton
									v-if="session.id !== authStore.currentSessionId"
									variant="secondary"
									danger
									class="is-small"
									@click="confirmDelete(session)"
								>
									{{ $t('user.settings.sessions.revoke') }}
								</XButton>
							</td>
						</tr>
					</tbody>
				</table>
			</div>

			<p v-else-if="sessionQuery.isSuccess.value">
				{{ $t('user.settings.sessions.noOtherSessions') }}
			</p>

			<Pagination
				:total-pages="totalPages"
				:current-page="page"
			/>

			<Modal
				danger
				:enabled="showDeleteModal"
				:confirm-label="$t('user.settings.sessions.delete.confirm')"
				@close="showDeleteModal = false"
				@submit="deleteSession"
			>
				<template #header>
					{{ $t('user.settings.sessions.delete.header') }}
				</template>

				<template #text>
					<p v-if="sessionToDelete">
						<strong>{{ $t('user.settings.sessions.delete.subject', {device: sessionToDelete.device_info, ip: sessionToDelete.ip_address}) }}</strong>
					</p>
					<p>
						{{ $t('user.settings.sessions.delete.text') }}
					</p>
				</template>
			</Modal>
		</Card>
	</div>
</template>
