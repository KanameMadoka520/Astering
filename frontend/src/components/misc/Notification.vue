<template>
	<Teleport :to="teleportTarget">
		<!-- Each toast is read out once from here. Toasts are not live regions themselves: an alert inside a
			polite region is announced twice. The assertive region is not an empty role="alert", which would sit
			in every open dialog next to the dialog's own error. -->
		<p
			class="is-sr-only"
			role="status"
		>
			{{ announcement.polite }}
		</p>
		<p
			class="is-sr-only"
			aria-live="assertive"
			aria-atomic="true"
		>
			{{ announcement.alert }}
		</p>
		<Notifications
			position="bottom left"
			:max="2"
			:ignore-duplicates="true"
			class="global-notification"
			@start="start"
			@destroy="forget"
		>
			<template #body="{ item, close }">
				<!-- FIXME: overlay whole notification with button and add event listener on that button instead -->
				<!-- Its timer waits while the pointer rests on it or focus is inside it, e.g. on its Undo button. -->
				<div
					class="vue-notification-template vue-notification"
					:class="[
						item.type,
					]"
					@click="close()"
					@mouseenter="hold(item, 'pointer')"
					@mouseleave="release(item, 'pointer')"
					@focusin="hold(item, 'focus')"
					@focusout="focusLeft(item, $event)"
				>
					<button
						type="button"
						class="notification-close"
						:aria-label="$t('misc.close')"
						:title="$t('misc.close')"
						@click.stop="close()"
					>
						<Icon icon="times" />
					</button>
					<div
						v-if="item.title"
						class="notification-title"
					>
						{{ item.title }}
					</div>
					<div class="notification-content">
						<template v-if="Array.isArray(item.text)">
							<template
								v-for="(t, k) in item.text"
								:key="k"
							>
								{{ t }}<br>
							</template>
						</template>
						<template v-else>
							{{ item.text }}
						</template>
						<span
							v-if="item.duplicates > 0"
							class="tw:text-xs tw:font-bold tw:ml-1"
						>
							×{{ item.duplicates + 1 }}
						</span>
					</div>
					<XButton
						v-if="item.type === 'error' && diagnostics.length"
						variant="secondary"
						class="is-small mbs-2"
						:shadow="false"
						icon="code"
						@click.stop="openDiagnostics(); close()"
					>
						{{ $t('debug.title') }}
					</XButton>
					<div
						v-if="item.data?.actions?.length > 0"
						class="mbs-2 tw:flex tw:justify-end tw:gap-2"
					>
						<XButton
							v-for="(action, i) in item.data.actions"
							:key="'action_' + i"
							:shadow="false"
							class="is-small"
							variant="secondary"
							@click="action.callback"
						>
							{{ action.title }}
						</XButton>
					</div>
				</div>
			</template>
		</Notifications>
	</Teleport>
</template>

<script lang="ts" setup>
import {computed, effectScope, nextTick, reactive, watch, type WatchStopHandle} from 'vue'
import {diagnostics, openDiagnostics} from '@/helpers/diagnostics'
import {useTopModalDialog} from '@/composables/useTopModalDialog'

// Toasts join the topmost open modal: outside it the top layer would cover them and make them inert.
const {topModalDialog} = useTopModalDialog()
const teleportTarget = computed<string | HTMLElement>(() => topModalDialog.value ?? 'body')

// The library's own pause-on-hover stops a timer again on every call, shortening it; one hold per reason here.
type Toast = {
	id: string | number
	type?: string
	title?: string
	text?: string | string[]
	duplicates?: number
	timer?: {start: () => void, stop: () => void}
}
type Region = 'polite' | 'alert'

// Errors interrupt; everything else waits for a pause in speech.
const announcement = reactive({
	polite: '',
	alert: '',
})
// The toasts each region is reading out, so their words leave with them.
const readOut: Record<Region, Set<Toast['id']>> = {polite: new Set(), alert: new Set()}
const queued: Record<Region, Toast[]> = {polite: [], alert: []}
// Closed before their region was written, e.g. pushed out by a newer toast in the same tick.
const closed = new Set<Toast['id']>()
async function announce(item: Toast) {
	const region = item.type === 'error' ? 'alert' : 'polite'
	// Toasts raised in the same tick are read out together; each would otherwise replace the one before.
	if (queued[region].push(item) > 1) return
	// Emptied first, so the same words twice in a row are read again.
	announcement[region] = ''
	await nextTick()
	const batch = queued[region].splice(0)
	const shown = batch.filter(toast => !closed.has(toast.id))
	batch.forEach(toast => closed.delete(toast.id))
	readOut[region] = new Set(shown.map(toast => toast.id))
	announcement[region] = shown.map(toast => {
		const text = Array.isArray(toast.text) ? toast.text.join(' ') : toast.text
		return [toast.title, text].filter(Boolean).join(': ')
	}).join(' ')
}

