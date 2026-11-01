<template>
	<div class="share-auth">
		<h1 class="share-auth-title">
			{{ $t('sharing.sharedProject') }}
		</h1>
		<Message
			v-if="loading && !authenticateWithPassword"
			role="status"
		>
			{{ $t('sharing.authenticating') }}
		</Message>
		<form
			v-if="authenticateWithPassword"
			class="share-auth-form"
			@submit.prevent="authenticate()"
		>
			<p class="share-auth-text">
				{{ $t('sharing.passwordRequired') }}
			</p>
			<FormField
				id="linkSharePassword"
				v-model="password"
				v-focus
				type="password"
				autocomplete="off"
				:label="$t('user.auth.password')"
				:placeholder="$t('user.auth.passwordPlaceholder')"
			/>
			<XButton
				type="submit"
				class="share-auth-submit"
				:loading="loading"
			>
				{{ $t('user.auth.login') }}
			</XButton>
		</form>
		<Message
			v-if="errorMessage !== ''"
			variant="danger"
		>
			{{ errorMessage }}
		</Message>
		<!-- Only for failures that may pass: an outage or a dropped connection. -->
		<XButton
			v-if="canRetry"
			variant="secondary"
			class="share-auth-retry"
			:loading="loading"
			@click="authenticate()"
		>
			{{ $t('sharing.retry') }}
		</XButton>
	</div>
</template>

<script lang="ts" setup>
import type {VikunjaErrorModel} from '@/client/generated'
import {ref, computed} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {useTitle} from '@vueuse/core'
import {useQueryClient} from '@tanstack/vue-query'

import Message from '@/components/misc/Message.vue'
import FormField from '@/components/input/FormField.vue'
import {LINK_SHARE_HASH_PREFIX} from '@/constants/linkShareHash'
import {taskQuery} from '@/client/queries/tasks'
import {getErrorText} from '@/message'

import {useBaseStore} from '@/stores/base'
import {useAuthStore} from '@/stores/auth'
import {useRedirectToLastVisited} from '@/composables/useRedirectToLastVisited'

// The share does not exist (any more): the link was deleted or mistyped.
const ERROR_SHARE_DOES_NOT_EXIST = 3006
const ERROR_PASSWORD_REQUIRED = 13001
const ERROR_PASSWORD_INVALID = 13002

const {t} = useI18n({useScope: 'global'})
const {getLastVisitedRoute} = useRedirectToLastVisited()

type LastVisited = NonNullable<ReturnType<typeof getLastVisitedRoute>>

function useAuth() {
	const baseStore = useBaseStore()
	const authStore = useAuthStore()
	const route = useRoute()
	const router = useRouter()
	const queryClient = useQueryClient()

	const loading = ref(false)
	const authenticateWithPassword = ref(false)
	const errorMessage = ref('')
	const canRetry = ref(false)
	const password = ref('')

	const authLinkShare = computed(() => authStore.authLinkShare)
	const shareHash = computed(() => String(route.params.share))

	// The link-share JWT carries the share's hash and project, though the session type doesn't declare them.
	function currentShare() {
		const claims = authStore.session as {hash?: unknown, project_id?: unknown} | null
		return typeof claims?.hash === 'string' && typeof claims.project_id === 'number'
			? {hash: claims.hash, projectId: claims.project_id}
			: null
	}

	// The saved route may come from an earlier visit to a different project, which this link can't open.
	async function belongsToProject(last: LastVisited, projectId: number) {
		const params = last.params as Record<string, unknown> | undefined
		if (params?.projectId !== undefined) return params.projectId === String(projectId)
		if (last.name !== 'task.detail') return false
		const taskId = Number(params?.id)
		if (!Number.isInteger(taskId) || taskId <= 0) return false
		try {
			const task = await queryClient.fetchQuery({...taskQuery(taskId), retry: false, meta: {handlesError: true}})
			return task.project_id === projectId
		} catch {
			return false
		}
	}

	async function redirectToProject(projectId: number) {
		const hash = LINK_SHARE_HASH_PREFIX + shareHash.value
		const viewId = typeof route.query.view === 'string' && route.query.view !== '' ? route.query.view : null

		// Reading the saved route also clears it, so a stale one is dropped here.
		const last = getLastVisitedRoute()
		if (last && await belongsToProject(last, projectId)) {
			return router.push({...last, hash})
		}

		if (viewId) {
			return router.push({
				name: 'project.view',
				params: {
					projectId,
					viewId,
				},
				hash,
			})
		}

		return router.push({
			name: 'project.index',
			params: {
				projectId,
			},
			hash,
		})
	}

	async function authenticate() {
		errorMessage.value = ''
		canRetry.value = false

		if (authLinkShare.value) {
			// Back from the shared project lands here again: this tab is already signed in to the link.
			const share = currentShare()
			if (share?.hash === shareHash.value) {
				return router.replace({
					name: 'project.index',
					params: {projectId: share.projectId},
					hash: LINK_SHARE_HASH_PREFIX + share.hash,
				})
			}
			// Another link: sign in to it instead.
		}

		loading.value = true

		try {
			const {project_id: projectId} = await authStore.linkShareAuth({
				hash: shareHash.value,
				password: password.value,
			})
			const logoVisible = route.query.logoVisible
				? route.query.logoVisible === 'true'
				: true
			baseStore.setLogoVisible(logoVisible)

			return await redirectToProject(projectId)
		} catch (cause) {
			const e = cause as VikunjaErrorModel
			if (e?.code === ERROR_PASSWORD_REQUIRED) {
				authenticateWithPassword.value = true
				return
			}

			if (e?.code === ERROR_PASSWORD_INVALID) {
				errorMessage.value = t('sharing.invalidPassword')
				authenticateWithPassword.value = true
				return
			}

			authenticateWithPassword.value = false

			if (e?.code === ERROR_SHARE_DOES_NOT_EXIST) {
				errorMessage.value = t('sharing.linkGone')
				return
			}

			// Handle generic 403 errors that might occur after initial auth
			if (e?.status === 403 && !e?.code) {
				errorMessage.value = t('sharing.accessDenied')
				return
			}

			// Outages and dropped connections may pass, so offer to try again.
			if ((e?.status ?? 0) >= 500 || !e?.status) {
				errorMessage.value = t('sharing.unreachable')
				canRetry.value = true
				return
			}

			// Log only status and code; authentication failures can include secrets.
			console.error('Link share authentication error:', e?.status, e?.code)
			errorMessage.value = getErrorText(e) || t('sharing.error')
		} finally {
			loading.value = false
		}
	}

	authenticate()

	return {
		loading,
		authenticateWithPassword,
		errorMessage,
		canRetry,
		password,
		authenticate,
	}
}

const {
	loading,
	authenticateWithPassword,
	errorMessage,
	canRetry,
	password,
	authenticate,
} = useAuth()

useTitle(computed(() => authenticateWithPassword.value || errorMessage.value !== ''
	? t('sharing.sharedProject')
	: t('sharing.authenticating')))
</script>

<style lang="scss" scoped>
.share-auth {
	display: grid;
	gap: var(--space-4);
	text-align: start;
}

.share-auth-title {
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-xl);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.share-auth-form {
	display: grid;
	gap: var(--space-3);
	padding: var(--space-5);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);

	:deep(.field) {
		margin-block-end: 0;
	}
}

.share-auth-text {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-md);
}

.share-auth-submit {
	justify-self: stretch;
}

.share-auth-retry {
	justify-self: start;
}
</style>
