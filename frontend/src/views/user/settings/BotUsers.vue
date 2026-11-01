<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {useRouteQuery} from '@vueuse/router'
import {useTitle} from '@/composables/useTitle'
import {useClampedPage} from '@/composables/useClampedPage'

import XButton from '@/components/input/Button.vue'
import FormField from '@/components/input/FormField.vue'
import Message from '@/components/misc/Message.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import Pagination from '@/components/misc/Pagination.vue'
import PaginationEmit from '@/components/misc/PaginationEmit.vue'
import ApiTokenForm from '@/components/token/ApiTokenForm.vue'

import {botsQuery, useCreateBotMutation, useUpdateBotMutation, useDeleteBotMutation} from '@/client/queries/bots'
import {clampPage, normalizePageNumber} from '@/client/queries/pagination'
import {useQueries, useQuery} from '@tanstack/vue-query'
import {botApiTokensQuery, useDeleteApiTokenMutation} from '@/client/queries/apiTokens'
import type {ApiToken, BotUser} from '@/client/generated'
import {formatDisplayDate} from '@/helpers/time/formatDate'
import {getErrorText, success} from '@/message'

type Bot = BotUser & Required<Pick<BotUser, 'id' | 'status'>>

const STATUS_ACTIVE = 0
const STATUS_DISABLED = 2

const {t} = useI18n({useScope: 'global'})
useTitle(() => `${t('user.settings.bots.title')} - ${t('user.settings.title')}`)

const page = useRouteQuery('page', '1', {transform: normalizePageNumber})
// The page shows its own load error: an unknown list must not open the "first bot" form as if there were none.
const {data: botPage, isPlaceholderData, isPending: botsPending, isError: botsError, isSuccess: botsLoaded, refetch: refetchBots} = useQuery(computed(() => ({
	...botsQuery(page.value),
	meta: {handlesError: true},
})))
const createMutation = useCreateBotMutation()
const updateMutation = useUpdateBotMutation()
const deleteMutation = useDeleteBotMutation()
const deleteTokenMutation = useDeleteApiTokenMutation()
const bots = computed(() => (botPage.value?.items ?? []).filter((bot): bot is Bot => typeof bot.id === 'number' && bot.id > 0 && typeof bot.status === 'number'))
const totalPages = computed(() => botPage.value?.total_pages ?? 0)
const hasBots = computed(() => (botPage.value?.total ?? 0) > 0)
// Only a loaded, empty list means "no bots yet".
const showFirstBotForm = computed(() => botsLoaded.value && !hasBots.value)
useClampedPage(page, {data: botPage, isPlaceholderData})
const newBotUsername = ref('')
const newBotName = ref('')
const createError = ref<string | null>(null)
const showCreateForm = ref(false)

const tokenPages = ref<Record<number, number>>({})
const tokenQueries = useQueries({queries: computed(() => bots.value.map(bot => botApiTokensQuery(
	bot.id,
	tokenPages.value[bot.id] ?? 1,
)))})
const tokenPageByBot = computed(() => Object.fromEntries(
	bots.value.map((bot, index) => [bot.id, tokenQueries.value[index]?.data]),
))
const tokenLoadFailedByBot = computed(() => Object.fromEntries(
	bots.value.map((bot, index) => [bot.id, Boolean(tokenQueries.value[index]?.isError && !tokenQueries.value[index]?.data)]),
))
function retryTokens(bot: Bot) {
	const index = bots.value.findIndex(candidate => candidate.id === bot.id)
	return tokenQueries.value[index]?.refetch()
}
watch(tokenQueries, results => bots.value.forEach((bot, index) => {
	const result = results[index]
	if (!result) return
	const current = tokenPages.value[bot.id] ?? 1
	const clamped = clampPage(current, result)
	if (clamped !== current) tokenPages.value[bot.id] = clamped
}))
const newTokensByBot = ref<Record<number, string>>({})
const showTokenForm = ref<Record<number, boolean>>({})
const editingName = ref<Record<number, boolean>>({})
const nameDraft = ref<Record<number, string>>({})

