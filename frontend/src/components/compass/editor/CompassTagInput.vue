<template>
	<div class="compass-tag-input">
		<label
			:for="inputId"
			class="compass-tag-input__label"
		>{{ label }}</label>
		<ul
			v-if="modelValue.length > 0"
			class="compass-tag-input__chips"
			:aria-label="t('compass.tags.listLabel')"
		>
			<li
				v-for="tag in modelValue"
				:key="tag"
				class="compass-tag-input__chip"
			>
				<span class="compass-tag-input__chip-text">{{ tag }}</span>
				<button
					type="button"
					class="compass-tag-input__remove"
					:aria-label="t('compass.tags.remove', {tag})"
					@click="remove(tag)"
				>
					<Icon
						icon="times"
						aria-hidden="true"
					/>
				</button>
			</li>
		</ul>
		<input
			:id="inputId"
			ref="inputRef"
			v-model="text"
			class="input compass-tag-input__field"
			type="text"
			:list="listId"
			:placeholder="t('compass.tags.placeholder')"
			:aria-describedby="problemText === '' ? hintId : `${hintId} ${problemId}`"
			:aria-invalid="problemText !== '' || undefined"
			autocomplete="off"
			enterkeyhint="enter"
			@keydown="onKeydown"
			@input="onInput"
			@compositionstart="composing = true"
			@compositionend="onCompositionEnd"
			@blur="commit"
		>
		<datalist :id="listId">
			<option
				v-for="suggestion in openSuggestions"
				:key="suggestion"
				:value="suggestion"
			/>
		</datalist>
		<p
			v-if="problemText !== ''"
			:id="problemId"
			class="compass-tag-input__problem"
		>
			<Icon
				icon="exclamation-circle"
				class="compass-tag-input__problem-icon"
				aria-hidden="true"
			/>
			<span>{{ problemText }}</span>
		</p>
		<p
			:id="hintId"
			class="compass-tag-input__hint"
		>
			<span>{{ t('compass.tags.hint', {max: COMPASS_LIMITS.tags}) }}</span>
			<span
				v-if="showsCompassCounter(modelValue.length, COMPASS_LIMITS.tags)"
				class="compass-tag-input__count"
			>{{ t('compass.editor.counter', {count: modelValue.length, limit: COMPASS_LIMITS.tags}) }}</span>
		</p>
		<!-- Always present, so that adding and removing chips is announced. -->
		<p
			class="is-sr-only"
			aria-live="polite"
		>
			{{ announcement }}
		</p>
	</div>
</template>

