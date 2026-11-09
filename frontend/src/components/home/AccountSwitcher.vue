<template>
	<component
		:is="inline ? 'section' : Modal"
		v-if="inline ? Boolean(accounts.data.value?.accounts?.length || accounts.isError.value) : open"
		:enabled="open"
		:loading="busy"
		:aria-label="t('accountSwitch.title')"
		class="account-switcher"
		@close="open = false"
	>
		<div class="account-switcher__body">
			<h2>{{ t('accountSwitch.title') }}</h2>
			<p class="account-switcher__help">
				{{ t('accountSwitch.help') }}
			</p>
			<Message
				v-if="failure"
				variant="danger"
			>
				{{ failure }}
			</Message>
			<Message
				v-if="accounts.isError.value"
				variant="warning"
			>
				{{ t('accountSwitch.loadFailed') }}
				<BaseButton @click="accounts.refetch()">
					{{ t('accountSwitch.retry') }}
				</BaseButton>
			</Message>
			<p v-if="auth.isLoading">
				{{ t('accountSwitch.switching') }}
			</p>
			<p v-else-if="accounts.isPending.value">
				{{ t('accountSwitch.loading') }}
			</p>
			<ul
				v-else
				class="account-switcher__accounts"
			>
				<li
					v-for="account in accounts.data.value?.accounts ?? []"
					:key="account.session_id"
				>
					<BaseButton
						class="account-switcher__select"
						:aria-disabled="busy || account.session_id === auth.session?.sid"
						@click="perform(() => auth.switchAccount(account.session_id))"
					>
						<span
							class="account-switcher__avatar"
							aria-hidden="true"
						>{{ (account.name || account.username || '?').slice(0, 1) }}</span>
						<span class="account-switcher__identity">
							<strong>{{ account.name || account.username }}</strong>
							<span>{{ account.username }}</span>
						</span>
						<span
							v-if="account.session_id === auth.session?.sid"
							class="account-switcher__current"
						>{{ t('accountSwitch.current') }}</span>
					</BaseButton>
					<BaseButton
						class="account-switcher__remove"
						:aria-disabled="busy"
						:aria-label="t('accountSwitch.removeAccount', {name: account.name || account.username})"
						@click="pendingRemoval = account.session_id"
					>
						<Icon icon="times" />
					</BaseButton>
					<div
						v-if="pendingRemoval === account.session_id"
						class="account-switcher__confirmation"
					>
						<p>{{ t('accountSwitch.removeExplain', {name: account.name || account.username}) }}</p>
						<XButton
							:loading="busy"
							:danger="true"
							@click="perform(() => auth.removeRememberedAccount(account.session_id))"
						>
							{{ t('accountSwitch.confirmRemove') }}
						</XButton>
						<XButton
							variant="secondary"
							:aria-disabled="busy"
							@click="pendingRemoval = ''"
						>
							{{ t('misc.cancel') }}
						</XButton>
					</div>
				</li>
			</ul>
			<p
				v-if="!accounts.isPending.value && !accounts.isError.value && !accounts.data.value?.accounts?.length"
				class="account-switcher__help"
			>
				{{ t('accountSwitch.empty') }}
			</p>
			<template v-if="auth.authUser">
				<XButton
					v-if="!currentRemembered"
					:loading="busy"
					variant="secondary"
					@click="perform(() => auth.rememberAccount())"
				>
					{{ t('accountSwitch.rememberCurrent') }}
				</XButton>
				<XButton
					:aria-disabled="busy || atLimit"
					@click="perform(() => auth.addAccount())"
				>
					{{ t('accountSwitch.add') }}
				</XButton>
				<p
					v-if="atLimit"
					class="account-switcher__help"
				>
					{{ t('accountSwitch.limit', {n: accounts.data.value?.limit ?? 5}) }}
				</p>
			</template>
			<template v-if="accounts.data.value?.accounts?.length">
				<BaseButton
					v-if="!confirmAll"
					class="account-switcher__all"
					:aria-disabled="busy"
					@click="confirmAll = true"
				>
					{{ t('accountSwitch.logoutAll') }}
				</BaseButton>
				<div
					v-else
					class="account-switcher__confirmation"
				>
					<p>{{ t('accountSwitch.logoutAllExplain') }}</p>
					<XButton
						:loading="busy"
						:danger="true"
						@click="perform(() => auth.logoutAllAccounts())"
					>
						{{ t('accountSwitch.logoutAll') }}
					</XButton>
					<XButton
						variant="secondary"
						:aria-disabled="busy"
						@click="confirmAll = false"
					>
						{{ t('misc.cancel') }}
					</XButton>
				</div>
			</template>
			<p class="account-switcher__privacy">
				{{ t('accountSwitch.privacy') }}
			</p>
		</div>
	</component>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import Modal from '@/components/misc/Modal.vue'
