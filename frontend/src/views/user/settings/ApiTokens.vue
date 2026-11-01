<script setup lang="ts">
import {useQuery} from '@tanstack/vue-query'
import {apiTokensQuery, useDeleteApiTokenMutation} from '@/client/queries/apiTokens'
import {isApiTokenExpired} from '@/helpers/apiToken'
import {computed, onMounted, ref} from 'vue'
import {useRoute} from 'vue-router'
import {useRouteQuery} from '@vueuse/router'
import {normalizePageNumber} from '@/client/queries/pagination'
import {useClampedPage} from '@/composables/useClampedPage'
import {formatDateSince, formatDisplayDate} from '@/helpers/time/formatDate'
import XButton from '@/components/input/Button.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import {useI18n} from 'vue-i18n'
import Message from '@/components/misc/Message.vue'
import Pagination from '@/components/misc/Pagination.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import type {ApiToken as IApiToken} from '@/client/generated'
import ApiTokenForm from '@/components/token/ApiTokenForm.vue'
import {getApiBaseUrl} from '@/helpers/apiUrl'
import {useTitle} from '@/composables/useTitle'
import {useCopyToClipboard} from '@/composables/useCopyToClipboard'

const page = useRouteQuery('page', '1', {transform: normalizePageNumber})
// The page shows its own load error: an unknown list must not read as "no tokens".
const {data, isFetching, isPlaceholderData, isPending, isError, isSuccess, refetch} = useQuery(computed(() => ({
	...apiTokensQuery(page.value),
	meta: {handlesError: true},
})))
useClampedPage(page, {data, isPlaceholderData})
const tokens = computed(() => data.value?.items ?? [])
const totalPages = computed(() => data.value?.total_pages ?? 0)
const deleteMutation = useDeleteApiTokenMutation()
const apiDocsUrl = `${getApiBaseUrl()}/docs`
const showCreateForm = ref(false)
const tokenCreatedSuccessMessage = ref('')
const createdToken = ref('')
const copy = useCopyToClipboard()

const showDeleteModal = ref<boolean>(false)
const tokenToDelete = ref<IApiToken>()

const {t} = useI18n()
useTitle(() => `${t('user.settings.apiTokens.title')} - ${t('user.settings.title')}`)

const route = useRoute()

const initialTitle = ref('')
const initialScopes = ref('')

onMounted(() => {
	// Apply query parameters if present
	const titleParam = Array.isArray(route.query.title) ? route.query.title[0] : route.query.title
	const scopesParam = Array.isArray(route.query.scopes) ? route.query.scopes[0] : route.query.scopes

	if (titleParam) {
		initialTitle.value = titleParam
	}
	if (scopesParam) {
		initialScopes.value = scopesParam
	}
	if (titleParam || scopesParam) {
		showCreateForm.value = true
	}
})

// The dialog stays open (and busy) until the token is really gone; a failure leaves it open to retry or cancel.
async function deleteToken() {
	const token = tokenToDelete.value
	if (!token?.id || deleteMutation.isPending.value) {
		return
	}
	try {
		await deleteMutation.mutateAsync(token.id)
	} catch {
		return // The mutation reports the error.
	}
	if (tokenToDelete.value?.id !== token.id) return
	tokenToDelete.value = undefined
	showDeleteModal.value = false
}

function formatPermissionTitle(title: string): string {
	return title.replaceAll('_', ' ')
}

function onTokenCreated(token: IApiToken) {
	tokenCreatedSuccessMessage.value = t('user.settings.apiTokens.tokenCreatedSuccess', {token: token.token})
	createdToken.value = token.token ?? ''
	showCreateForm.value = false
}
</script>

