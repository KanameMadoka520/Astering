<template>
	<div
		v-if="configStore.user_deletion_enabled"
		class="settings-page"
	>
		<PageHeader
			:title="$t('user.deletion.title')"
			:description="$t('user.deletion.text1')"
		/>
		<Card class="deletion-card">
			<p class="settings-copy">
				{{ $t('user.deletion.scope') }}
			</p>
			<p class="settings-copy">
				{{ $t('user.deletion.privateData') }}
			</p>
			<p class="settings-copy">
				{{ $t('user.deletion.sharedFiles') }}
			</p>
			<p class="settings-copy">
				{{ $t('user.deletion.keepFirst') }}
			</p>
			<template v-if="deletionScheduledAt !== null">
				<form @submit.prevent="cancelDeletion()">
					<Message
						variant="warning"
						class="mbe-4"
					>
						{{
							$t('user.deletion.scheduled', {
								date: formatDateLong(deletionScheduledAt),
								dateSince: formatDateSince(deletionScheduledAt),
							})
						}}
					</Message>
					<template v-if="isLocalUser">
						<p class="settings-copy">
							{{ $t('user.deletion.scheduledCancelText') }}
						</p>
						<FormField
							id="currentPasswordAccountDelete"
							ref="passwordInput"
							v-model="password"
							:label="$t('user.settings.currentPassword')"
							:placeholder="$t('user.settings.currentPasswordPlaceholder')"
							type="password"
							:error="errPasswordRequired ? $t('user.deletion.passwordRequired') : null"
							@keyup="() => errPasswordRequired = password === ''"
						/>
					</template>
					<p
						v-else
						class="settings-copy"
					>
						{{ $t('user.deletion.scheduledCancelButton') }}
					</p>
				</form>
			</template>
			<template v-else>
				<form
					v-if="isLocalUser"
					@submit.prevent="deleteAccount()"
				>
					<p class="settings-copy">
						{{ $t('user.deletion.text2') }}
					</p>
					<FormField
						id="currentPasswordAccountDelete"
						ref="passwordInput"
						v-model="password"
						:label="$t('user.settings.currentPassword')"
						:class="{'is-danger': errPasswordRequired}"
						:placeholder="$t('user.settings.currentPasswordPlaceholder')"
						type="password"
						:error="errPasswordRequired ? $t('user.deletion.passwordRequired') : null"
						@keyup="() => errPasswordRequired = password === ''"
					/>
				</form>
				<p
					v-else
					class="settings-copy"
				>
					{{ $t('user.deletion.text3') }}
				</p>
			</template>
			<template #footer>
				<XButton
					v-if="deletionScheduledAt !== null"
					:loading="loading"
					@click="cancelDeletion()"
				>
					{{ $t('user.deletion.scheduledCancelConfirm') }}
				</XButton>
				<XButton
					v-else
					:loading="loading"
					class="is-danger"
					@click="deleteAccount()"
				>
					{{ $t('user.deletion.confirm') }}
				</XButton>
			</template>
		</Card>
	</div>
</template>

<script setup lang="ts">
import {ref, computed} from 'vue'
import {useI18n} from 'vue-i18n'

import {useRequestDeletionMutation, useCancelDeletionMutation} from '@/client/queries/accountDeletion'
import {parseDateOrNull} from '@/helpers/parseDateOrNull'
import {formatDateLong, formatDateSince} from '@/helpers/time/formatDate'
import {useTitle} from '@/composables/useTitle'
import {useAuthStore} from '@/stores/auth'
import {useConfigStore} from '@/stores/config'
import {AUTH_TYPES} from '@/constants/auth'
import FormField from '@/components/input/FormField.vue'
import Message from '@/components/misc/Message.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'

defineOptions({name: 'UserSettingsDeletion'})

const {t} = useI18n({useScope: 'global'})
useTitle(() => `${t('user.deletion.title')} - ${t('user.settings.title')}`)

const requestMutation = useRequestDeletionMutation()
const cancelMutation = useCancelDeletionMutation()
const loading = computed(() => requestMutation.isPending.value || cancelMutation.isPending.value)
const password = ref('')
const errPasswordRequired = ref(false)

const authStore = useAuthStore()
const configStore = useConfigStore()

const deletionScheduledAt = computed(() => parseDateOrNull(authStore.info?.deletion_scheduled_at))

const isLocalUser = computed(() => authStore.info?.is_local_user)

const passwordInput = ref()

async function deleteAccount() {
	if (loading.value) return
	if (isLocalUser.value && password.value === '') {
		errPasswordRequired.value = true
		passwordInput.value?.focus()
		return
	}

	try {
		await requestMutation.mutateAsync(password.value)
	} catch {
		return
	}
	password.value = ''
}

async function cancelDeletion() {
	if (loading.value) return
	if (isLocalUser.value && password.value === '') {
		errPasswordRequired.value = true
		passwordInput.value?.focus()
		return
	}

	try {
		await cancelMutation.mutateAsync({
			id: authStore.session?.id ?? 0,
			type: authStore.session?.type ?? AUTH_TYPES.USER,
			password: password.value,
		})
	} catch {
		return
	}
	password.value = ''
}
</script>

<style lang="scss" scoped>
.deletion-card {
	border-color: hsla(var(--danger-h), var(--danger-s), var(--danger-l), .35);
}

.settings-copy {
	margin-block-end: var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-md);
}
</style>
