<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {useRoute} from 'vue-router'
import AccountUsagePanel from '@/components/admin/AccountUsagePanel.vue'
import Modal from '@/components/misc/Modal.vue'
import Message from '@/components/misc/Message.vue'
import XButton from '@/components/input/Button.vue'
import {
	siteAccountEventsQuery,
	useSiteAccountActionMutation,
	type ManagedAccount,
	type AccountAction,
} from '@/client/queries/siteAccounts'
import {currentSiteUsageData} from '@/client/queries/siteUsage'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {useAuthStore} from '@/stores/auth'

const {t, locale} = useI18n({useScope: 'global'})
const accountErrors: Record<string, string> = {
	account_management_forbidden: 'siteAccounts.errors.forbidden',
	account_not_found: 'siteAccounts.errors.notFound',
	account_scope_changed: 'siteAccounts.errors.changed',
	account_status_changed: 'siteAccounts.errors.changed',
	account_status_unchanged: 'siteAccounts.errors.changed',
	account_status_invalid: 'siteAccounts.errors.changed',
	account_reason_too_long: 'siteAccounts.errors.reason',
	account_protected: 'siteAccounts.errors.protected',
	account_confirmation_mismatch: 'siteAccounts.errors.confirmation',
}
const route = useRoute()
const auth = useAuthStore()
const owner = captureClientRequestContext()
const allowed = ref(false)
const verifyingAccess = ref(false)
function currentOwner() {
	// Session changes are reactive even when a replacement login has the same numeric account ID.
	return auth.authUser && Boolean(auth.session) && isClientRequestContextCurrent(owner)
}
const selection = ref<{account: ManagedAccount, action: AccountAction} | null>(null)
const confirmation = ref('')
const confirmationInput = ref<HTMLInputElement | null>(null)
const reason = ref('')
const failure = ref('')
const receipt = ref('')
const showEvents = ref(false)
const eventPage = ref(1)
const action = useSiteAccountActionMutation(owner)
const events = useQuery(computed(() => ({
	...siteAccountEventsQuery(eventPage.value, owner),
	enabled: allowed.value && showEvents.value && currentOwner(),
})))
const eventResult = computed(() => currentOwner() && allowed.value && !events.isFetching.value && !events.isError.value
	? currentSiteUsageData(events.data.value) : undefined)
const eventPagination = ref<{
	total: number,
	total_pages: number,
} | null>(null)
watch(eventResult, result => {
	if (result) eventPagination.value = {
		total: result.total,
		total_pages: result.total_pages,
	}
})
const canSubmit = computed(() => currentOwner() && allowed.value && !verifyingAccess.value && selection.value
	&& confirmation.value === selection.value.account.username
	&& !action.isPending.value && reason.value.length <= 250)

function protectedReason(account: ManagedAccount) {
	return t(`siteAccounts.protection.${account.protected_reason || 'protected'}`)
}
function open(account: ManagedAccount, selected: AccountAction, event: MouseEvent) {
	if (action.isPending.value || verifyingAccess.value || !allowed.value || !isClientRequestContextCurrent(owner)) return
	if (selected === 'revoke' ? !account.can_revoke_access : !account.can_change_status) return
	returnFocus = event.currentTarget as HTMLElement
	selection.value = {account: {...account}, action: selected}
	confirmation.value = ''
	reason.value = ''
	failure.value = ''
	receipt.value = ''
}
let returnFocus: HTMLElement | null = null
function close() {
	if (!action.isPending.value) void dismiss()
}
async function dismiss() {
	const accountId = selection.value?.account.id
	selection.value = null
	confirmation.value = ''
	reason.value = ''
	failure.value = ''
	await nextTick()
	if (returnFocus?.isConnected) returnFocus.focus()
	else {
		const target = accountId && document.querySelector<HTMLElement>(`[data-managed-account="${accountId}"] button`)
		if (target) target.focus()
		else document.querySelector<HTMLElement>('.accounts-page .usage-search input')?.focus()
	}
	returnFocus = null
}
async function submit() {
	const selected = selection.value
	if (!selected || !canSubmit.value || !isClientRequestContextCurrent(owner)) return
	failure.value = ''
	try {
		const result = await action.mutateAsync({
			id: selected.account.id,
			action: selected.action,
			expectedStatus: selected.account.status,
			confirmUsername: confirmation.value,
			reason: reason.value,
		})
		if (!isClientRequestContextCurrent(owner) || selection.value !== selected) return
		receipt.value = t('siteAccounts.completed', {
			username: selected.account.username,
			action: t(`siteAccounts.actions.${selected.action}`),
			sessions: result.revoked_sessions,
			tokens: result.revoked_api_tokens,
		})
		await dismiss()
	} catch (cause) {
		if (isRequestContextAbort(cause) || !isClientRequestContextCurrent(owner) || selection.value !== selected) return
		const detail = (cause as {detail?: string}).detail
		failure.value = t(detail && Object.prototype.hasOwnProperty.call(accountErrors, detail) ? accountErrors[detail] : 'siteAccounts.failed')
	}
}
function statusName(value?: number) {
	return t(`siteUsage.statuses.${['active', 'email_confirmation_required', 'disabled', 'account_locked'][value ?? -1] || 'unknown'}`)
}
function date(value?: string) {
	if (!value || Number.isNaN(Date.parse(value))) return '—'
	return new Intl.DateTimeFormat(locale.value, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(value))
}
function changeEventPage(delta: number) {
	if (!eventPagination.value || events.isFetching.value || verifyingAccess.value) return
	const target = eventPage.value + delta
	if (target > 0 && target <= eventPagination.value.total_pages) eventPage.value = target
}
function clearPrivatePresentation() {
	returnFocus = null
	selection.value = null
	confirmation.value = ''
	reason.value = ''
	failure.value = ''
	receipt.value = ''
	showEvents.value = false
	eventPagination.value = null
	eventPage.value = 1
}
watch(allowed, value => {
	if (!value) clearPrivatePresentation()
}, {flush: 'sync'})
watch([() => auth.identityKey, () => auth.currentSessionId, () => route.fullPath], clearPrivatePresentation, {flush: 'sync'})
</script>

