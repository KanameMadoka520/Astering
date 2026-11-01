<template>
	<div class="settings-page">
		<PageHeader
			:title="$t('user.export.title')"
			:description="$t('user.export.description')"
		/>
		<Card>
			<Message
				v-if="exportInfo"
				variant="success"
				class="mbe-4"
			>
				<div class="export-message">
					<p>
						<i18n-t
							keypath="user.export.ready"
							scope="global"
						>
							<time
								v-tooltip="formatDateLong(exportInfo?.expires)"
								:datetime="formatISO(exportInfo?.expires)"
							>
								{{ formattedExpiresDate }}
							</time>
						</i18n-t>
					</p>
					<XButton
						icon="download"
						:to="{name:'user.export.download'}"
					>
						{{ $t('misc.download') }}
					</XButton>
				</div>
			</Message>
			<p class="settings-copy">
				{{ $t('user.export.notIncluded') }}
			</p>
			<form
				v-if="isLocalUser"
				@submit.prevent="requestDataExport()"
			>
				<p class="settings-copy">
					{{ $t('user.export.descriptionPasswordRequired') }}
				</p>
				<FormField
					id="currentPasswordDataExport"
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
			<template #footer>
				<XButton
					:loading="requestMutation.isPending.value"
					@click="requestDataExport()"
				>
					{{ $t('user.export.request') }}
				</XButton>
			</template>
		</Card>
	</div>
</template>

<script setup lang="ts">
import {ref, computed} from 'vue'
import {useI18n} from 'vue-i18n'

import {useQuery} from '@tanstack/vue-query'
import {dataExportQuery, useRequestExportMutation} from '@/client/queries/dataExport'
import {useTitle} from '@/composables/useTitle'
import {useAuthStore} from '@/stores/auth'
import {formatISO, formatDateLong, formatDisplayDate} from '@/helpers/time/formatDate'

import Message from '@/components/misc/Message.vue'
import FormField from '@/components/input/FormField.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'

defineOptions({name: 'UserSettingsDataExport'})

const {t} = useI18n({useScope: 'global'})
const authStore = useAuthStore()

useTitle(() => `${t('user.export.title')} - ${t('user.settings.title')}`)

const status = useQuery(dataExportQuery())
const exportInfo = computed(() => status.data.value?.id ? status.data.value : null)
const requestMutation = useRequestExportMutation()
const password = ref('')
const errPasswordRequired = ref(false)
const isLocalUser = computed(() => authStore.info?.is_local_user)
const passwordInput = ref()

const formattedExpiresDate = computed(() => formatDisplayDate(exportInfo.value?.expires))

async function requestDataExport() {
	if (requestMutation.isPending.value) return
	if (password.value === '' && isLocalUser.value) {
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
</script>

<style lang="scss" scoped>
.settings-copy {
	margin-block-end: var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-md);
}

.export-message {
	display: flex;
	justify-content: space-between;
	align-items: center;
	inline-size: 100%;
	gap: .5rem;
	
	> p {
		margin-block-end: 0;
	}
	
	@media (max-width: $tablet) {
		flex-direction: column;
		align-items: flex-start;
		
		> p {
			margin-block-end: 1rem;
		}
		
		> :deep(.button) {
			inline-size: 100%;
		}
	}
}
</style>
