<template>
	<div
		class="notifications"
		@keydown.esc="closeAndRestoreFocus"
	>
		<slot
			name="trigger"
			:toggle-open="toggle"
			:has-unread-notifications="unreadNotifications > 0"
		>
			<BaseButton
				ref="trigger"
				class="trigger-button"
				:aria-expanded="showNotifications"
				:aria-controls="showNotifications ? popupId : undefined"
				@click.stop="toggle"
			>
				<span class="is-sr-only">
					{{ $t('notification.title') }}<template v-if="unreadNotifications > 0">,
						{{ $t('notification.unreadCount', {count: unreadNotifications}) }}</template>
				</span>
				<span
					v-if="unreadNotifications > 0"
					class="unread-indicator"
				/>
				<Icon icon="bell" />
			</BaseButton>
		</slot>

		<CustomTransition name="fade">
			<div
				v-if="showNotifications"
				:id="popupId"
				ref="popup"
				class="notifications-list"
				role="dialog"
				tabindex="-1"
				:aria-labelledby="`${popupId}-title`"
			>
				<div class="head">
					<span :id="`${popupId}-title`">{{ $t('notification.title') }}</span>
					<div class="actions">
						<!-- Deletes every notification, so it says so and asks first; the double check belongs to "mark read". -->
						<BaseButton
							v-if="notifications.length > 0"
							class="action-link clear-all"
							@click="confirmingClear = true"
						>
							<Icon
								icon="trash-alt"
								aria-hidden="true"
							/>
							<span>{{ $t('notification.clearAll') }}</span>
						</BaseButton>
						<BaseButton
							v-tooltip="$t('notification.subscribeFeed')"
							class="action-link"
							:to="{name: 'user.settings.feeds'}"
							@click="showNotifications = false"
						>
							<span class="is-sr-only">{{ $t('notification.subscribeFeed') }}</span>
							<Icon icon="rss" />
						</BaseButton>
					</div>
				</div>
				<!-- Rows with a target are real buttons; only phrasing content inside keeps them valid. -->
				<component
					:is="n.route ? 'button' : 'div'"
					v-for="n in notifications"
					:key="n.id"
					:type="n.route ? 'button' : undefined"
					class="single-notification"
					:class="{
						'is-clickable': n.route,
						'is-unread': !n.read,
					}"
					@click="to(n)"
				>
					<span
						class="read-indicator"
						:class="{'read': n.read}"
					>
						<span class="is-sr-only">{{ n.read ? $t('notification.read') : $t('notification.unread') }}</span>
					</span>
					<UserAvatar
						v-if="n.doer"
						:user="n.doer"
						:size="40"
						class="notification-avatar"
					/>
					<span class="detail">
						<span class="notification-text">
							<span
								v-if="n.doer"
								class="doer"
							>{{ n.doerName }}</span>
							{{ n.text }}
						</span>
						<time
							v-tooltip="formatDateLong(n.created)"
							class="created"
							:datetime="n.created"
						>
							{{ formatDisplayDate(n.created) }}
						</time>
					</span>
				</component>
				<XButton
					v-if="inbox.hasNextPage.value"
					variant="tertiary"
					class="mbs-2 is-fullwidth"
					:loading="inbox.isFetchingNextPage.value"
					@click="inbox.fetchNextPage()"
				>
					{{ $t('notification.loadMore') }}
				</XButton>
				<XButton
					v-if="notifications.length > 0 && unreadNotifications > 0"
					variant="tertiary"
					class="mbs-2 is-fullwidth"
					@click="markAllRead"
				>
					{{ $t('notification.markAllRead') }}
				</XButton>
				<p
					v-if="notifications.length === 0"
					class="nothing"
				>
					{{ $t('notification.none') }}<br>
					<span class="explainer">
						{{ $t('notification.explainer') }}
					</span>
				</p>
			</div>
		</CustomTransition>

		<Modal
			:enabled="confirmingClear"
			danger
			:confirm-label="$t('notification.clearAllConfirm')"
			@close="confirmingClear = false"
			@submit="clearAll"
		>
			<template #header>
				<span>{{ $t('notification.clearAllTitle') }}</span>
			</template>
			<template #text>
				<p>{{ $t('notification.clearAllText') }}</p>
			</template>
		</Modal>
	</div>
</template>

<script lang="ts" setup>
import {computed, nextTick, onMounted, onUnmounted, ref, useId} from 'vue'
import {useRouter, isNavigationFailure, NavigationFailureType} from 'vue-router'
import {useInfiniteQuery} from '@tanstack/vue-query'
import {
	notificationsQuery,
	useMarkNotificationReadMutation,
	useMarkAllNotificationsReadMutation,
	useClearNotificationsMutation,
} from '@/client/queries/notifications'
import {notificationDoer, notificationRoute, notificationText} from '@/helpers/notification'
import {parseDateOrNull} from '@/helpers/parseDateOrNull'
import BaseButton from '@/components/base/BaseButton.vue'
import CustomTransition from '@/components/misc/CustomTransition.vue'
import Modal from '@/components/misc/Modal.vue'
import UserAvatar from '@/components/misc/UserAvatar.vue'
import {closeWhenClickedOutside} from '@/helpers/closeWhenClickedOutside'
import {formatDateLong, formatDisplayDate} from '@/helpers/time/formatDate'
import {getDisplayName} from '@/helpers/user'
import {useAuthStore} from '@/stores/auth'
import {useWebSocket} from '@/composables/useWebSocket'
import XButton from '@/components/input/Button.vue'