<script setup lang="ts">
import {computed, nextTick, ref, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import Icon from '@/components/misc/Icon'
import {COMPASS_LIMITS, runeLength} from '@/helpers/compass/constants'
import {showsCompassCounter} from './entryForm'

const props = withDefaults(defineProps<{
	modelValue: string[]
	label: string
	// Tags already used in the space, most used first.
	suggestions?: string[]
}>(), {
	suggestions: () => [],
})

const emit = defineEmits<{
	'update:modelValue': [tags: string[]]
}>()

// A comma closes a tag: Latin, full-width, or the Chinese enumeration comma.
const SEPARATOR = /[,，、]/
// A datalist with thousands of options helps nobody and slows typing down.
const MAX_SUGGESTIONS = 200

const {t} = useI18n({useScope: 'global'})

const uid = useId()
const inputId = `${uid}-input`
const listId = `${uid}-suggestions`
const hintId = `${uid}-hint`
const problemId = `${uid}-problem`

const inputRef = ref<HTMLInputElement | null>(null)
const text = ref('')
const problemText = ref('')
const announcement = ref('')
// v-model answers compositionend with a plain `input` Event that looks like a datalist pick and would commit
// "工作" while "工作方法" is still being typed. Its listener runs before ours, so this is still true then.
const composing = ref(false)

const openSuggestions = computed(() => {
	const taken = new Set(props.modelValue.map(tag => tag.toLocaleLowerCase()))
	return props.suggestions
		.filter(tag => !taken.has(tag.toLocaleLowerCase()))
		.slice(0, MAX_SUGGESTIONS)
})

function say(message: string, isProblem = false) {
	announcement.value = message
	problemText.value = isProblem ? message : ''
}

type AddResult = {
	tags: string[]
	// The text could not become a tag and stays in the field to be fixed.
	keep: boolean
}

// Duplicates are found regardless of case, but tags already on the entry are never rewritten.
function addTo(tags: string[], raw: string): AddResult {
	const tag = raw.replace(/\s+/g, ' ').trim()
	if (tag === '') {
		return {
			tags,
			keep: false,
		}
	}
	if (tags.some(existing => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
		say(t('compass.tags.duplicate', {tag}))
		return {
			tags,
			keep: false,
		}
	}
	if (tags.length >= COMPASS_LIMITS.tags) {
		say(t('compass.tags.tooMany', {max: COMPASS_LIMITS.tags}), true)
		return {
			tags,
			keep: true,
		}
	}
	if (runeLength(tag) > COMPASS_LIMITS.tag) {
		say(t('compass.tags.tooLong', {max: COMPASS_LIMITS.tag}), true)
		return {
			tags,
			keep: true,
		}
	}
	say(t('compass.tags.added', {tag}))
	return {
		tags: [...tags, tag],
		keep: false,
	}
}

function commit() {
	let tags = props.modelValue
	const kept: string[] = []
	for (const part of text.value.split(SEPARATOR)) {
		const result = addTo(tags, part)
		tags = result.tags
		if (result.keep) kept.push(part.trim())
	}
	text.value = kept.join(' ')
	if (tags !== props.modelValue) emit('update:modelValue', tags)
}

function onKeydown(event: KeyboardEvent) {
	// An input method uses Enter to confirm its candidate; that keystroke is not ours.
	if (event.isComposing) return
	if (event.key === 'Enter') {
		event.preventDefault()
		commit()
		return
	}
	if (event.key === 'Backspace' && text.value === '' && props.modelValue.length > 0) {
		event.preventDefault()
		const last = props.modelValue[props.modelValue.length - 1]
		emit('update:modelValue', props.modelValue.slice(0, -1))
		say(t('compass.tags.removed', {tag: last}))
	}
}

function onInput(event: Event) {
	if (problemText.value !== '') problemText.value = ''
	const input = event instanceof InputEvent ? event : null
	if (composing.value || input?.isComposing) return
	const typedSeparator = input !== null && (SEPARATOR.test(input.data ?? '') ||
		(input.inputType === 'insertFromPaste' && SEPARATOR.test(text.value)))
	// Choosing a datalist option replaces the text without typing it.
	const picked = input === null || input.inputType === 'insertReplacementText'
	if (typedSeparator || (picked && props.suggestions.includes(text.value.trim()))) commit()
}

// A full-width comma typed through an input method arrives when the composition ends.
function onCompositionEnd() {
	composing.value = false
	if (SEPARATOR.test(text.value)) commit()
}

async function remove(tag: string) {
	emit('update:modelValue', props.modelValue.filter(existing => existing !== tag))
	say(t('compass.tags.removed', {tag}))
	// The chip and its button are gone; the field is where writing continues.
	await nextTick()
	inputRef.value?.focus()
}
</script>

<style lang="scss" scoped>
.compass-tag-input {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	min-inline-size: 0;
}

.compass-tag-input__label {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.compass-tag-input__chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1) var(--space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.compass-tag-input__chip {
	display: inline-flex;
	align-items: center;
	max-inline-size: 100%;
	padding-inline-start: var(--space-3);
	border: 1px solid var(--compass-rule-strong);
	border-radius: var(--radius-full);
	background: var(--compass-paper);
	color: var(--compass-ink);
	font-size: var(--text-sm);
	line-height: 1.4;
}

.compass-tag-input__chip-text {
	min-inline-size: 0;
	padding-block: .15rem;
	overflow-wrap: anywhere;

	&::before {
		content: '#';
		color: var(--compass-ink-faint);
	}
}

.compass-tag-input__remove {
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	inline-size: 1.75rem;
	block-size: 1.75rem;
	margin-inline-start: var(--space-1);
	padding: 0;
	border: 0;
	border-radius: var(--radius-full);
	background: transparent;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	cursor: pointer;
	transition: background-color var(--motion-fast) var(--ease-standard);

	&:hover {
		background: var(--surface-hover);
		color: var(--compass-ink);
	}

	&:focus-visible {
		@include focus-ring;

		outline-offset: 0;
	}

	@media (pointer: coarse) {
		inline-size: var(--target-min);
		block-size: var(--target-min);
	}
}

.compass-tag-input__field {
	min-inline-size: 0;
}

.compass-tag-input__problem {
	display: flex;
	align-items: baseline;
	gap: var(--space-1);
	margin: 0;
	color: var(--danger-text);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	line-height: 1.45;
}

.compass-tag-input__problem-icon {
	flex: none;
	align-self: center;
}

.compass-tag-input__hint {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: var(--space-1) var(--space-3);
	margin: 0;
	color: var(--compass-ink-faint);
	font-size: var(--text-xs);
	line-height: 1.45;
}

.compass-tag-input__count {
	font-variant-numeric: tabular-nums;
}
</style>