<template>
	<div class="accounts-page">
		<AccountUsagePanel
			management
			@access="allowed = $event"
			@verifying="verifyingAccess = $event"
		>
			<template #accountActions="{account}">
				<div
					class="account-controls"
					:data-managed-account="account.id"
				>
					<p class="account-access-counts">
						{{ t('siteAccounts.credentials', {sessions: account.sessions, tokens: account.api_tokens, bots: account.bots}) }}
					</p>
					<p
						v-if="account.protected_reason"
						class="account-protected"
					>
						{{ protectedReason(account) }}
					</p>
					<div
						v-if="!account.is_protected && (account.can_change_status || account.can_revoke_access)"
						class="account-actions"
					>
						<XButton
							v-if="account.can_change_status && currentOwner()"
							variant="secondary"
							:danger="account.status === 0"
							:shadow="false"
							@click="open(account, account.status === 0 ? 'disable' : 'enable', $event)"
						>
							{{ t(account.status === 0 ? 'siteAccounts.actions.disable' : 'siteAccounts.actions.enable') }}
						</XButton>
						<XButton
							v-if="account.can_revoke_access && currentOwner()"
							variant="secondary"
							:shadow="false"
							@click="open(account, 'revoke', $event)"
						>
							{{ t('siteAccounts.actions.revoke') }}
						</XButton>
					</div>
				</div>
			</template>
		</AccountUsagePanel>
		<Message
			v-if="receipt && allowed && currentOwner()"
			variant="success"
			role="status"
		>
			{{ receipt }}
		</Message>
		<section
			v-if="allowed && currentOwner()"
			class="account-audit"
		>
			<XButton
				variant="secondary"
				:shadow="false"
				:aria-expanded="showEvents"
				@click="showEvents = !showEvents"
			>
				{{ t('siteAccounts.audit.title') }}
			</XButton>
			<template v-if="showEvents">
				<p class="account-help">
					{{ t('siteAccounts.audit.help') }}
				</p>
				<p
					v-if="events.isFetching.value || events.isPending.value"
					role="status"
				>
					{{ t('misc.loading') }}
				</p>
				<Message
					v-else-if="events.isError.value"
					variant="danger"
				>
					{{ t('siteAccounts.audit.failed') }}
					<XButton
						variant="secondary"
						:shadow="false"
						@click="events.refetch()"
					>
						{{ t('misc.retry') }}
					</XButton>
				</Message>
				<template v-else-if="eventResult">
					<p v-if="!eventResult.items?.length">
						{{ t('siteAccounts.audit.empty') }}
					</p>
					<ol
						v-else
						class="account-events"
					>
						<li
							v-for="event in eventResult.items ?? []"
							:key="event.id"
						>
							<strong>{{ event.target_username }} · #{{ event.target_id }}</strong>
							<p>{{ t(`siteAccounts.audit.${event.action}`) }} · {{ event.actor_username }} · {{ date(event.created) }}</p>
							<p v-if="event.action === 'status_changed'">
								{{ statusName(event.old_status) }} → {{ statusName(event.new_status) }}
							</p>
							<p>{{ t('siteAccounts.audit.revoked', {sessions: event.revoked_sessions, tokens: event.revoked_api_tokens}) }}</p>
							<p
								v-if="event.reason"
								class="account-event-reason"
							>
								{{ event.reason }}
							</p>
						</li>
					</ol>
				</template>
				<nav
					v-if="eventPagination && eventPagination.total_pages > 1"
					class="account-event-pages"
					:aria-label="t('siteAccounts.audit.pagination')"
					:aria-busy="events.isFetching.value"
				>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="eventPage <= 1 || events.isFetching.value || verifyingAccess"
						@click="changeEventPage(-1)"
					>
						{{ t('siteUsage.previous') }}
					</XButton>
					<span>{{ t('siteUsage.page', {page: eventPage, total: eventPagination.total_pages, count: eventPagination.total}) }}</span>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="eventPage >= eventPagination.total_pages || events.isFetching.value || verifyingAccess"
						@click="changeEventPage(1)"
					>
						{{ t('siteUsage.next') }}
					</XButton>
				</nav>
			</template>
		</section>
		<Modal
			v-if="selection && allowed && currentOwner()"
			class="account-management-dialog"
			:title="t('siteAccounts.confirmTitle', {action: t(`siteAccounts.actions.${selection.action}`)})"
			:aria-label="t('siteAccounts.confirmTitle', {action: t(`siteAccounts.actions.${selection.action}`)})"
			:loading="action.isPending.value"
			variant="hint-modal"
			@opened="confirmationInput?.focus()"
			@close="close"
		>
			<form
				class="account-confirm"
				@submit.prevent="submit"
			>
				<h2>{{ t('siteAccounts.confirmTitle', {action: t(`siteAccounts.actions.${selection.action}`)}) }}</h2>
				<p class="account-confirm-identity">
					<strong>{{ selection.account.name || selection.account.username }}</strong><span>{{ selection.account.username }} · #{{ selection.account.id }}</span>
				</p>
				<p class="account-impact">
					{{ t(`siteAccounts.effects.${selection.action}`) }}
				</p>
				<p
					v-if="verifyingAccess"
					role="status"
				>
					{{ t('siteAccounts.checkingAccess') }}
				</p>
				<label>
					<span>{{ t('siteAccounts.confirmUsername', {username: selection.account.username}) }}</span>
					<input
						ref="confirmationInput"
						v-model="confirmation"
						class="input"
						autocomplete="off"
						:readonly="action.isPending.value"
						:aria-label="t('siteAccounts.usernameConfirmation')"
						required
					>
				</label>
				<label>
					<span>{{ t('siteAccounts.reason') }}</span>
					<textarea
						v-model="reason"
						class="textarea"
						maxlength="250"
						rows="2"
						:readonly="action.isPending.value"
					/>
				</label>
				<Message
					v-if="failure"
					variant="danger"
				>
					{{ failure }}
				</Message>
				<div class="account-confirm-actions">
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="action.isPending.value"
						@click="close"
					>
						{{ t('misc.cancel') }}
					</XButton>
					<XButton
						type="submit"
						:danger="selection.action !== 'enable'"
						:shadow="false"
						:aria-disabled="!canSubmit"
						:loading="action.isPending.value"
					>
						{{ t(`siteAccounts.actions.${selection.action}`) }}
					</XButton>
				</div>
			</form>
		</Modal>
	</div>