<template>
	<div class="settings-page">
		<PageHeader :title="$t('user.settings.apiTokens.title')">
			<template #description>
				{{ $t('user.settings.apiTokens.general') }}
				<BaseButton :href="apiDocsUrl">
					{{ $t('user.settings.apiTokens.apiDocs') }}
				</BaseButton>
			</template>
		</PageHeader>
		<Card :loading="isPending">
			<LoadError
				v-if="isError && !data"
				class="mbe-4"
				:message="$t('user.settings.accessLoadError')"
				:retry="refetch"
			/>
			<Message
				v-if="tokenCreatedSuccessMessage !== ''"
				variant="success"
				class="mbe-4"
			>
				<div class="token-created">
					<p>
						{{ tokenCreatedSuccessMessage }}<br>
						{{ $t('user.settings.apiTokens.tokenCreatedNotSeeAgain') }}
					</p>
					<XButton
						variant="secondary"
						icon="paste"
						class="is-small"
						@click="copy(createdToken)"
					>
						{{ $t('misc.copy') }}
					</XButton>
				</div>
			</Message>

			<div
				v-if="tokens.length > 0"
				class="has-horizontal-overflow"
			>
				<table class="table is-fullwidth">
					<thead>
						<tr>
							<th>{{ $t('misc.id') }}</th>
							<th>{{ $t('user.settings.apiTokens.attributes.title') }}</th>
							<th>{{ $t('user.settings.apiTokens.attributes.permissions') }}</th>
							<th>{{ $t('user.settings.apiTokens.attributes.expiresAt') }}</th>
							<th>{{ $t('misc.created') }}</th>
							<th class="has-text-end">
								{{ $t('misc.actions') }}
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="tk in tokens"
							:key="tk.id"
						>
							<td>{{ tk.id }}</td>
							<td>{{ tk.title }}</td>
							<td class="is-capitalized token-permissions">
								<template
									v-for="(v, p) in tk.permissions"
									:key="'permission-' + p"
								>
									<strong>{{ formatPermissionTitle(p) }}:</strong>
									{{ (v ?? []).map(formatPermissionTitle).join(', ') }}
									<br>
								</template>
							</td>
							<td>
								{{ formatDisplayDate(tk.expires_at) }}
								<p
									v-if="isApiTokenExpired(tk)"
									class="has-text-danger"
								>
									{{ $t('user.settings.apiTokens.expired', {ago: formatDateSince(tk.expires_at)}) }}
								</p>
							</td>
							<td>{{ formatDisplayDate(tk.created) }}</td>
							<td class="has-text-end">
								<XButton
									variant="secondary"
									danger
									class="is-small"
									@click="() => {tokenToDelete = tk; showDeleteModal = true}"
								>
									{{ $t('misc.delete') }}
								</XButton>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p
				v-else-if="isSuccess"
				class="settings-empty"
			>
				{{ $t('user.settings.apiTokens.empty') }}
			</p>

			<Pagination
				:total-pages="totalPages"
				:current-page="page"
			/>

			<ApiTokenForm
				v-if="showCreateForm"
				:initial-title="initialTitle"
				:initial-scopes="initialScopes"
				@created="onTokenCreated"
				@cancel="showCreateForm = false"
			/>

			<XButton
				v-else
				icon="plus"
				class="mbs-2"
				:loading="isFetching || deleteMutation.isPending.value"
				@click="() => showCreateForm = true"
			>
				{{ $t('user.settings.apiTokens.createAToken') }}
			</XButton>

			<Modal
				danger
				:enabled="showDeleteModal"
				:confirm-label="$t('user.settings.apiTokens.delete.confirm')"
				@close="showDeleteModal = false"
				@submit="deleteToken"
			>
				<template #header>
					{{ $t('user.settings.apiTokens.delete.header') }}
				</template>

				<template #text>
					<p v-if="tokenToDelete">
						{{ $t('user.settings.apiTokens.delete.text1', {token: tokenToDelete.title}) }}<br>
						{{ $t('user.settings.apiTokens.delete.text2') }}
					</p>
				</template>
			</Modal>
		</Card>
	</div>
</template>

<style lang="scss" scoped>
.token-created {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2) var(--space-4);
	overflow-wrap: anywhere;
}

.settings-empty {
	color: var(--text-secondary);
}

.token-permissions {
	font-size: var(--text-sm);
}
</style>
