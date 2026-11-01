<template>
	<div
		v-if="configStore.caldav_enabled"
		class="settings-page"
	>
		<PageHeader
			:title="$t('user.settings.caldav.title')"
			:description="$t('user.settings.caldav.description')"
		/>
		<div class="settings-sections">
			<Card :title="$t('user.settings.caldav.urlLabel')">
				<p class="settings-copy">
					{{ $t('user.settings.caldav.howTo') }}
				</p>
				<FormField
					v-model="caldavUrl"
					type="text"
					readonly
					:aria-label="$t('user.settings.caldav.urlLabel')"
				>
					<template #addon>
						<XButton
							v-tooltip="$t('misc.copy')"
							:shadow="false"
							icon="paste"
							:aria-label="$t('misc.copy')"
							@click="copy(caldavUrl)"
						/>
					</template>
				</FormField>
				<p class="settings-copy">
					<i18n-t
						keypath="user.settings.caldav.usernameIs"
						scope="global"
					>
						<strong>{{ username }}</strong>
					</i18n-t>
				</p>
				<p class="settings-copy">
					<BaseButton
						:href="CALDAV_DOCS"
						target="_blank"
					>
						{{ $t('user.settings.caldav.more') }}
					</BaseButton>
				</p>
			</Card>

			<Card :title="$t('user.settings.caldav.tokens')">
				<p class="settings-copy">
					{{ isLocalUser ? $t('user.settings.caldav.tokensHowTo') : $t('user.settings.caldav.mustUseToken') }}
				</p>
				<p class="settings-copy">
					<i18n-t
						keypath="user.settings.caldav.apiTokenHint"
						scope="global"
					>
						<template #link>
							<RouterLink :to="{name: 'user.settings.apiTokens'}">
								{{ $t('user.settings.apiTokens.title') }}
							</RouterLink>
						</template>
					</i18n-t>
				</p>

				<Message
					v-if="newToken"
					variant="success"
					class="mbe-4"
				>
					{{ $t('user.settings.caldav.tokenCreated', {token: newToken.token}) }}<br>
					{{ $t('user.settings.caldav.wontSeeItAgain') }}
				</Message>

				<LoadError
					v-if="tokenQuery.isError.value && !tokenQuery.data.value"
					class="mbe-4"
					:message="$t('user.settings.accessLoadError')"
					:retry="() => tokenQuery.refetch()"
				/>
				<div
					v-else-if="tokens.length > 0"
					class="has-horizontal-overflow loader-container"
					:class="{'is-loading': tokenQuery.isPlaceholderData.value}"
				>
					<table class="table is-fullwidth">
						<thead>
							<tr>
								<th scope="col">
									{{ $t('misc.id') }}
								</th>
								<th scope="col">
									{{ $t('misc.created') }}
								</th>
								<th
									scope="col"
									class="has-text-end"
								>
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
								<td>{{ formatDateShort(tk.created) }}</td>
								<td class="has-text-end">
									<XButton
										variant="secondary"
										danger
										class="is-small"
										@click="tokenToDelete = tk"
									>
										{{ $t('misc.delete') }}
									</XButton>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p
					v-else-if="tokenQuery.isSuccess.value"
					class="settings-copy"
				>
					{{ $t('user.settings.caldav.empty') }}
				</p>

				<Pagination
					v-if="totalPages > 1"
					:total-pages="totalPages"
					:current-page="page"
				/>

				<XButton
					icon="plus"
					class="mbs-2"
					:loading="createMutation.isPending.value"
					@click="createToken"
				>
					{{ $t('user.settings.caldav.createToken') }}
				</XButton>
			</Card>
		</div>

		<Modal
			danger
			:enabled="tokenToDelete !== null"
			:confirm-label="$t('user.settings.caldav.delete.confirm')"
			@close="tokenToDelete = null"
			@submit="deleteToken"
		>
			<template #header>
				{{ $t('user.settings.caldav.delete.header') }}
			</template>
			<template #text>
				<p v-if="tokenToDelete">
					<strong>{{ $t('user.settings.caldav.delete.subject', {id: tokenToDelete.id, created: formatDateShort(tokenToDelete.created)}) }}</strong>
				</p>
				<p>{{ $t('user.settings.caldav.delete.text') }}</p>
			</template>
		</Modal>
	</div>
</template>

<script lang="ts" setup>
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouteQuery} from '@vueuse/router'

import {CALDAV_DOCS} from '@/urls'
import {useTitle} from '@/composables/useTitle'
import {useClampedPage} from '@/composables/useClampedPage'
import {useCopyToClipboard} from '@/composables/useCopyToClipboard'
import BaseButton from '@/components/base/BaseButton.vue'
import Message from '@/components/misc/Message.vue'
import FormField from '@/components/input/FormField.vue'
import Pagination from '@/components/misc/Pagination.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {useQuery} from '@tanstack/vue-query'
import {caldavTokensQuery, useCreateCaldavTokenMutation, useDeleteCaldavTokenMutation} from '@/client/queries/caldavTokens'
import {normalizePageNumber} from '@/client/queries/pagination'
import { formatDateShort } from '@/helpers/time/formatDate'
import type {Token} from '@/client/generated'
import {useConfigStore} from '@/stores/config'
import {useAuthStore} from '@/stores/auth'

const copy = useCopyToClipboard()

const {t} = useI18n({useScope: 'global'})
useTitle(() => `${t('user.settings.caldav.title')} - ${t('user.settings.title')}`)

const authStore = useAuthStore()
const configStore = useConfigStore()
const caldav_enabled = computed(() => configStore.caldav_enabled)
const page = useRouteQuery('page', '1', {transform: normalizePageNumber})
// The page shows its own load error: an unknown list must not read as "no tokens".
const tokenQuery = useQuery(computed(() => ({
	...caldavTokensQuery(page.value),
	enabled: caldav_enabled.value,
	meta: {handlesError: true},
})))
const tokens = computed(() => tokenQuery.data.value?.items ?? [])
const totalPages = computed(() => tokenQuery.data.value?.total_pages ?? 0)
useClampedPage(page, tokenQuery)
const createMutation = useCreateCaldavTokenMutation()
const deleteMutation = useDeleteCaldavTokenMutation()
const newToken = ref<Token>()
const tokenToDelete = ref<Token | null>(null)

async function createToken() {
	try {
		newToken.value = await createMutation.mutateAsync()
	} catch { return }
}

// The dialog stays open (and busy) until the token is really gone; a failure leaves it open to retry or cancel.
async function deleteToken() {
	const token = tokenToDelete.value
	if (!token?.id || deleteMutation.isPending.value) return
	try {
		await deleteMutation.mutateAsync(token.id)
	} catch { return }
	if (newToken.value?.id === token.id) newToken.value = undefined
	if (tokenToDelete.value?.id === token.id) tokenToDelete.value = null
}

const username = computed(() => authStore.info?.username)
const caldavUrl = computed(() => `${configStore.apiBase}/dav/principals/${username.value}/`)
const isLocalUser = computed(() => authStore.info?.is_local_user)
</script>

<style lang="scss" scoped>
.settings-sections {
	display: grid;
	gap: var(--space-5);

	> .card {
		margin-block-end: 0;
	}
}

.settings-copy {
	margin-block-end: var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-md);
}
</style>