</template>

<style scoped lang="scss">
.accounts-page {
	max-inline-size: 88rem;
	margin-inline: auto;
}
.account-controls {
	border-block-start: 1px solid var(--border-subtle);
	padding-block: .75rem;
}
.account-access-counts, .account-protected, .account-help {
	color: var(--text-secondary);
	font-size: .875rem;
	line-height: 1.6;
}
.account-access-counts {
	margin-block: 0 .5rem;
}
.account-protected {
	margin: 0;
}
.account-actions, .account-confirm-actions, .account-event-pages {
	display: flex;
	flex-wrap: wrap;
	gap: .5rem;
}
.accounts-page :deep(.button), .account-confirm :deep(.button) {
	min-block-size: 2.75rem;
}
.account-audit {
	margin-block: 1rem;
}
.account-events {
	list-style: none;
	padding: 0;
	display: grid;
	gap: .75rem;
}
.account-events li {
	padding: 1rem;
	border: 1px solid var(--border-subtle);
	border-radius: .75rem;
	background: var(--surface-raised);
	overflow-wrap: anywhere;
}
.account-events p {
	margin-block: .35rem 0;
	font-size: .85rem;
	color: var(--text-secondary);
}
.account-event-reason {
	white-space: pre-wrap;
}
.account-event-pages {
	justify-content: center;
	align-items: center;
	font-size: .875rem;
}
.account-confirm {
	inline-size: 100%;
	min-inline-size: 0;
	padding: 1.25rem;
	background: var(--surface-raised);
	color: var(--text-primary);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	box-shadow: var(--elevation-3);
	text-align: start;
	overflow-wrap: anywhere;
}
:global(.modal-dialog.account-management-dialog.hint-modal .modal-content:not(.is-wide)) {
	inline-size: calc(100% - 2rem);
	max-inline-size: 32rem;
	margin-inline: auto;
}
.account-confirm h2 {
	font-size: 1.25rem;
	margin-block: 0 1rem;
}
.account-confirm-identity {
	display: flex;
	flex-direction: column;
	gap: .25rem;
}
.account-confirm-identity span {
	color: var(--text-secondary);
	font-size: .875rem;
}
.account-impact {
	padding: .875rem;
	background: var(--surface-sunken);
	border-radius: .5rem;
	line-height: 1.7;
}
.account-confirm label {
	display: flex;
	flex-direction: column;
	gap: .5rem;
	margin-block: 1rem;
	font-size: .875rem;
}
.account-confirm-actions {
	justify-content: flex-end;
	margin-block-start: 1rem;
}
@media (width <= 767px) {
	.account-actions > *, .account-confirm-actions > * {
		flex: 1 1 8rem;
	}
	.account-confirm {
		padding: 1rem;
	}
}
</style>
