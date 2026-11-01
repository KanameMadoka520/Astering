<script setup lang="ts">
import {computed, ref} from 'vue'
import {useNow} from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import {useQuery} from '@tanstack/vue-query'
import {allApiTokensQuery, mcpInfoQuery, useDeleteApiTokenMutation} from '@/client/queries/apiTokens'
import type {ApiToken as IApiToken} from '@/client/generated'
import {isApiTokenExpired, type ApiTokenPreset, type ApiTokenPresetGroups} from '@/helpers/apiToken'
import ApiTokenForm from '@/components/token/ApiTokenForm.vue'
import McpClientGuide from '@/components/token/McpClientGuide.vue'
import XButton from '@/components/input/Button.vue'
import FormField from '@/components/input/FormField.vue'
import Message from '@/components/misc/Message.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import {useCopyToClipboard} from '@/composables/useCopyToClipboard'
import {useTitle} from '@/composables/useTitle'
import {formatDateSince, formatDisplayDate} from '@/helpers/time/formatDate'
import {MCP_HELP} from '@/urls'

defineOptions({name: 'McpSettings'})

const {t} = useI18n({useScope: 'global'})
useTitle(() => `MCP - ${t('user.settings.title')}`)
// The page shows its own load errors: an unknown token list must not read as "no MCP tokens".
const {data: info, isPending: infoPending, isError: infoError, refetch: refetchInfo} = useQuery({...mcpInfoQuery(), meta: {handlesError: true}})
const {
	data: allTokens,
	isPending: tokensPending,
	isError: tokensError,
	isSuccess: tokensLoaded,
	refetch: refetchTokens,
} = useQuery({...allApiTokensQuery(), meta: {handlesError: true}})
const deleteMutation = useDeleteApiTokenMutation()
const endpoint = computed(() => info.value?.endpoint ?? '')
const tokens = computed(() => (allTokens.value ?? []).filter(token => token.permissions?.mcp?.includes('access')))
const loading = computed(() => infoPending.value || tokensPending.value)
const infoFailed = computed(() => infoError.value && !info.value)
const tokensFailed = computed(() => tokensError.value && !allTokens.value)
const showCreateForm = ref(false)
const newToken = ref('')
const tokenToDelete = ref<IApiToken>()
const showDeleteModal = ref(false)
const copy = useCopyToClipboard()
const now = useNow({interval: 60_000})

function presetGroups(groups: Record<string, string | string[] | null> = {}): ApiTokenPresetGroups {
	return Object.fromEntries(Object.entries(groups).map(([group, permissions]) => [
		group,
		permissions === '*' ? '*' : Array.isArray(permissions) ? permissions : [],
	]))
}

const presets = computed<ApiTokenPreset[]>(() => info.value ? [
	{id: 'readOnly', groups: presetGroups(info.value.presets?.read_only)},
	{id: 'typed', groups: presetGroups(info.value.presets?.typed), label: t('user.settings.mcp.typedPreset')},
	{id: 'fullAccess', groups: presetGroups(info.value.presets?.full)},
] : [])
const initialScopes = computed(() => Object.entries(info.value?.presets?.typed ?? {})
	.flatMap(([group, permissions]) => (permissions ?? []).map(permission => `${group}:${permission}`))
	.join(','))

function onTokenCreated(token: IApiToken) {
	newToken.value = token.token ?? ''
	showCreateForm.value = false
}

function done() { newToken.value = '' }

// The dialog stays open (and busy) until the token is really gone; a failure leaves it open to retry or cancel.
async function deleteToken() {
	const token = tokenToDelete.value
	if (!token?.id || deleteMutation.isPending.value) return
	try {
		await deleteMutation.mutateAsync(token.id)
	} catch {
		return // The mutation reports the error.
	}
	if (tokenToDelete.value?.id !== token.id) return
	tokenToDelete.value = undefined
	showDeleteModal.value = false
}
</script>