const showDeleteModal = ref<boolean>(false)
const botToDelete = ref<Bot>()
const tokenToDelete = ref<ApiToken>()

async function createBot() {
	if (createMutation.isPending.value) return
	createError.value = null
	const username = newBotUsername.value.startsWith('bot-') ? newBotUsername.value : `bot-${newBotUsername.value}`
	const payload: Pick<BotUser, 'username' | 'name'> = {username}
	const trimmedName = newBotName.value.trim()
	if (trimmedName !== '') {
		payload.name = trimmedName
	}
	const before = botPage.value
	try {
		const created = await createMutation.mutateAsync(payload)
		newBotUsername.value = ''
		newBotName.value = ''
		showCreateForm.value = false
		success({message: t('user.settings.bots.createSuccess', {username: created.username})})
		if (before && before.per_page > 0) {
			page.value = Math.ceil((before.total + 1) / before.per_page)
		}
	} catch (e: unknown) {
		createError.value = getErrorText(e)
	}
}

async function toggleBotStatus(bot: Bot) {
	const updated = {
		...bot,
		status: bot.status === STATUS_ACTIVE ? STATUS_DISABLED : STATUS_ACTIVE,
	}
	try { await updateMutation.mutateAsync({id: bot.id, body: updated}) } catch { /* Mutation reports the error. */ }
}

function startEditName(bot: Bot) {
	nameDraft.value[bot.id] = bot.name ?? ''
	editingName.value[bot.id] = true
}

function cancelEditName(bot: Bot) {
	editingName.value[bot.id] = false
	delete nameDraft.value[bot.id]
}

async function saveBotName(bot: Bot) {
	const draft = nameDraft.value[bot.id]
	const updated = {
		...bot,
		name: (draft ?? '').trim(),
	}
	try {
		await updateMutation.mutateAsync({id: bot.id, body: updated})
		if (nameDraft.value[bot.id] !== draft) {
			return
		}
		editingName.value[bot.id] = false
		delete nameDraft.value[bot.id]
	} catch { /* Mutation reports the error. */ }
}

// Both delete dialogs stay open (and busy) until the server confirms; a failure leaves them open to retry or cancel.
async function deleteBot() {
	const bot = botToDelete.value
	if (!bot || deleteMutation.isPending.value) {
		return
	}
	try {
		await deleteMutation.mutateAsync(bot.id)
	} catch {
		return // The mutation reports the error.
	}
	delete newTokensByBot.value[bot.id]
	delete tokenPages.value[bot.id]
	if (botToDelete.value?.id !== bot.id) return
	showDeleteModal.value = false
	botToDelete.value = undefined
}

function onTokenCreated(bot: Bot, token: ApiToken) {
	newTokensByBot.value[bot.id] = token.token ?? ''
	showTokenForm.value[bot.id] = false
}

async function deleteToken() {
	const token = tokenToDelete.value
	if (!token?.id || deleteTokenMutation.isPending.value) return
	try {
		await deleteTokenMutation.mutateAsync(token.id)
	} catch {
		return // The mutation reports the error.
	}
	if (tokenToDelete.value?.id === token.id) tokenToDelete.value = undefined
}
</script>

