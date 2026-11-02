<script setup lang="ts">
import {computed, nextTick, ref, shallowRef, watch, useId, type Component} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {useBaseStore} from '@/stores/base'
import {useAuthStore} from '@/stores/auth'
import {useIsMobile} from '@/composables/useIsMobile'
import {captureClientRequestContext} from '@/client/requestContext'
import {useTopModalDialog} from '@/composables/useTopModalDialog'
import AronaAvatar from './AronaAvatar.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
const {t} = useI18n({useScope: 'global'})
// Loaded on first open. A slow or failed download shows in the panel, which keeps its minimize button, instead of an
// empty box.
const assistant = shallowRef<Component>()
const assistantFailed = ref(false)
let assistantLoading: Promise<void> | undefined
function loadAssistant() {
	if (assistant.value) return
	assistantFailed.value = false
	assistantLoading ??= import('@/views/TcyAssistant.vue')
		.then(module => { assistant.value = module.default })
		.catch(() => { assistantFailed.value = true })
		.finally(() => { assistantLoading = undefined })
}
const route = useRoute()
const router = useRouter()
const base = useBaseStore()
const auth = useAuthStore()
const open = ref(false)
const loaded = ref(false)
const running = ref(false)
const waiting = ref(false)
const navigationBusy = ref(false)
const conversation = ref('')
const launcher = ref<InstanceType<typeof BaseButton>>()
const panel = ref<HTMLElement>()
const activityId = useId()
// Arona joins an open task detail, which is modal, so it stays usable next to the task; other dialogs cover it.
const {taskDetailDialog} = useTopModalDialog()
const portal = computed<string | HTMLElement>(() => taskDetailDialog.value ?? 'body')
const fullPage = computed(() => route.name === 'tcy-ai')
// The phone drawer is modal; the dock steps aside (state and streaming stay mounted).
const isMobile = useIsMobile()
const underDrawer = computed(() => isMobile.value && base.menuActive)
const taskID = computed(() => route.name === 'task.detail' ? Number(route.params.id) || 0 : 0)
const accountKey = computed(() => {
	// Depend on the reactive account too: token renewals must not reset a conversation.
	const context = captureClientRequestContext()
	return JSON.stringify([context.apiBaseUrl, auth.info?.id, context.identity?.type])
})
watch(accountKey, key => {
	open.value = false; loaded.value = false; running.value = false; waiting.value = false
	try { conversation.value = sessionStorage.getItem(`arona-floating:${key}`) || '' } catch { conversation.value = '' }
}, {immediate: true})
watch(conversation, id => {try { sessionStorage.setItem(`arona-floating:${accountKey.value}`, id) } catch { /* Browser storage is optional. */ }})
// Follows the full page, including a new chat there (no id): a chat deleted on that page must not reopen here.
watch(() => route.query.chat, id => {if (fullPage.value) conversation.value = typeof id === 'string' ? id : ''}, {immediate: true})
async function toggle() {
	open.value = !open.value
	if (!open.value) return
	loaded.value = true
	loadAssistant()
	await nextTick()
	panel.value?.focus()
}
function minimize() { open.value = false; nextTick(() => launcher.value?.$el?.focus()) }
// Work beats waiting: a paused turn the user is already answering shows as running.
const status = computed(() => running.value ? 'working' : waiting.value ? 'waiting' : '')
const launcherTitle = computed(() => [
	t(open.value ? 'floatingArona.minimize' : 'floatingArona.open'),
	...status.value ? [t(`floatingArona.${status.value}`)] : [],
].join(' · '))
function expand() { open.value = false; void router.push({name: 'tcy-ai', query: {chat: conversation.value || undefined, project: base.currentProjectId || undefined}}) }
</script>

