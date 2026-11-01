<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {mailSettingsAccessQuery, mailSettingsQuery, useSaveMailSettings} from '@/client/queries/mailSettings'
import type {MailSettings, MailSettingsWritable} from '@/client/generated'
import {useTitle} from '@/composables/useTitle'
import {isRequestContextAbort} from '@/client/requestContext'
import Message from '@/components/misc/Message.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import SettingsScope from './SettingsScope.vue'
import UnsavedLeaveDialog from '@/components/misc/UnsavedLeaveDialog.vue'
import {useUnsavedLeaveGuard} from '@/composables/useUnsavedLeaveGuard'
const {t} = useI18n({useScope: 'global'})
useTitle(() => `${t('mailServer.title')} - ${t('user.settings.title')}`)
const access = useQuery(mailSettingsAccessQuery())
const allowed = computed(() => access.data.value?.can_manage_mail === true)
const settings = useQuery({...mailSettingsQuery(), enabled: allowed})
const draft = ref<MailSettings & MailSettingsWritable>()
const baseline = ref('')
const dirty = computed(() => draft.value !== undefined && JSON.stringify(draft.value) !== baseline.value)
// Switching settings pages or closing the tab asks before unsaved changes are dropped.
const {leaveTarget, stay, discardAndLeave} = useUnsavedLeaveGuard(dirty)
const errorMessage = ref('')
function adopt(value: MailSettings) {
	draft.value = {...value, password: '', clear_password: false}
	baseline.value = JSON.stringify(draft.value)
}
watch(settings.data, value => { if (value && !dirty.value) adopt(value) }, {immediate: true})
const save = useSaveMailSettings()
async function submit() {
	if (!draft.value || save.isPending.value || !dirty.value) return
	errorMessage.value = ''
	const submitted = JSON.stringify(draft.value)
	try {
		const result = await save.mutateAsync({...draft.value})
		if (JSON.stringify(draft.value) === submitted) adopt(result)
		else { baseline.value = JSON.stringify({...result, password: '', clear_password: false}); draft.value.revision = result.revision }
	} catch (error) {
		if (!isRequestContextAbort(error)) errorMessage.value = error instanceof Error ? error.message : t('settingsDraft.failed')
	}
}
</script>

