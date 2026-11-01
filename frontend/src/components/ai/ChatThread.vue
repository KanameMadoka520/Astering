<script setup lang="ts">
import {computed} from 'vue'
import type {ChatTurn, ReviewInput} from '@/client/generated'
import {provideNearViewportRoot} from '@/composables/useNearViewport'
import ChatTurnEntry from './ChatTurnEntry.vue'

const props = withDefaults(defineProps<{
	// A getter, not the array: the array changes with every streamed delta, and as a prop it would re-render the
	// whole assistant view each time.
	readTurns: () => readonly ChatTurn[]
	pendingTurn?: ChatTurn
	conversationId?: string
	busy: boolean
	reviewBusy?: boolean
	// Off while a conversation opens or catches up, so only turns appended in view fade in.
	reveal: boolean
	// The element the thread scrolls in; attachment images load as they come near its visible part.
	scrollRoot?: () => Element | null | undefined
}>(), {
	pendingTurn: undefined,
	conversationId: '',
	reviewBusy: false,
	scrollRoot: () => null,
})
const emit = defineEmits<{
	review: [input: ReviewInput]
	fork: [id: string]
}>()

provideNearViewportRoot(() => props.scrollRoot())

function keyOf(turn: ChatTurn) {
	return turn.request_id || turn.id || ''
}
// The TransitionGroup measures every turn whenever it re-renders. Its slot reads only these keys, which keep their
// identity until a turn is added or removed, so it stays still while an answer streams.
const keys = computed<readonly string[]>(previous => {
	const next = props.readTurns().map(keyOf)
	if (previous?.length === next.length && next.every((key, index) => key === previous[index])) return previous
	return next
})
const turns = computed(() => new Map(props.readTurns().map(turn => [keyOf(turn), turn])))
function turnOf(key: string) {
	return turns.value.get(key)
}
</script>

<template>
	<TransitionGroup
		name="message-reveal"
		:css="reveal"
	>
		<ChatTurnEntry
			v-for="key in keys"
			:key="key"
			:turn-key="key"
			:turn-of="turnOf"
			:pending-turn="pendingTurn"
			:conversation-id="conversationId"
			:busy="busy"
			:review-busy="reviewBusy"
			@review="emit('review', $event)"
			@fork="emit('fork', $event)"
		/>
	</TransitionGroup>
</template>

<style scoped lang="scss">
.message-reveal-enter-active {
	transition:
		opacity var(--motion-base) var(--ease-enter),
		transform var(--motion-base) var(--ease-enter);
}

.message-reveal-enter-from {
	opacity: 0;
	transform: translateY(var(--space-1));
}

@media (prefers-reduced-motion: reduce) {
	.message-reveal-enter-active {
		transition: none;
	}
}
</style>
