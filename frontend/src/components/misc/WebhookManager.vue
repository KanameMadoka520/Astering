<script lang="ts" setup>
import {computed, ref, watch} from 'vue'

import type {Webhook, WebhookWritable} from '@/client/generated'
import {useQuery} from '@tanstack/vue-query'
import {
	webhooksQuery,
	webhookEventsQuery,
	useCreateWebhookMutation,
	useDeleteWebhookMutation,
	type WebhookScope,
} from '@/client/queries/webhooks'
import {useClampedPage} from '@/composables/useClampedPage'
import BaseButton from '@/components/base/BaseButton.vue'
import FancyCheckbox from '@/components/input/FancyCheckbox.vue'
import FormField from '@/components/input/FormField.vue'
import FormInput from '@/components/input/FormInput.vue'
import Expandable from '@/components/base/Expandable.vue'
import User from '@/components/misc/User.vue'
import PaginationEmit from '@/components/misc/PaginationEmit.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import {formatDateShort} from '@/helpers/time/formatDate'
import {isValidHttpUrl} from '@/helpers/isValidHttpUrl'
import {useDelayedLoading} from '@/composables/useDelayedLoading'

const props = defineProps<{scope: WebhookScope}>()
const currentPage = ref(1)
// Both failures are shown in place, so they don't also need a toast.
const webhooksResult = useQuery(computed(() => ({...webhooksQuery(props.scope, currentPage.value), meta: {handlesError: true}})))
const eventsResult = useQuery(computed(() => ({...webhookEventsQuery(props.scope.kind), meta: {handlesError: true}})))
const {data: webhookData, isFetching, isPending, isPlaceholderData} = webhooksResult
const {data: eventData, isPending: isEventsPending} = eventsResult
// Without a list nobody can tell whether webhooks already send this data somewhere, so the form waits for it.
const listFailed = computed(() => webhooksResult.isError.value && webhookData.value === undefined)
const refreshFailed = computed(() => webhooksResult.isError.value && webhookData.value !== undefined)
const eventsFailed = computed(() => eventsResult.isError.value && eventData.value === undefined)
const isLoadingInitial = computed(() => isPending.value || isEventsPending.value)
const showInitialLoader = useDelayedLoading(isLoadingInitial)
const reloading = useDelayedLoading(isPlaceholderData)
const webhooks = computed(() => webhookData.value?.items ?? [])
// total, not items: a page emptied by a delete is [] until the page clamps.
const hasWebhooks = computed(() => (webhookData.value?.total ?? 0) > 0)
const totalPages = computed(() => webhookData.value?.total_pages ?? 0)
useClampedPage(currentPage, {data: webhookData, isPlaceholderData})
const availableEvents = computed(() => eventData.value ?? [])
const createMutation = useCreateWebhookMutation()
const deleteMutation = useDeleteWebhookMutation()
const loading = computed(() => isFetching.value || createMutation.isPending.value || deleteMutation.isPending.value)
function emptyDraft(): WebhookWritable & {target_url: string} {
	return {target_url: '', secret: '', basic_auth_user: '', basic_auth_password: '', events: []}
}

defineOptions({name: 'WebhookManager'})

const showNewForm = ref(false)
const showBasicAuth = ref(false)
const newWebhook = ref(emptyDraft())
const newWebhookEvents = ref<Record<string, boolean>>({})

function initEvents(events: string[]) {
	newWebhookEvents.value = Object.fromEntries(
		events.map(event => [event, false]),
	)
}

watch(availableEvents, (events) => {
	if (events) initEvents(events)
}, {immediate: true})

const webhookTargetUrlValid = ref(true)
const selectedEventsValid = ref(true)
const showDeleteModal = ref(false)
// Kept after closing so the dialog doesn't blank during its fade-out.
const webhookToDelete = ref<Webhook>()

function validateTargetUrl() {
	webhookTargetUrlValid.value = isValidHttpUrl(newWebhook.value.target_url)
}

function getSelectedEventsArray() {
	return Object.entries(newWebhookEvents.value)
		.filter(([, use]) => use)
		.map(([event]) => event)
}

function validateSelectedEvents() {
	const events = getSelectedEventsArray()
	selectedEventsValid.value = events.length > 0
}

async function create() {
	validateTargetUrl()
	if (!webhookTargetUrlValid.value) {
		return
	}

	const selectedEvents = getSelectedEventsArray()
	newWebhook.value.events = selectedEvents

	validateSelectedEvents()
	if (!selectedEventsValid.value) {
		return
	}

	try {
		await createMutation.mutateAsync({scope: props.scope, body: newWebhook.value})
	} catch {
		return
	}
	newWebhook.value = emptyDraft()
	initEvents(availableEvents.value)
	showNewForm.value = false
}

function confirmDelete(webhook: Webhook) {
	webhookToDelete.value = webhook
	showDeleteModal.value = true
}

// Synchronous guard: isPending only flips after the next render, too late for a double click.
let deleting = false

// The dialog stays open until the request settles; on failure the toast says why and the person can retry or cancel.
async function doDelete() {
	const webhook = webhookToDelete.value
	if (!webhook?.id || deleting) return
	deleting = true
	try {
		await deleteMutation.mutateAsync({scope: props.scope, id: webhook.id})
	} catch {
		return
	} finally {
		deleting = false
	}
	if (webhookToDelete.value === webhook) showDeleteModal.value = false
}
</script>

