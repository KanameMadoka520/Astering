<template>
	<div
		v-if="visible"
		class="network-activity d-print-none"
		role="status"
	>
		<Icon
			icon="spinner"
			spin
			aria-hidden="true"
		/>
		<span>{{ $t('network.loadingSlowly') }}</span>
		<button
			type="button"
			:aria-label="$t('network.dismissActivity')"
			@click="dismissed = true"
		>
			<Icon
				icon="times"
				aria-hidden="true"
			/>
		</button>
	</div>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import {useIsFetching} from '@tanstack/vue-query'
import {useOnline} from '@/composables/useOnline'
import {useAuthStore} from '@/stores/auth'

const auth = useAuthStore()
const online = useOnline()
const fetching = useIsFetching({predicate: query => query.state.data === undefined})
const delayed = ref(false)
const dismissed = ref(false)
const pending = computed(() => auth.authUser && online.value && fetching.value > 0)
const visible = computed(() => pending.value && delayed.value && !dismissed.value)
let timer: ReturnType<typeof setTimeout> | undefined

// Routine polls and cached background refreshes do not need a global announcement.
// One delayed notice covers overlapping cold reads without flashing for quick requests.
watch([pending, () => auth.identityKey], ([active]) => {
	clearTimeout(timer)
	delayed.value = false
	dismissed.value = false
	if (active) timer = setTimeout(() => {delayed.value = true}, 1200)
}, {immediate: true})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<style lang="scss" scoped>
.network-activity {
	position: fixed;
	inset-block-start: calc(var(--header-height) + var(--space-2));
	inset-inline-start: 50%;
	z-index: var(--layer-header);
	display: flex;
	align-items: center;
	gap: var(--space-3);
	max-inline-size: min(32rem, calc(100vw - var(--space-8)));
	padding: var(--space-3) var(--space-4);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	transform: translateX(-50%);

	> svg {
		flex-shrink: 0;
	}

	button {
		flex-shrink: 0;
		display: grid;
		place-items: center;
		min-inline-size: 2rem;
		min-block-size: 2rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		cursor: pointer;

		&:focus-visible {
			@include focus-ring;
		}
	}
}
</style>
