<script lang="ts">
import {computed, onScopeDispose, ref, type Ref} from 'vue'
import {assistantDay, assistantInstant, compactAssistantTime, msUntilNextAssistantDay} from '@/helpers/assistantTime'

// One shared day and one midnight timer for all timestamps, so streamed chat frames never
// re-render them and each re-renders at most once per GMT+8 day change.
const sharedDay = ref(assistantDay(Date.now()))
let subscribers = 0
let rolloverTimer: ReturnType<typeof setTimeout> | undefined

function scheduleRollover() {
	// The extra second keeps an early-firing timer from re-reading the old day.
	rolloverTimer = setTimeout(() => {
		sharedDay.value = assistantDay(Date.now())
		scheduleRollover()
	}, msUntilNextAssistantDay(Date.now()) + 1000)
}

function resyncDay() {
	sharedDay.value = assistantDay(Date.now())
	clearTimeout(rolloverTimer)
	scheduleRollover()
}

// A sleeping device or a throttled background tab fires the timer late, so the day is read again on return: to a
// visible tab, to a page restored from the back-forward cache, or to a focused window. One set of listeners for all.
function resyncWhenVisible() {
	if (document.visibilityState === 'visible') resyncDay()
}

function useAssistantToday(): Readonly<Ref<string>> {
	if (subscribers === 0) {
		resyncDay()
		document.addEventListener('visibilitychange', resyncWhenVisible)
		window.addEventListener('pageshow', resyncDay)
		window.addEventListener('focus', resyncDay)
	}
	subscribers++

	onScopeDispose(() => {
		subscribers--
		if (subscribers === 0) {
			clearTimeout(rolloverTimer)
			rolloverTimer = undefined
			document.removeEventListener('visibilitychange', resyncWhenVisible)
			window.removeEventListener('pageshow', resyncDay)
			window.removeEventListener('focus', resyncDay)
		}
	})
	return sharedDay
}
</script>

<script setup lang="ts">
const props = withDefaults(defineProps<{
	value?: string | null,
	label: string,
	hideLabel?: boolean,
}>(), {
	value: null,
	hideLabel: false,
})

const today = useAssistantToday()
const instant = computed(() => assistantInstant(props.value))
// The same instant as the server's value, in the millisecond form HTML takes (Go sends nanoseconds).
const datetime = computed(() => instant.value ? new Date(instant.value.ms).toISOString() : undefined)
const compact = computed(() => instant.value ? compactAssistantTime(instant.value, today.value) : '')
</script>

<template>
	<!-- The server's instant stays machine-readable; the text shows it in GMT+8. -->
	<time
		v-if="instant"
		class="message-time"
		:datetime="datetime"
		:title="`${label} ${instant.full}`"
	>
		<span :class="hideLabel ? 'is-sr-only' : 'message-time-label'">{{ label }}</span> {{ compact }}
	</time>
</template>

<style scoped lang="scss">
.message-time {
	display: inline;
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
	color: var(--text-tertiary);
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}
</style>
