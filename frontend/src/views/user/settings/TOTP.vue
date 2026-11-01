<template>
	<div
		v-if="configStore.totp_enabled && isLocalUser"
		class="settings-page"
	>
		<PageHeader
			:title="$t('user.settings.totp.title')"
			:description="$t('user.settings.totp.description')"
		/>
		<Card :loading="status.isPending.value">
			<LoadError
				v-if="status.isError.value && !status.data.value"
				:message="$t('user.settings.totp.loadError')"
				:retry="() => status.refetch()"
			/>
			<template v-else-if="status.isSuccess.value && !totp.enabled && !totp.secret">
				<FormField
					id="totpEnrollPassword"
					v-model="totpPassword"
					:label="$t('user.settings.totp.enterPassword')"
					:placeholder="$t('user.settings.currentPasswordPlaceholder')"
					autocomplete="current-password"
					type="password"
					@keyup.enter="totpEnroll"
				/>
				<XButton
					:loading="enrollMutation.isPending.value"
					@click="totpEnroll"
				>
					{{ $t('user.settings.totp.enroll') }}
				</XButton>
			</template>
			<template v-else-if="isEnrolling">
				<ol class="totp-steps">
					<li>
						<p>
							{{ $t('user.settings.totp.finishSetupPart1') }}
							<strong class="totp-secret">{{ totp.secret }}</strong>
						</p>
						<p>
							{{ $t('user.settings.totp.scanQR') }}
						</p>
						<img
							class="totp-qr"
							:src="totpQR"
							:alt="$t('user.settings.totp.qrAlt')"
						>
					</li>
					<li>
						<p>{{ $t('user.settings.totp.finishSetupPart2') }}</p>
						<Message
							variant="warning"
							class="mbs-2"
						>
							{{ $t('user.settings.totp.confirmNotice') }}
						</Message>
					</li>
				</ol>
				<FormField
					id="totpConfirmPassword"
					v-model="totpPassword"
					:label="$t('user.settings.totp.enterPassword')"
					:placeholder="$t('user.settings.currentPasswordPlaceholder')"
					autocomplete="current-password"
					type="password"
					@keyup.enter="totpConfirm"
				/>
				<FormField
					id="totpConfirmPasscode"
					v-model="totpConfirmPasscode"
					:label="$t('user.settings.totp.passcode')"
					autocomplete="one-time-code"
					:placeholder="$t('user.settings.totp.passcodePlaceholder')"
					type="text"
					inputmode="numeric"
					@keyup.enter="totpConfirm"
				/>
				<XButton
					:loading="enableMutation.isPending.value"
					@click="totpConfirm"
				>
					{{ $t('misc.confirm') }}
				</XButton>
			</template>
			<template v-else-if="totp.enabled">
				<p class="totp-enabled">
					<Icon
						icon="check"
						class="totp-enabled__icon"
						aria-hidden="true"
					/>
					{{ $t('user.settings.totp.setupSuccess') }}
				</p>
				<p
					v-if="!totpDisableForm"
					class="mbs-4"
				>
					<XButton
						danger
						variant="secondary"
						@click="totpDisableForm = true"
					>
						{{ $t('misc.disable') }}
					</XButton>
				</p>
				<div
					v-if="totpDisableForm"
					class="totp-disable"
				>
					<FormField
						id="currentPassword"
						v-model="totpDisablePassword"
						v-focus
						:label="$t('user.settings.totp.enterPassword')"
						:placeholder="$t('user.settings.currentPasswordPlaceholder')"
						type="password"
						@keyup.enter="totpDisable"
					/>
					<FormField
						id="totpDisablePasscode"
						v-model="totpDisablePasscode"
						:label="$t('user.settings.totp.passcode')"
						autocomplete="one-time-code"
						:placeholder="$t('user.settings.totp.passcodePlaceholder')"
						type="text"
						inputmode="numeric"
						@keyup.enter="totpDisable"
					/>
					<div class="totp-disable__actions">
						<XButton
							danger
							:loading="disableMutation.isPending.value"
							@click="totpDisable"
						>
							{{ $t('user.settings.totp.disable') }}
						</XButton>
						<XButton
							variant="tertiary"
							@click="closeDisableForm()"
						>
							{{ $t('misc.cancel') }}
						</XButton>
					</div>
				</div>
			</template>
		</Card>
	</div>