const {authenticated, isAwaitingFirstConnection} = useWebSocket()
const authStore = useAuthStore()
const router = useRouter()
const inbox = useInfiniteQuery(computed(() => ({
	...notificationsQuery(),
	// A fetch before the socket subscribes would be refetched by the subscribe sweep.
	enabled: !isAwaitingFirstConnection(),
	refetchInterval: authenticated.value ? false : 10_000,
})))
const readMutation = useMarkNotificationReadMutation()
const readAllMutation = useMarkAllNotificationsReadMutation()
const clearMutation = useClearNotificationsMutation()
// A notification arriving between page loads shifts the offsets and repeats a row on the next page.
const loadedNotifications = computed(() => [...new Map((inbox.data.value?.pages ?? [])
	.flatMap(page => page.items)
	.map(n => [n.id, n] as const)).values()])
const notifications = computed(() => loadedNotifications.value.flatMap(n => {
	if (!n.name || !n.id) return []
	const doer = notificationDoer(n)
	return [{
		id: n.id,
		created: n.created,
		doer,
		doerName: getDisplayName(doer),
		text: notificationText(n, authStore.info),
		route: notificationRoute(n),
		read: parseDateOrNull(n.read_at) !== null,
	}]
}))
type NotificationRow = typeof notifications.value[number]
const unreadNotifications = computed(() => notifications.value.filter(n => !n.read).length)
const showNotifications = ref(false)
const confirmingClear = ref(false)
const popup = ref<HTMLElement | null>(null)
const trigger = ref<InstanceType<typeof BaseButton> | null>(null)
const popupId = useId()

async function toggle() {
	showNotifications.value = !showNotifications.value
	if (!showNotifications.value) return
	await nextTick()
	popup.value?.focus({preventScroll: true})
}

function closeAndRestoreFocus() {
	if (!showNotifications.value) return
	showNotifications.value = false
	trigger.value?.focus()
}

onMounted(() => document.addEventListener('click', hidePopup))
onUnmounted(() => document.removeEventListener('click', hidePopup))

function hidePopup(e: MouseEvent) {
	// The delete question opens outside the popup; answering it is not a click away from the list.
	if (confirmingClear.value) return
	if (showNotifications.value && popup.value !== null) {
		closeWhenClickedOutside(e, popup.value, () => showNotifications.value = false)
	}
}

async function to(n: NotificationRow) {
	if (!n.route) return
	readMutation.mutate(n.id)
	showNotifications.value = false
	const failure = await router.push(n.route)
	if (isNavigationFailure(failure, NavigationFailureType.duplicated)) router.go(0)
}

function markAllRead() { readAllMutation.mutate() }
// The question stays open while the request runs and after a failure (the mutation reports it).
async function clearAll() {
	try {
		await clearMutation.mutateAsync()
	} catch {
		return
	}
	confirmingClear.value = false
}
</script>

<style lang="scss" scoped>
.notifications {
	display: flex;

	.trigger-button {
		position: relative;
	}

	.unread-indicator {
		position: absolute;
		inset-block-start: 22%;
		inset-inline-end: 22%;
		inline-size: .5rem;
		block-size: .5rem;
		border: 2px solid var(--surface-app);
		border-radius: var(--radius-full);
		background: var(--primary);
		box-sizing: content-box;
	}
}

.notifications-list {
	position: absolute;
	inset-inline-end: var(--space-2);
	inset-block-start: calc(100% + var(--space-1));
	z-index: var(--layer-dropdown);
	display: flex;
	flex-direction: column;
	inline-size: 22rem;
	max-inline-size: calc(100vw - var(--space-4));
	max-block-size: min(32rem, calc(100dvh - var(--header-height) - var(--space-4)));
	padding: var(--space-1);
	overflow-y: auto;
	overscroll-behavior: contain;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);
	font-size: var(--text-md);

	&:focus-visible {
		@include focus-ring;

		outline-offset: -2px;
	}
}

.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	padding: var(--space-1) var(--space-1) var(--space-2) var(--space-2);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);

	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
}

.action-link.clear-all {
	gap: var(--space-1);
	inline-size: auto;
	padding-inline: var(--space-2);
	font-size: var(--text-sm);
	white-space: nowrap;
}

.action-link {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	inline-size: var(--control-height-sm);
	block-size: var(--control-height-sm);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		background-color: var(--surface-hover);
		color: var(--text-primary);
	}
}

.single-notification {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	inline-size: 100%;
	padding: var(--space-2);
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-secondary);
	font: inherit;
	text-align: start;
	transition: background-color var(--motion-fast) var(--ease-standard);

	&.is-unread {
		color: var(--text-primary);
	}

	&.is-clickable {
		cursor: pointer;

		&:hover {
			background-color: var(--surface-hover);
		}
	}

	& + & {
		margin-block-start: 1px;
	}
}

.read-indicator {
	flex-shrink: 0;
	inline-size: .375rem;
	block-size: .375rem;
	margin-block-start: .4375rem;
	border-radius: var(--radius-full);
	background: var(--primary);

	&.read {
		background: transparent;
	}
}

.notification-avatar {
	flex-shrink: 0;
	inline-size: 1.25rem;
	block-size: 1.25rem;
	border-radius: var(--radius-full);
}

.detail {
	display: flex;
	flex-direction: column;
	gap: .125rem;
	min-inline-size: 0;
	line-height: var(--leading-tight);
	overflow-wrap: anywhere;
}

.doer {
	font-weight: var(--weight-semibold);
}

.created {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.nothing {
	padding: var(--space-4) var(--space-3);
	color: var(--text-secondary);
	text-align: center;

	.explainer {
		color: var(--text-tertiary);
		font-size: var(--text-xs);
	}
}
</style>