<template>
	<div
		class="loader-container"
		:class="{'is-loading': showInitialLoader || reloading}"
	>
		<LoadError
			v-if="listFailed"
			:retry="() => webhooksResult.refetch()"
		/>

		<XButton
			v-if="!listFailed && hasWebhooks && !showNewForm"
			icon="plus"
			class="mbe-4"
			@click="showNewForm = true"
		>
			{{ $t('project.webhooks.create') }}
		</XButton>

		<div
			v-if="!listFailed && !isLoadingInitial && (!hasWebhooks || showNewForm)"
			class="p-4"
		>
			<FormField
				id="targetUrl"
				v-model="newWebhook.target_url"
				:label="$t('project.webhooks.targetUrl')"
				required
				:placeholder="$t('project.webhooks.targetUrl')"
				:error="webhookTargetUrlValid ? null : $t('project.webhooks.targetUrlInvalid')"
				@focusout="validateTargetUrl"
			/>
			<FormField :label="$t('project.webhooks.secret')">
				<template #default="{id}">
					<FormInput
						:id="id"
						v-model="newWebhook.secret"
					/>
				</template>
			</FormField>
			<p class="help">
				{{ $t('project.webhooks.secretHint') }}
				<BaseButton href="https://vikunja.io/docs/webhooks/">
					{{ $t('project.webhooks.secretDocs') }}
				</BaseButton>
			</p>
			<BaseButton
				class="mbe-2 has-text-primary"
				@click="showBasicAuth = !showBasicAuth"
			>
				{{ $t('project.webhooks.basicauthlink') }}
			</BaseButton>
			<Expandable
				:open="showBasicAuth"
				class="content"
			>
				<FormField :label="$t('project.webhooks.basicauthuser')">
					<template #default="{id}">
						<FormInput
							:id="id"
							v-model="newWebhook.basic_auth_user"
						/>
					</template>
				</FormField>
				<FormField :label="$t('project.webhooks.basicauthpassword')">
					<template #default="{id}">
						<FormInput
							:id="id"
							v-model="newWebhook.basic_auth_password"
						/>
					</template>
				</FormField>
			</Expandable>
			<div class="field">
				<label
					class="label"
					for="events"
				>
					{{ $t('project.webhooks.events') }}
				</label>
				<p class="help">
					{{ $t('project.webhooks.eventsHint') }}
				</p>
				<LoadError
					v-if="eventsFailed"
					:retry="() => eventsResult.refetch()"
				/>
				<div
					v-else
					class="control"
				>
					<FancyCheckbox
						v-for="event in availableEvents"
						:key="event"
						v-model="newWebhookEvents[event]"
						class="available-events-check"
						@update:modelValue="validateSelectedEvents"
					>
						{{ event }}
					</FancyCheckbox>
				</div>
				<p
					v-if="!selectedEventsValid"
					class="help is-danger"
				>
					{{ $t('project.webhooks.mustSelectEvents') }}
				</p>
			</div>
			<XButton
				icon="plus"
				:loading="loading"
				@click="create"
			>
				{{ $t('project.webhooks.create') }}
			</XButton>
		</div>

		<table
			v-if="webhooks.length > 0"
			class="table has-actions is-striped is-hoverable is-fullwidth"
		>
			<thead>
				<tr>
					<th>{{ $t('project.webhooks.targetUrl') }}</th>
					<th>{{ $t('project.webhooks.events') }}</th>
					<th>{{ $t('misc.created') }}</th>
					<th>{{ $t('misc.createdBy') }}</th>
					<th />
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="w in webhooks"
					:key="w.id"
				>
					<td class="webhook-target-url">
						{{ w.target_url }}
					</td>
					<td>{{ (w.events ?? []).join(', ') }}</td>
					<td>{{ formatDateShort(w.created) }}</td>
					<td>
						<User
							:avatar-size="25"
							:user="w.created_by ?? {}"
						/>
					</td>

					<td class="actions">
						<XButton
							danger
							icon="trash-alt"
							:aria-label="$t('project.webhooks.delete')"
							@click="confirmDelete(w)"
						/>
					</td>
				</tr>
			</tbody>
		</table>
		<!-- Rows from an earlier load stay, but they may be out of date. -->
		<LoadError
			v-if="refreshFailed"
			:message="$t('project.share.refreshError')"
			:retry="() => webhooksResult.refetch()"
		/>
		<PaginationEmit
			:total-pages="totalPages"
			:current-page="currentPage"
			@pageChanged="currentPage = $event"
		/>

		<Modal
			danger
			:enabled="showDeleteModal"
			:loading="deleteMutation.isPending.value"
			:confirm-label="$t('misc.delete')"
			@close="showDeleteModal = false"
			@submit="doDelete()"
		>
			<template #header>
				<span>{{ $t('project.webhooks.delete') }}</span>
			</template>

			<template #text>
				<p class="webhook-delete-target">
					<span class="is-sr-only">{{ $t('project.webhooks.targetUrl') }}: </span>
					<code>{{ webhookToDelete?.target_url }}</code>
				</p>
				<p>{{ $t('project.webhooks.deleteText') }}</p>
			</template>
		</Modal>
	</div>
</template>

<style lang="scss" scoped>
.available-events-check {
	margin-inline-end: var(--space-2);
	inline-size: min(12.5rem, 100%);
}

// Webhook URLs have no break opportunities, so without this the cell's min-content
// width forces the whole table wider than its container.
.webhook-target-url,
.webhook-delete-target {
	overflow-wrap: anywhere;
}
</style>
