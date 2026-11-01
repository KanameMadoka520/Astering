<template>
	<div class="settings-page">
		<PageHeader
			:title="$t('user.settings.avatar.title')"
			:description="$t('user.settings.avatar.description')"
		/>
		<!-- The saved source is unknown until it loads: no "Default" guess, and no picker for accounts that cannot change it. -->
		<Card :loading="providerQuery.isPending.value">
			<LoadError
				v-if="providerQuery.isError.value && !providerQuery.data.value"
				:message="$t('user.settings.avatar.loadError')"
				:retry="() => providerQuery.refetch()"
			/>
			<template v-else-if="!providerQuery.data.value" />
			<Message v-else-if="avatarProvider === 'ldap'">
				{{ $t('user.settings.avatar.ldap') }}
			</Message>
			<Message v-else-if="avatarProvider === 'openid'">
				{{ $t('user.settings.avatar.openid', {provider: authStore.info?.auth_provider}) }}
			</Message>
			<template v-else>
				<fieldset class="avatar-providers">
					<legend class="avatar-providers__legend">
						{{ $t('user.settings.avatar.provider') }}
					</legend>
					<label
						v-for="(label, providerId) in AVATAR_PROVIDERS"
						:key="providerId"
						class="radio"
						:class="{'is-selected': avatarProvider === providerId}"
					>
						<input
							v-model="avatarProvider"
							name="avatarProvider"
							type="radio"
							:value="providerId"
						>
						{{ label }}
					</label>
				</fieldset>
				<template v-if="avatarProvider === 'upload'">
					<label class="image-choice mbe-4"><input
						v-model="cropBeforeUpload"
						type="checkbox"
					> {{ $t('flow.cropAvatar') }}</label>
					<input
						ref="avatarUploadInput"
						accept="image/*"
						class="is-hidden"
						type="file"
						@change="cropAvatar"
					>
					<XButton
						v-if="!isCropAvatar"
						icon="arrow-up-from-bracket"
						:loading="saving || loading"
						@click="avatarUploadInput.click()"
					>
						{{ $t('user.settings.avatar.uploadAvatar') }}
					</XButton>
					<template v-else>
						<Cropper
							ref="cropper"
							:src="avatarToCrop"
							:stencil-props="{aspectRatio: 1}"
							class="mbe-4 cropper"
							@ready="() => loading = false"
						/>
						<XButton
							v-cy="'uploadAvatar'"
							:loading="saving || loading"
							@click="uploadAvatar"
						>
							{{ $t('user.settings.avatar.uploadAvatar') }}
						</XButton>
					</template>
				</template>
			</template>
			<template
				v-if="providerQuery.data.value && !['ldap', 'openid', 'upload'].includes(avatarProvider)"
				#footer
			>
				<XButton
					:loading="saving || loading"
					@click="updateAvatarStatus()"
				>
					{{ $t('misc.save') }}
				</XButton>
			</template>
		</Card>
	</div>
</template>


<script setup lang="ts">
import {computed, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {Cropper} from 'vue-advanced-cropper'
import 'vue-advanced-cropper/dist/style.css'

import {useQuery} from '@tanstack/vue-query'
import {avatarProviderQuery, useUpdateAvatarProviderMutation, useUploadAvatarMutation} from '@/client/queries/avatars'
import {useTitle} from '@/composables/useTitle'
import {useAuthStore} from '@/stores/auth'
import Message from '@/components/misc/Message.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import LoadError from '@/components/misc/state/LoadError.vue'

defineOptions({name: 'UserSettingsAvatar'})

const {t} = useI18n({useScope: 'global'})
const authStore = useAuthStore()

const AVATAR_PROVIDERS = computed(() => ({
	default: t('misc.default'),
	initials: t('user.settings.avatar.initials'),
	gravatar: t('user.settings.avatar.gravatar'),
	marble: t('user.settings.avatar.marble'),
	upload: t('user.settings.avatar.upload'),
}))

useTitle(() => `${t('user.settings.avatar.title')} - ${t('user.settings.title')}`)

// Shown inline with a retry, so no toast as well.
const providerQuery = useQuery({...avatarProviderQuery(), meta: {handlesError: true}})
const updateProvider = useUpdateAvatarProviderMutation()
const upload = useUploadAvatarMutation()
const saving = computed(() => updateProvider.isPending.value || upload.isPending.value)
const loading = ref(false)
const pickedProvider = ref<string>()
const avatarProvider = computed({
	get: () => pickedProvider.value ?? providerQuery.data.value?.avatar_provider ?? 'default',
	set: (provider: string) => pickedProvider.value = provider,
})

function updateAvatarStatus() {
	const username = authStore.info?.username
	if (!username || (pickedProvider.value === undefined && providerQuery.data.value === undefined)) return
	updateProvider.mutate({username, provider: avatarProvider.value})
}

const cropper = ref()
const isCropAvatar = ref(false)
const cropBeforeUpload = ref(false)

async function uploadAvatar() {
	const username = authStore.info?.username
	if (!username) return
	loading.value = true
	const {canvas} = cropper.value.getResult()

	if (!canvas) {
		loading.value = false
		return
	}

	try {
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve))
		if (blob) await upload.mutateAsync({username, blob}).catch(() => undefined)
	} finally {
		loading.value = false
		isCropAvatar.value = false
	}
}

const avatarToCrop = ref()
const avatarUploadInput = ref()

async function cropAvatar() {
	const input: HTMLInputElement = avatarUploadInput.value
	const avatar = input.files?.[0]
	// Clear the picker right away: choosing the same file again after a crop or a cancelled
	// format prompt must still fire change. Browsers empty the live FileList, so keep the File.
	input.value = ''

	if (!avatar) {
		return
	}

	if (!cropBeforeUpload.value) {
		const username = authStore.info?.username
		if (username) await upload.mutateAsync({username, blob: avatar}).catch(() => undefined)
		return
	}
	loading.value = true
	const reader = new FileReader()
	reader.onload = () => {
		avatarToCrop.value = reader.result
		isCropAvatar.value = true
		// Note: loading stays true until Cropper's @ready event fires
		// This ensures the canvas is ready before allowing upload
	}
	reader.onerror = () => loading.value = false
	reader.readAsDataURL(avatar)
}
</script>

<style lang="scss">
.cropper {
	block-size: min(65dvh, 32rem);
	background: transparent;
}

.vue-advanced-cropper__background {
	background: var(--white);
}
</style>

<style lang="scss" scoped>
.avatar-providers {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin: 0 0 var(--space-4);
	padding: 0;
	border: 0;
	min-inline-size: 0;
}

.avatar-providers__legend {
	inline-size: 100%;
	margin-block-end: var(--space-1);
	padding: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

// Ported from bulma-css-variables/sass/form/checkbox-radio.sass (the %checkbox-radio
// placeholder), scoped to this component so we can drop the global Bulma import.
label.radio {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--control-height);
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	background: var(--surface);
	line-height: 1.25;
	cursor: pointer;
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		border-color var(--motion-fast) var(--ease-standard);

	input {
		cursor: pointer;
		accent-color: var(--primary);
	}

	&:hover {
		border-color: var(--border-strong);
	}

	&.is-selected {
		border-color: hsla(var(--primary-hsl), .5);
		background: var(--surface-selected);
		color: var(--accent-text);
		font-weight: var(--weight-semibold);
	}

	&:has(input:focus-visible) {
		@include focus-ring;
	}

	&[disabled],
	input[disabled] {
		color: var(--input-disabled-color);
		cursor: not-allowed;
	}
}

.image-choice {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}
</style>
