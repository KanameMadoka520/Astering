<template>
	<template
		v-for="(part, index) in parts"
		:key="index"
	>
		<mark
			v-if="part.match"
			class="compass-highlight"
		>{{ part.text }}</mark>
		<template v-else>
			{{ part.text }}
		</template>
	</template>
</template>

<script setup lang="ts">
import {computed} from 'vue'

const props = defineProps<{
	text: string
	term: string
}>()

const SYNTAX = /[.*+?^${}()|[\]\\/]/g

// Split, never v-html: the matched text is the author's own, rendered as text.
const parts = computed(() => {
	const term = props.term.trim()
	if (term === '' || props.text === '') {
		return [{
			text: props.text,
			match: false,
		}]
	}
	const pattern = new RegExp(`(${term.replace(SYNTAX, '\\$&')})`, 'giu')
	return props.text
		.split(pattern)
		.map((text, index) => ({
			text,
			match: index % 2 === 1,
		}))
		.filter(part => part.text !== '')
})
</script>

<style lang="scss" scoped>
.compass-highlight {
	padding: 0 .08em;
	border-radius: 2px;
	background: hsla(48, 100%, 58%, .4);
	color: inherit;

	:root.dark & {
		background: hsla(48, 90%, 50%, .32);
	}

	@media (forced-colors: active) {
		background: Mark;
		color: MarkText;
	}
}
</style>
