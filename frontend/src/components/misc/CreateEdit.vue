<template>
	<Modal
		:overflow="true"
		:wide="wide"
		:aria-label="title"
		:loading="currentLoading"
		@close="cancel"
		@opened="focusFirstField"
	>
		<Card
			:title="title"
			:shadow="false"
			:padding="false"
			class="has-text-start"
			:loading="currentLoading"
			:show-close="true"
			@close="cancel"
		>
			<div
				ref="body"
				class="p-4"
				@input.capture="markTouched"
				@change.capture="markTouched"
			>
				<slot />
			</div>

			<template #footer>
				<slot name="footer">
					<XButton
						v-if="tertiary !== ''"
						:shadow="false"
						variant="tertiary"
						class="create-edit__tertiary"
						@click.prevent.stop="$emit('tertiary', $event)"
					>
						{{ tertiary }}
					</XButton>
					<XButton
						variant="secondary"
						:shadow="false"
						:aria-disabled="currentLoading || undefined"
						@click.prevent.stop="cancel"
					>
						{{ $t('misc.cancel') }}
					</XButton>
					<!-- aria-disabled, not disabled: the clicked button keeps focus while the request runs. -->
					<XButton
						v-if="hasPrimaryAction"
						variant="primary"
						:icon="primaryIcon || undefined"
						:aria-disabled="isBusy || undefined"
						:loading="currentLoading"
						@click.prevent.stop="primary"
					>
						{{ primaryLabel || $t('misc.create') }}
					</XButton>
				</slot>
			</template>
		</Card>
		<UnsavedLeaveDialog
			:open="confirmingDiscard"
			@stay="confirmingDiscard = false"
			@discard="discard"
		/>
	</Modal>
</template>

<script setup lang="ts">
import type {IconProp} from '@fortawesome/fontawesome-svg-core'

import {computed, ref, toRef, useSlots, watch, type PropType} from 'vue'

import UnsavedLeaveDialog from '@/components/misc/UnsavedLeaveDialog.vue'
import {useGoBack} from '@/composables/useGoBack'

const props = defineProps({
	title: {type: String, required: true},
	primaryLabel: {type: String, default: ''},
	primaryIcon: {type: [String, Array, Object] as PropType<IconProp | ''>, default: 'plus'},
	primaryDisabled: {type: Boolean, default: false},
	hasPrimaryAction: {type: Boolean, default: true},
	tertiary: {type: String, default: ''},
	wide: {type: Boolean, default: false},
	loading: {type: Boolean, default: undefined},
	// Whether the form holds unsaved edits. Without it, a form dialog counts as edited once the user typed in or
	// changed one of its fields; dialogs without a primary action (they apply each change right away) never ask.
	dirty: {type: Boolean, default: undefined},
})

const emit = defineEmits<{
	'create': [event: MouseEvent],
	'primary': [event: MouseEvent],
	'tertiary': [event: MouseEvent],
	'update:loading': [value: boolean],
}>()

const goBack = useGoBack()

const loadingProp = toRef(props, 'loading')
const currentLoading = ref(false)

watch(
	loadingProp,
	(value) => {
		if (value !== undefined) {
			currentLoading.value = value
		}
	},
	{immediate: true},
)

const isBusy = computed(() => props.primaryDisabled || currentLoading.value)

const slots = useSlots()
const touched = ref(false)
const confirmingDiscard = ref(false)
const isDirty = computed(() => props.dirty ?? (props.hasPrimaryAction && !slots.footer && touched.value))

// Only what the user does counts: values the view loads into the fields after opening do not fire these events.
function markTouched() {
	touched.value = true
}

// Leaving while the request runs would navigate away from a save that is still being decided.
// Escape, the backdrop, × and Cancel all come here, so none of them drops typed changes without asking.
function cancel() {
	if (currentLoading.value || confirmingDiscard.value) return
	if (isDirty.value) {
		confirmingDiscard.value = true
		return
	}
	goBack()
}

function discard() {
	confirmingDiscard.value = false
	goBack()
}

const body = ref<HTMLElement | null>(null)
const FIELD = 'input:not([type="hidden"], [type="checkbox"], [type="radio"]), textarea, select'

// v-focus runs before the dialog opens and its focus() is dropped; without this the close button gets focus.
// Phones keep the keyboard closed, like v-focus itself.
function focusFirstField() {
	if (window.innerWidth <= 769) return
	const active = document.activeElement
	if (active instanceof HTMLElement && body.value?.contains(active)) return
	body.value?.querySelector<HTMLElement>(FIELD)?.focus()
}

function setLoading(value: boolean) {
	currentLoading.value = value
	emit('update:loading', value)
}

function primary(event: MouseEvent) {
	if (isBusy.value) {
		return
	}

	emit('create', event)
	emit('primary', event)
	setLoading(true)
}
</script>

<style lang="scss" scoped>
// The secondary action (e.g. Delete) sits apart from Cancel and the primary action.
.create-edit__tertiary {
	margin-inline-end: auto;
}
</style>