<template>
	<div class="settings-page">
		<PageHeader title="MCP">
			<template #description>
				{{ t('user.settings.mcp.intro') }}
				<a
					:href="MCP_HELP"
					target="_blank"
					rel="noreferrer"
				>{{ t('user.settings.mcp.more') }}</a>
			</template>
		</PageHeader>
		<Card :loading="loading">
			<LoadError
				v-if="infoFailed"
				:retry="refetchInfo"
			/>
			<template v-if="info">
				<label
					class="label"
					for="mcp-endpoint"
				>{{ t('user.settings.mcp.endpoint') }}</label>
				<FormField
					id="mcp-endpoint"
					:model-value="endpoint"
					readonly
				>
					<template #addon>
						<XButton
							:shadow="false"
							icon="paste"
							:aria-label="t('misc.copy')"
							@click="copy(endpoint)"
						/>
					</template>
				</FormField>
				<template v-if="newToken">
					<Message
						variant="success"
						class="mbe-4"
					>
						{{ t('user.settings.mcp.created') }}<br>
						{{ t('user.settings.apiTokens.tokenCreatedNotSeeAgain') }}
					</Message>
					<McpClientGuide
						:endpoint="endpoint"
						:token="newToken"
					/>
					<XButton
						class="mbs-4"
						@click="done"
					>
						{{ t('task.attributes.done') }}
					</XButton>
				</template>
				<template v-else>
					<h2 class="settings-subheading">
						{{ t('user.settings.mcp.tokens') }}
					</h2>
					<LoadError
						v-if="tokensFailed"
						class="mbe-4"
						:message="t('user.settings.accessLoadError')"
						:retry="refetchTokens"
					/>
					<div
						v-else-if="tokens.length"
						class="has-horizontal-overflow"
					>
						<table class="table">
							<thead>
								<tr>
									<th>{{ t('user.settings.apiTokens.attributes.title') }}</th>
									<th>{{ t('user.settings.apiTokens.attributes.expiresAt') }}</th>
									<th>{{ t('misc.created') }}</th>
									<th class="has-text-end">
										{{ t('misc.actions') }}
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="token in tokens"
									:key="token.id"
									:class="{'mcp-token-expired': isApiTokenExpired(token, now.getTime())}"
								>
									<td>{{ token.title }}</td>
									<td>
										{{ formatDisplayDate(token.expires_at) }}
										<p
											v-if="isApiTokenExpired(token, now.getTime())"
											class="has-text-danger"
										>
											{{ t('user.settings.apiTokens.expired', {ago: formatDateSince(token.expires_at)}) }}
										</p>
									</td>
									<td>{{ formatDisplayDate(token.created) }}</td>
									<td class="has-text-end">
										<XButton
											variant="secondary"
											danger
											class="is-small"
											@click="() => {tokenToDelete = token; showDeleteModal = true}"
										>
											{{ t('misc.delete') }}
										</XButton>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p
						v-else-if="tokensLoaded"
						class="mbe-4 mcp-empty"
					>
						{{ t('user.settings.mcp.empty') }}
					</p>
					<p class="mbe-4">
						<RouterLink :to="{name: 'user.settings.apiTokens'}">
							{{ t('user.settings.mcp.manageTokens') }}
						</RouterLink>
					</p>
					<ApiTokenForm
						v-if="showCreateForm"
						:routes="info.routes ?? {}"
						:presets="presets"
						:locked-scopes="{mcp: ['access']}"
						initial-title="MCP"
						:initial-scopes="initialScopes"
						@created="onTokenCreated"
						@cancel="showCreateForm = false"
					/>
					<XButton
						v-else
						icon="plus"
						@click="showCreateForm = true"
					>
						{{ t('user.settings.apiTokens.createAToken') }}
					</XButton>
				</template>
			</template>
			<Modal
				danger
				:enabled="showDeleteModal"
				:confirm-label="t('user.settings.apiTokens.delete.confirm')"
				@close="showDeleteModal = false"
				@submit="deleteToken"
			>
				<template #header>
					{{ t('user.settings.apiTokens.delete.header') }}
				</template>
				<template #text>
					<p v-if="tokenToDelete">
						{{ t('user.settings.apiTokens.delete.text1', {token: tokenToDelete.title}) }}<br>
						{{ t('user.settings.apiTokens.delete.text2') }}
					</p>
				</template>
			</Modal>
		</Card>
	</div>
</template>

<style scoped lang="scss">
.settings-subheading {
	margin-block: var(--space-5) var(--space-3);
	font-size: var(--text-lg);
}

.mcp-empty {
	color: var(--text-secondary);
}

.mcp-token-expired {
	opacity: .6;
}
</style>