// A repeat of a toast still on screen only raises its count (ignoreDuplicates) and never starts; read it out again,
// once per repeat. notify() may run inside another component's setup or hook, whose scope would otherwise own and
// stop these watchers; this one ends with the component.
const repeatScope = effectScope()
const repeats = new Map<Toast['id'], WatchStopHandle>()
function start(item: Toast) {
	announce(item)
	// The library hands over the raw item; its reactive proxy is the one whose count changes.
	const stop = repeatScope.run(() => watch(() => reactive(item).duplicates, () => announce(item), {flush: 'sync'}))
	if (stop) repeats.set(item.id, stop)
}
const holds = new Map<Toast['id'], Set<string>>()
function hold(item: Toast, reason: string) {
	const reasons = holds.get(item.id) ?? new Set<string>()
	if (!reasons.size) item.timer?.stop()
	reasons.add(reason)
	holds.set(item.id, reasons)
}
function release(item: Toast, reason: string) {
	const reasons = holds.get(item.id)
	if (!reasons?.delete(reason) || reasons.size) return
	holds.delete(item.id)
	item.timer?.start()
}
function focusLeft(item: Toast, event: FocusEvent) {
	const toast = event.currentTarget as HTMLElement
	if (!toast.contains(event.relatedTarget as Node | null)) release(item, 'focus')
}
// Also called for a repeat that never showed, when the timer the library still started for it ends.
function forget(item: Toast) {
	holds.delete(item.id)
	repeats.get(item.id)?.()
	repeats.delete(item.id)
	for (const region of ['polite', 'alert'] as const) {
		if (queued[region].some(toast => toast.id === item.id)) closed.add(item.id)
		if (!readOut[region].delete(item.id)) continue
		// Emptying a live region is not read out.
		readOut[region].clear()
		announcement[region] = ''
	}
}
</script>

<style lang="scss" scoped>
.vue-notification {
	position: relative;
	z-index: var(--layer-toast);
	margin: 0 .5rem .5rem;
	padding: .65rem .85rem;
	padding-inline-end: 2.25rem;
	border: 1px solid var(--border-default);
	border-inline-start: 3px solid var(--primary);
	border-radius: var(--radius-md);
	background: var(--surface-raised);
	color: var(--text-primary);
	box-shadow: var(--elevation-3);
	font-size: var(--text-md);
	line-height: 1.45;
	cursor: pointer;

	&.success {
		border-inline-start-color: var(--success);
	}

	&.warn {
		border-inline-start-color: var(--warning);
	}

	&.error {
		border-inline-start-color: var(--danger);
	}
}

.notification-close {
	position: absolute;
	inset-block-start: .25rem;
	inset-inline-end: .25rem;
	display: grid;
	place-items: center;
	inline-size: 1.75rem;
	block-size: 1.75rem;
	padding: 0;
	border: 0;
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-secondary);
	cursor: pointer;

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
	}

	@media (pointer: coarse) {
		inline-size: var(--target-min);
		block-size: var(--target-min);
		inset-block-start: 0;
		inset-inline-end: 0;
	}
}

.notification-title {
	font-weight: var(--weight-semibold);
	margin-block-end: .125rem;
}

.notification-content {
	color: var(--text-secondary);
	overflow-wrap: anywhere;

	.notification-title + & {
		font-size: var(--text-sm);
	}
}
</style>

<style lang="scss">
// The library fades with `transition: all .5s`; keep it to a short opacity/transform fade.
.global-notification {
	.vn-fade-enter-active,
	.vn-fade-leave-active,
	.vn-fade-move {
		transition:
			opacity var(--motion-base) var(--ease-standard),
			transform var(--motion-base) var(--ease-standard);
	}

	.vn-fade-enter-from,
	.vn-fade-leave-to {
		opacity: 0;
		transform: translateY(6px);
	}
}
</style>