<template>
	<div class="settings-page">
		<PageHeader
			:title="$t('user.settings.bots.title')"
			:description="$t('user.settings.bots.description')"
		>
			<template
				v-if="(hasBots || botsError) && !showCreateForm"
				#actions
			>
				<XButton
					icon="plus"
					@click="showCreateForm = true"
				>
					{{ $t('user.settings.bots.create') }}
				</XButton>
			</template>
		</PageHeader>

		<LoadError
			v-if="botsError && !botPage"
			class="mbe-4"
			:message="$t('user.settings.accessLoadError')"
			:retry="refetchBots"
		/>

		<Card
			v-if="showFirstBotForm || showCreateForm"
			:title="$t('user.settings.bots.create')"
		>
			<form
				class="create-form"
				@submit.prevent="createBot"
			>
				<FormField
					:label="$t('user.auth.username')"
					:error="createError"
				>
					<template #default="{id}">
						<input
							:id="id"
							v-model="newBotUsername"
							class="input"
							placeholder="bot-myassistant"
						>
					</template>
				</FormField>
				<FormField :label="$t('admin.users.nameLabel')">
					<template #default="{id}">
						<input
							:id="id"
							v-model="newBotName"
							class="input"
							:placeholder="$t('user.settings.bots.namePlaceholder')"
						>
					</template>
				</FormField>
			</form>
			<template #footer>
				<XButton
					v-if="!showFirstBotForm"
					variant="tertiary"
					@click="showCreateForm = false"
				>
					{{ $t('misc.cancel') }}
				</XButton>
				<XButton
					:loading="createMutation.isPending.value"
					@click="createBot"
				>
					{{ $t('user.settings.bots.create') }}
				</XButton>
			</template>
		</Card>

		<div
			class="bot-list loader-container"
			:class="{'is-loading': isPlaceholderData || botsPending}"
		>
			<section
				v-for="bot in bots"
				:key="bot.id"
				class="bot-card"
				:aria-label="bot.username"
			>
				<div class="bot-header">
					<strong class="bot-username">{{ bot.username }}</strong>
					<template v-if="editingName[bot.id]">
						<input
							v-model="nameDraft[bot.id]"
							v-focus
							class="input bot-name-input"
							:aria-label="$t('admin.users.nameLabel')"
							:placeholder="$t('user.settings.bots.namePlaceholder')"
							@keyup.enter="saveBotName(bot)"
							@keyup.esc="cancelEditName(bot)"
						>
						<XButton
							variant="secondary"
							class="is-small"
							@click="saveBotName(bot)"
						>
							{{ $t('misc.save') }}
						</XButton>
						<XButton
							variant="tertiary"
							class="is-small"
							@click="cancelEditName(bot)"
						>
							{{ $t('misc.cancel') }}
						</XButton>
					</template>
					<template v-else>
						<span
							v-if="bot.name"
							class="bot-name"
						>{{ bot.name }}</span>
						<span
							v-else
							class="bot-name no-name"
						>{{ $t('project.share.links.noName') }}</span>
						<XButton
							variant="tertiary"
							icon="pencil-alt"
							class="is-small"
							@click="startEditName(bot)"
						>
							{{ $t('menu.edit') }}
						</XButton>
					</template>
					<span
						class="status"
						:class="{'is-active': bot.status === STATUS_ACTIVE}"
					>{{ bot.status === STATUS_ACTIVE ? $t('admin.users.statusActive') : $t('admin.users.statusDisabled') }}</span>
				</div>
				<div class="bot-actions">
					<XButton
						variant="secondary"
						class="is-small"
						@click="toggleBotStatus(bot)"
					>
						{{ bot.status === STATUS_ACTIVE ? $t('misc.disable') : $t('user.settings.bots.enable') }}
					</XButton>
					<XButton
						variant="tertiary"
						class="is-danger is-small"
						@click="() => {botToDelete = bot; showDeleteModal = true}"
					>
						{{ $t('misc.delete') }}
					</XButton>
				</div>

				<div class="tokens">
					<h3 class="tokens__title">
						{{ $t('user.settings.apiTokens.title') }}
					</h3>
					<Message
						v-if="newTokensByBot[bot.id]"
						variant="warning"
						class="mbe-3"
					>
						{{ $t('user.settings.apiTokens.tokenCreatedNotSeeAgain') }}
						<code>{{ newTokensByBot[bot.id] }}</code>
					</Message>
					<LoadError
						v-if="tokenLoadFailedByBot[bot.id]"
						class="mbe-3"
						:message="$t('user.settings.accessLoadError')"
						:retry="() => retryTokens(bot)"
					/>
					<div
						v-else-if="(tokenPageByBot[bot.id]?.items ?? []).length > 0"
						class="has-horizontal-overflow"
					>
						<table class="table is-fullwidth">
							<thead>
								<tr>
									<th>{{ $t('user.settings.apiTokens.attributes.title') }}</th>
									<th>{{ $t('user.settings.apiTokens.attributes.expiresAt') }}</th>
									<th>{{ $t('misc.created') }}</th>
									<th class="has-text-end">
										{{ $t('misc.actions') }}
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="token in tokenPageByBot[bot.id]?.items ?? []"
									:key="token.id"
								>
									<td>{{ token.title }}</td>
									<td>{{ formatDisplayDate(token.expires_at) }}</td>
									<td>{{ formatDisplayDate(token.created) }}</td>
									<td class="has-text-end">
										<XButton
											variant="secondary"
											danger
											class="is-small"
											@click="tokenToDelete = token"
										>
											{{ $t('misc.delete') }}
										</XButton>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<PaginationEmit
						:total-pages="tokenPageByBot[bot.id]?.total_pages ?? 0"
						:current-page="tokenPages[bot.id] ?? 1"
						@pageChanged="(page: number) => tokenPages[bot.id] = page"
					/>
					<p
						v-if="bot.status !== STATUS_ACTIVE"
						class="help"
					>
						{{ $t('user.settings.bots.tokensInactive') }}
					</p>
					<ApiTokenForm
						v-else-if="showTokenForm[bot.id]"
						:owner-id="bot.id"
						@created="(token: ApiToken) => onTokenCreated(bot, token)"
						@cancel="showTokenForm[bot.id] = false"
					/>
					<XButton
						v-else
						icon="plus"
						variant="secondary"
						class="is-small"
						@click="showTokenForm[bot.id] = true"
					>
						{{ $t('user.settings.apiTokens.createToken') }}
					</XButton>
				</div>
			</section>
		</div>

		<Pagination
			:total-pages="totalPages"
			:current-page="page"
		/>

		<Modal
			danger
			:enabled="showDeleteModal"
			:confirm-label="$t('user.settings.bots.delete.confirm')"
			@close="showDeleteModal = false"
			@submit="deleteBot"
		>
			<template #header>
				{{ $t('user.settings.bots.delete.header') }}
			</template>

			<template #text>
				<p v-if="botToDelete">
					{{ $t('user.settings.bots.delete.text1', {username: botToDelete.username}) }}<br>
					{{ $t('user.settings.bots.delete.text2') }}
				</p>
			</template>
		</Modal>

		<Modal
			danger
			:enabled="tokenToDelete !== undefined"
			:confirm-label="$t('user.settings.apiTokens.delete.confirm')"
			@close="tokenToDelete = undefined"
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
	</div>
</template>

<style lang="scss" scoped>
.bot-list {
	display: grid;
	gap: var(--space-4);
}

.bot-card {
	min-inline-size: 0;
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);
}

.bot-header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	margin-block-end: var(--space-2);
}

.bot-username {
	font-size: var(--text-base);
	overflow-wrap: anywhere;
}

.bot-name {
	color: var(--text-secondary);
	overflow-wrap: anywhere;
}

.bot-name-input {
	flex: 1 1 10rem;
	max-inline-size: 16rem;
}

.no-name {
	font-style: italic;
	color: var(--text-tertiary);
}

.status {
	margin-inline-start: auto;
	padding: 0 var(--space-2);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	line-height: 1.6;

	&.is-active {
		border-color: transparent;
		background: var(--tint-success);
		color: var(--text-primary);
	}
}

.bot-actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.tokens {
	margin-block-start: var(--space-4);
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--border-subtle);
}

.tokens__title {
	margin-block-end: var(--space-2);
	font-size: var(--text-md);
}

.create-form {
	display: grid;
	gap: var(--space-2);
}
</style>