<template>
	<Teleport :to="portal">
		<div
			v-if="!fullPage"
			class="floating-arona d-print-none"
			:class="{'is-under-drawer': underDrawer}"
			@mousedown.stop
			@pointerdown.stop
			@click.stop
		>
			<section
				v-if="loaded"
				v-show="open"
				ref="panel"
				class="arona-panel"
				role="region"
				tabindex="-1"
				:aria-label="t('floatingArona.title')"
				@keydown.esc.prevent.stop="minimize"
			>
				<div class="panel-body">
					<component
						:is="assistant"
						v-if="assistant"
						:key="accountKey"
						v-model:conversation-id="conversation"
						embedded
						:presenting="open && !underDrawer"
						:context-project-id="base.currentProjectId || 0"
						:context-task-id="taskID"
						@activity="running = $event"
						@attention="waiting = $event"
						@navigationBusy="navigationBusy = $event"
					>
						<template #panel-actions>
							<BaseButton
								class="panel-button"
								:aria-label="t('floatingArona.expand')"
								:title="t('floatingArona.expand')"
								:disabled="navigationBusy"
								@click="expand"
							>
								<Icon icon="arrow-up-right-from-square" />
							</BaseButton>
							<BaseButton
								class="panel-button"
								:aria-label="t('floatingArona.minimize')"
								:title="t('floatingArona.minimize')"
								@click="minimize"
							>
								<Icon icon="minus" />
							</BaseButton>
						</template>
					</component>
					<div
						v-else
						class="panel-state"
					>
						<div class="panel-state__header">
							<strong>{{ t('floatingArona.title') }}</strong>
							<BaseButton
								class="panel-button"
								:aria-label="t('floatingArona.minimize')"
								:title="t('floatingArona.minimize')"
								@click="minimize"
							>
								<Icon icon="minus" />
							</BaseButton>
						</div>
						<LoadError
							v-if="assistantFailed"
							:message="t('floatingArona.loadFailed')"
							:retry="loadAssistant"
						/>
						<p
							v-else
							class="panel-state__loading"
							role="status"
						>
							{{ t('floatingArona.loading') }}
						</p>
					</div>
				</div>
			</section>
			<BaseButton
				ref="launcher"
				class="arona-launcher"
				:class="{working: running}"
				:aria-label="t(open ? 'floatingArona.minimize' : 'floatingArona.open')"
				:aria-expanded="open"
				:aria-describedby="status ? activityId : undefined"
				:title="launcherTitle"
				@click="toggle"
			>
				<AronaAvatar />
				<span
					v-if="status === 'working'"
					class="activity-dot"
					aria-hidden="true"
				/>
				<!-- Shape and color both set it apart from the working dot. -->
				<span
					v-else-if="status === 'waiting'"
					class="attention-badge"
					aria-hidden="true"
				><Icon icon="exclamation" /></span>
			</BaseButton>
			<!-- The launcher keeps its name; working or waiting is its description. -->
			<span
				:id="activityId"
				class="is-sr-only"
			>{{ status ? t(`floatingArona.${status}`) : '' }}</span>
		</div>
	</Teleport>
</template>

<style scoped lang="scss">
.floating-arona {
	position: fixed;
	inset-inline-end: var(--dock-inset-inline);
	inset-block-end: var(--dock-inset-block);
	z-index: var(--layer-floating);
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: var(--space-3);

	&.is-under-drawer {
		visibility: hidden;
	}
}

.arona-launcher {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	inline-size: var(--dock-launcher-size);
	block-size: var(--dock-launcher-size);
	padding: 0;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	background: var(--surface-raised);
	box-shadow: var(--elevation-2);
	transition: transform var(--motion-fast) var(--ease-standard);

	&:hover {
		transform: translateY(-1px);
	}
}

.activity-dot {
	position: absolute;
	inset-block-start: 0;
	inset-inline-end: 0;
	inline-size: .625rem;
	block-size: .625rem;
	border: 2px solid var(--surface-raised);
	border-radius: var(--radius-full);
	background: var(--success);
	box-sizing: content-box;
}

.attention-badge {
	position: absolute;
	inset-block-start: -.125rem;
	inset-inline-end: -.125rem;
	display: grid;
	place-items: center;
	inline-size: 1rem;
	block-size: 1rem;
	border: 2px solid var(--surface-raised);
	border-radius: var(--radius-full);
	background: var(--warning);
	color: var(--warning-invert);
	font-size: .5625rem;
	box-sizing: content-box;
}

.arona-panel {
	display: flex;
	flex-direction: column;
	inline-size: min(460px, calc(100vw - 2 * var(--dock-inset-inline)));
	// Leaves the header usable above the panel and the launcher below it.
	block-size: min(720px, calc(100dvh - var(--header-height) - var(--dock-reserve) - var(--space-2)));
	overflow: hidden;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	outline: none;
}

// Same shape as the assistant's toolbar buttons in the row they join.
.panel-button {
	display: grid;
	flex-shrink: 0;
	place-items: center;
	inline-size: var(--control-height);
	block-size: var(--control-height);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&:disabled {
		opacity: .5;
		cursor: not-allowed;
	}

	@media (pointer: coarse) {
		inline-size: var(--target-min);
		block-size: var(--target-min);
	}
}

.panel-body {
	flex: 1;
	min-block-size: 0;
	overflow: hidden;
}

.panel-state {
	display: grid;
	align-content: start;
	gap: var(--space-4);
	padding: var(--space-3) var(--space-4);
}

.panel-state__header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
}

.panel-state__loading {
	color: var(--text-secondary);
	font-size: var(--text-md);
}
</style>
