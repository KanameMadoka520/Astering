<script setup lang="ts">
import {computed, nextTick, ref, useId, watch, onBeforeUnmount} from 'vue'
import {computePosition, autoUpdate, flip, offset, shift, size} from '@floating-ui/dom'
import {onClickOutside} from '@vueuse/core'
import {useI18n} from 'vue-i18n'

const props = withDefaults(defineProps<{modelValue?: string, models: string[], label: string, placeholder?: string, required?: boolean}>(), {modelValue: '', placeholder: '', required: false})
const emit = defineEmits<{'update:modelValue': [value: string]}>()
const {t} = useI18n({useScope: 'global'})
const id = useId()
const root = ref<HTMLElement>()
const input = ref<HTMLInputElement>()
const popup = ref<HTMLElement>()
const popupStyle = ref({left: '0px', top: '0px', visibility: 'hidden' as 'hidden' | 'visible'})
let cleanupPosition: (() => void) | undefined
const open = ref(false)
const filter = ref('')
const cursor = ref(-1)
const matches = computed(() => props.models.filter(m => m.toLowerCase().includes(filter.value.toLowerCase())))
function reveal() { filter.value = ''; cursor.value = -1; open.value = true }
function choose(value: string) { emit('update:modelValue', value); open.value = false; input.value?.focus() }
function type(event: Event) {
	const value = (event.target as HTMLInputElement).value
	emit('update:modelValue', value); filter.value = value; cursor.value = -1; open.value = true
}
async function keydown(event: KeyboardEvent) {
	if (event.isComposing) return
	if (event.key === 'Escape' && open.value) {
		open.value = false
		event.preventDefault()
		event.stopPropagation()
		return
	}
	if (event.key === 'Tab') { open.value = false; return }
	if (event.key === 'Enter' && open.value && cursor.value >= 0) { event.preventDefault(); choose(matches.value[cursor.value]); return }
	if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
	event.preventDefault()
	if (!open.value) reveal()
	cursor.value = Math.max(0, Math.min(matches.value.length - 1, cursor.value + (event.key === 'ArrowDown' ? 1 : -1)))
	await nextTick()
	document.getElementById(`${id}-${cursor.value}`)?.scrollIntoView({block: 'nearest'})
}
onClickOutside(root, () => { open.value = false })
watch(open, async value => {
	cleanupPosition?.(); cleanupPosition = undefined
	popupStyle.value.visibility = 'hidden'
	if (!value) return
	await nextTick()
	if (!root.value || !popup.value || !open.value) return
	cleanupPosition = autoUpdate(root.value, popup.value, async () => {
		if (!root.value || !popup.value) return
		const {x, y} = await computePosition(root.value, popup.value, {placement: 'bottom-start', middleware: [offset(6), flip({padding: 8}), shift({padding: 8}), size({padding: 8, apply({availableHeight, rects, elements}) {
			elements.floating.style.width = `${rects.reference.width}px`
			elements.floating.style.setProperty('--picker-height', `${Math.max(0, availableHeight)}px`)
		}})]})
		if (open.value) popupStyle.value = {left: `${x}px`, top: `${y}px`, visibility: 'visible'}
	})
})
onBeforeUnmount(() => cleanupPosition?.())
watch(() => props.models, () => { cursor.value = -1; filter.value = '' })
</script>

<template>
	<div
		ref="root"
		class="model-picker"
		@focusout="event => {if (!root?.contains(event.relatedTarget as Node)) open = false}"
	>
		<label :for="id">{{ label }}</label>
		<div class="picker-field">
			<input
				:id="id"
				ref="input"
				:value="modelValue"
				class="input"
				role="combobox"
				aria-autocomplete="list"
				:aria-expanded="open"
				:aria-controls="`${id}-list`"
				:aria-activedescendant="open && cursor >= 0 ? `${id}-${cursor}` : undefined"
				:required="required"
				:placeholder="placeholder"
				autocomplete="off"
				@input="type"
				@click="reveal"
				@keydown="keydown"
			>
			<button
				type="button"
				class="picker-toggle"
				:aria-label="t('modelPicker.browse')"
				:aria-expanded="open"
				:aria-controls="`${id}-list`"
				@click="open ? open = false : reveal()"
			>
				<Icon icon="chevron-down" />
			</button>
		</div>
		<div
			v-if="open"
			ref="popup"
			:style="popupStyle"
			class="picker-popup"
		>
			<p class="picker-hint">
				{{ t('modelPicker.hint', {count: models.length}) }}
			</p>
			<ul
				:id="`${id}-list`"
				role="listbox"
				:aria-label="label"
			>
				<li
					v-for="(model, index) in matches"
					:id="`${id}-${index}`"
					:key="model"
					role="option"
					:aria-selected="model === modelValue"
					:class="{'is-active': cursor === index}"
					@pointerdown.prevent
					@click="choose(model)"
				>
					<span>{{ model }}</span><Icon
						v-if="model === modelValue"
						icon="check"
					/>
				</li>
			</ul>
			<p
				v-if="!matches.length"
				class="picker-hint"
			>
				{{ t(models.length ? 'modelPicker.noMatch' : 'modelPicker.empty') }}
			</p>
		</div>
	</div>
</template>

<style scoped lang="scss">
.model-picker {
position: relative;
min-inline-size: 0;
}
.picker-field {
position: relative;
}
.input {
padding-inline-end: 2.75rem;
}
.picker-toggle {
display: grid;
place-items: center;
line-height: 1;
position: absolute;
inset-block: 0;
inset-inline-end: 0;
inline-size: 2.75rem;
border: 0;
background: transparent;
color: var(--text-light);
cursor: pointer;
}
.picker-popup {
position: absolute;
z-index: 40;
 border: 1px solid var(--grey-200);
border-radius: .75rem;
background: var(--site-background);
box-shadow: 0 8px 24px #00000022;
overflow: hidden;
}
ul {
max-block-size: min(16rem, 40dvh, max(44px, calc(var(--picker-height, 320px) - 4rem)));
overflow-y: auto;
overscroll-behavior: contain;
margin: 0;
padding: .25rem;
list-style: none;
}
li {
display: flex;
justify-content: space-between;
gap: .5rem;
padding: .65rem .75rem;
min-block-size: 44px;
border-radius: .4rem;
overflow-wrap: anywhere;
cursor: pointer;
}
li:hover, li.is-active, li[aria-selected="true"] {
background: var(--grey-100);
}
.picker-hint {
padding: .5rem .75rem;
font-size: .75rem;
color: var(--text-light);
margin: 0;
}
@media (prefers-reduced-motion: no-preference) {
.picker-popup {
animation: picker-appear .12s ease-out;
} @keyframes picker-appear {
from {
opacity: 0;
transform: translateY(-3px);
} to {
opacity: 1;
transform: translateY(0);
}
}
}
</style>