<template>
	<div class="settings-page">
		<PageHeader :title="t('mailServer.title')">
			<template #description>
				{{ t('mailServer.intro') }}
				<SettingsScope scope="site">
					{{ t('user.settings.scope.siteMail') }}
				</SettingsScope>
			</template>
		</PageHeader>
		<Card>
			<p
				v-if="access.isPending.value || (allowed && settings.isPending.value)"
				class="mail-status"
				role="status"
			>
				{{ t('mailServer.loading') }}
			</p>
			<Message
				v-else-if="access.isError.value || (allowed && settings.isError.value)"
				variant="danger"
			>
				{{ t('mailServer.loadFailed') }}
			</Message>
			<Message
				v-else-if="!allowed"
				variant="danger"
			>
				{{ t('mailServer.forbidden') }}
			</Message>
			<form
				v-else-if="draft"
				class="mail-settings"
				@submit.prevent="submit"
			>
				<p class="mail-recipient">
					{{ t('mailServer.recipient') }} <RouterLink :to="{name: 'user.settings.email-update'}">
						{{ t('mailServer.emailLink') }}
					</RouterLink>
				</p>
				<Message>
					{{ t(draft.source === 'saved' ? 'mailServer.sourceSaved' : 'mailServer.sourceEnvironment') }}
					{{ t('mailServer.revision') }}: {{ draft.revision }}
				</Message>
				<label class="check-row">
					<input
						v-model="draft.enabled"
						type="checkbox"
					>
					<span>{{ t('mailServer.enabled') }}</span>
				</label>
				<div class="mail-fields">
					<label class="settings-field">
						<span class="settings-field__label">{{ t('mailServer.host') }}</span>
						<input
							v-model="draft.host"
							class="input"
							:required="draft.enabled"
							autocomplete="off"
							placeholder="smtp.example.com"
							maxlength="253"
						>
					</label>
					<label class="settings-field">
						<span class="settings-field__label">{{ t('mailServer.port') }}</span>
						<input
							v-model.number="draft.port"
							class="input"
							type="number"
							required
							min="1"
							max="65535"
						>
					</label>
					<label class="settings-field">
						<span class="settings-field__label">{{ t('mailServer.username') }}</span>
						<input
							v-model="draft.username"
							class="input"
							autocomplete="off"
							maxlength="320"
						>
					</label>
					<label class="settings-field">
						<span class="settings-field__label">{{ t('mailServer.password') }}</span>
						<input
							v-model="draft.password"
							class="input"
							type="password"
							autocomplete="new-password"
							aria-describedby="mail-password-help"
							:disabled="draft.clear_password"
							:placeholder="t(draft.has_password ? 'mailServer.savedPassword' : 'mailServer.emptyPassword')"
							maxlength="4096"
						>
					</label>
					<label class="settings-field">
						<span class="settings-field__label">{{ t('mailServer.from') }}</span>
						<input
							v-model="draft.from_email"
							class="input"
							:required="draft.enabled"
							maxlength="320"
							placeholder="no-reply@example.com"
						>
					</label>
					<label class="settings-field">
						<span class="settings-field__label">{{ t('mailServer.auth') }}</span>
						<span class="select is-fullwidth">
							<select v-model="draft.auth_type">
								<option value="plain">PLAIN</option>
								<option value="login">LOGIN</option>
								<option value="cram-md5">CRAM-MD5</option>
								<option value="none">{{ t('mailServer.none') }}</option>
							</select>
						</span>
					</label>
					<label class="settings-field">
						<span class="settings-field__label">{{ t('mailServer.tls') }}</span>
						<span class="select is-fullwidth">
							<select
								v-model="draft.tls_mode"
								aria-describedby="mail-tls-help"
							>
								<option value="auto">{{ t('mailServer.auto') }}</option>
								<option value="starttls">{{ t('mailServer.starttls') }}</option>
								<option value="tls">{{ t('mailServer.implicit') }}</option>
							</select>
						</span>
					</label>
				</div>
				<p
					id="mail-password-help"
					class="settings-field__hint"
				>
					{{ t('mailServer.passwordHelp') }}
				</p>
				<label
					v-if="draft.has_password"
					class="check-row"
				>
					<input
						v-model="draft.clear_password"
						type="checkbox"
					>
					<span>{{ t('mailServer.clearPassword') }}</span>
				</label>
				<label class="check-row">
					<input
						v-model="draft.skip_tls_verify"
						type="checkbox"
						aria-describedby="mail-tls-help"
					>
					<span>{{ t('mailServer.skipVerify') }}</span>
				</label>
				<p
					id="mail-tls-help"
					class="settings-field__hint"
				>
					{{ t('mailServer.tlsHelp') }}
				</p>
				<div class="mail-actions">
					<XButton
						type="submit"
						icon="save"
						:loading="save.isPending.value"
						:aria-disabled="!dirty || save.isPending.value"
					>
						{{ t('mailServer.save') }}
					</XButton>
					<p
						class="mail-status"
						role="status"
					>
						{{ dirty ? t('settingsDraft.unsaved') : '' }}
					</p>
					<p class="settings-field__hint mail-actions__help">
						{{ t('mailServer.saveHelp') }}
					</p>
				</div>
				<Message
					v-if="errorMessage"
					variant="danger"
				>
					{{ t('settingsDraft.retained') }} {{ errorMessage }}
				</Message>
			</form>
		</Card>

		<UnsavedLeaveDialog
			:open="leaveTarget !== null"
			@stay="stay"
			@discard="discardAndLeave"
		/>
	</div>
</template>


<style scoped lang="scss">
.mail-settings {
	display: grid;
	gap: var(--space-4);
}

.mail-recipient {
	color: var(--text-secondary);
	font-size: var(--text-md);
}

.mail-fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-3) var(--space-4);

	@media screen and (max-width: $tablet) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.settings-field {
	display: grid;
	align-content: start;
	gap: var(--space-1);
	min-inline-size: 0;
}

.settings-field__label {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.settings-field__hint {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.check-row {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	cursor: pointer;

	input {
		flex-shrink: 0;
		inline-size: 1rem;
		block-size: 1rem;
		margin-block-start: .2rem;
		accent-color: var(--primary);
	}
}

.mail-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--border-subtle);
}

.mail-actions__help {
	flex-basis: 100%;
}

.mail-status {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
</style>