import Message from '@/components/misc/Message.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import {deviceAccountsQuery} from '@/client/queries/accountSessions'
import {useAuthStore} from '@/stores/auth'

const props = withDefaults(defineProps<{inline?: boolean}>(), {inline: false})
const {t} = useI18n({useScope: 'global'})
const auth = useAuthStore()
const open = ref(false)
const actionBusy = ref(false)
const busy = computed(() => actionBusy.value || auth.isLoading)
const failure = ref('')
const pendingRemoval = ref('')
const confirmAll = ref(false)
const accounts = useQuery(computed(() => ({
	...deviceAccountsQuery(),
	enabled: props.inline || open.value,
	meta: {handlesError: true},
})))
const currentRemembered = computed(() => accounts.data.value?.accounts?.some(a => a.session_id === auth.session?.sid))
const atLimit = computed(() => (accounts.data.value?.accounts?.length ?? 0) + (currentRemembered.value ? 0 : 1) >= (accounts.data.value?.limit ?? 5))

async function perform(action: () => Promise<unknown>) {
	if (busy.value) return
	actionBusy.value = true
	failure.value = ''
	try {
		await action()
		pendingRemoval.value = ''
		confirmAll.value = false
		if (props.inline || open.value) await accounts.refetch()
	} catch {
		failure.value = t('accountSwitch.actionFailed')
	} finally {
		actionBusy.value = false
	}
}

function request() {
	failure.value = ''
	pendingRemoval.value = ''
	confirmAll.value = false
	open.value = true
}
defineExpose({request})
</script>

<style lang="scss" scoped>
.account-switcher__body {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;
	padding: var(--space-3);

	h2 {
		margin: 0;
		font-size: var(--text-xl);
	}
}

.account-switcher__help,
.account-switcher__privacy {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.account-switcher__privacy {
	margin-block-start: var(--space-2);
}
.account-switcher__accounts {
	margin: 0;
	padding: 0;
	list-style: none;
}
.account-switcher__accounts li {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	align-items: center;
	border-block-end: 1px solid var(--border-subtle);
}
.account-switcher__select {
	display: flex;
	gap: var(--space-3);
	align-items: center;
	min-inline-size: 0;
	min-block-size: 64px;
	padding: var(--space-2);
	text-align: start;
}
.account-switcher__avatar {
	display: grid;
	place-items: center;
	flex: 0 0 40px;
	block-size: 40px;
	border-radius: 50%;
	background: var(--primary-a10, var(--grey-200));
	color: var(--primary);
	font-size: var(--text-lg);
}
.account-switcher__identity {
	display: grid;
	min-inline-size: 0;
	overflow-wrap: anywhere;
}
.account-switcher__identity > span {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
.account-switcher__current {
	margin-inline-start: auto;
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
.account-switcher__remove {
	display: grid;
	place-items: center;
	min-inline-size: 44px;
	min-block-size: 44px;
}
.account-switcher__confirmation {
	grid-column: 1 / -1;
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	padding: var(--space-3);
	border-radius: var(--radius-md);
	background: var(--grey-100);
}
.account-switcher__confirmation > p {
	flex-basis: 100%;
}
.account-switcher__all {
	min-block-size: 44px;
	color: var(--danger);
	text-align: start;
}
</style>
