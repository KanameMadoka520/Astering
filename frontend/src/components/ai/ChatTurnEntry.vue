<script setup lang="ts">
import {computed} from 'vue'
import type {ChatTurn, ReviewInput} from '@/client/generated'
import ChatTurnCard from './ChatTurnCard.vue'

// Looks its turn up itself, so a streamed delta re-renders only the entry whose turn changed and never the
// TransitionGroup around the thread.
const props = withDefaults(defineProps<{
	turnKey: string
	turnOf: (key: string) => ChatTurn | undefined
	pendingTurn?: ChatTurn
	conversationId?: string
	busy: boolean
	reviewBusy?: boolean
}>(), {
	pendingTurn: undefined,
	conversationId: '',
	reviewBusy: false,
})
const emit = defineEmits<{
	review: [input: ReviewInput]
	fork: [id: string]
}>()
const turn = computed(() => props.turnOf(props.turnKey))
</script>

<template>
	<ChatTurnCard
		v-if="turn"
		:turn="turn"
		:sending="turn === pendingTurn"
		:conversation-id="conversationId"
		:busy="busy"
		:review-busy="reviewBusy"
		@review="emit('review', $event)"
		@fork="emit('fork', $event)"
	/>
</template>