</template>


<script lang="ts" setup>
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'

import {useQuery} from '@tanstack/vue-query'
import {useObjectUrl} from '@vueuse/core'
import {
	totpQuery,
	totpQrQuery,
	useEnrollTotpMutation,
	useEnableTotpMutation,
	useDisableTotpMutation,
} from '@/client/queries/totp'
import FormField from '@/components/input/FormField.vue'
import Message from '@/components/misc/Message.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'

import {useTitle} from '@/composables/useTitle'
import {useConfigStore} from '@/stores/config'
import {useAuthStore} from '@/stores/auth'

defineOptions({name: 'UserSettingsTotp'})

const {t} = useI18n({useScope: 'global'})
useTitle(() => `${t('user.settings.totp.title')} - ${t('user.settings.title')}`)

const totpConfirmPasscode = ref('')
const totpPassword = ref('')
const totpDisableForm = ref(false)
const totpDisablePassword = ref('')
const totpDisablePasscode = ref('')

const configStore = useConfigStore()
const authStore = useAuthStore()
const isLocalUser = computed(() => authStore.info?.is_local_user)

// The page shows its own load error instead of a blank card: whether 2FA is on must never look unknown-but-fine.
const status = useQuery(computed(() => ({
	...totpQuery(),
	enabled: Boolean(configStore.totp_enabled && isLocalUser.value),
	meta: {handlesError: true},
})))
const totp = computed(() => status.data.value ?? {})
const isEnrolling = computed(() => Boolean(totp.value.secret) && !totp.value.enabled)
const qr = useQuery(computed(() => ({...totpQrQuery(), enabled: isEnrolling.value})))
const totpQR = useObjectUrl(computed(() => isEnrolling.value ? qr.data.value : undefined))
const enrollMutation = useEnrollTotpMutation()
const enableMutation = useEnableTotpMutation()
const disableMutation = useDisableTotpMutation()

function totpEnroll() {
	if (enrollMutation.isPending.value) return
	enrollMutation.mutate(totpPassword.value)
}

async function totpConfirm() {
	if (enableMutation.isPending.value) return
	try {
		await enableMutation.mutateAsync({
			passcode: totpConfirmPasscode.value,
			password: totpPassword.value,
		})
		totpPassword.value = ''
		await authStore.logout()
	} catch { return }
}

function closeDisableForm() {
	totpDisableForm.value = false
	totpDisablePassword.value = ''
	totpDisablePasscode.value = ''
}

async function totpDisable() {
	if (disableMutation.isPending.value) return
	try {
		await disableMutation.mutateAsync({
			password: totpDisablePassword.value,
			totp_passcode: totpDisablePasscode.value,
		})
	} catch {
		return
	}
	closeDisableForm()
}
</script>

<style lang="scss" scoped>
.totp-steps {
	display: grid;
	gap: var(--space-4);
	margin: 0 0 var(--space-4);
	padding-inline-start: var(--space-5);
}

.totp-secret {
	display: block;
	margin-block-start: var(--space-1);
	font-family: var(--font-mono);
	font-size: var(--text-md);
	overflow-wrap: anywhere;
}

.totp-qr {
	display: block;
	inline-size: 10rem;
	max-inline-size: 100%;
	margin-block-start: var(--space-2);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-sm);
	background: #ffffff;
}

.totp-enabled {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.totp-enabled__icon {
	color: var(--success);
}

.totp-disable__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}
</style>
