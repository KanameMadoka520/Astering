<template>
	<div class="shortcut-recorder">
		<button
			type="button"
			class="input recorder-button"
			:class="{'is-recording': recording}"
			@click="startRecording"
			@keydown="onKeyDown"
			@blur="stopRecording"
		>
			<template v-if="recording">
				<span class="recording-hint">{{ $t('user.settings.desktop.shortcutRecorderRecording') }}</span>
			</template>
			<template v-else-if="displayKeys.length > 0">
				<kbd
					v-for="(key, i) in displayKeys"
					:key="i"
				>
					{{ key }}
				</kbd>
			</template>
			<template v-else>
				<span class="placeholder">{{ $t('user.settings.desktop.shortcutRecorderPlaceholder') }}</span>
			</template>
		</button>
		<BaseButton
			v-if="modelValue"
			class="clear-button"
			:aria-label="$t('user.settings.desktop.shortcutRecorderClear')"
			@click="clear"
		>
			<Icon icon="times" />
		</BaseButton>
	</div>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue'
import BaseButton from '@/components/base/BaseButton.vue'

const props = defineProps<{
	modelValue: string,
}>()

const emit = defineEmits<{
	'update:modelValue': [value: string],
}>()

const recording = ref(false)

const isMac = navigator.platform.toUpperCase().includes('MAC')

// Map KeyboardEvent properties to Electron accelerator format
function eventToAccelerator(event: KeyboardEvent): string | null {
	if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
		return null
	}

	const parts: string[] = []

	if (event.ctrlKey || event.metaKey) parts.push('CmdOrCtrl')
	if (event.altKey) parts.push('Alt')
	if (event.shiftKey) parts.push('Shift')

	// Need at least one modifier for a global shortcut
	if (parts.length === 0) return null

	const key = mapKey(event)
	if (key) parts.push(key)
	else return null

	return parts.join('+')
}

function mapKey(event: KeyboardEvent): string | null {
	// Letters
	if (/^Key[A-Z]$/.test(event.code)) {
		return event.code.slice(3)
	}
	// Digits
	if (/^Digit[0-9]$/.test(event.code)) {
		return event.code.slice(5)
	}
	// Function keys
	if (/^F\d{1,2}$/.test(event.code)) {
		return event.code
	}
	// Special keys
	const specialMap: Record<string, string> = {
		Space: 'Space',
		Enter: 'Enter',
		Backspace: 'Backspace',
		Delete: 'Delete',
		Tab: 'Tab',
		Escape: 'Escape',
		ArrowUp: 'Up',
		ArrowDown: 'Down',
		ArrowLeft: 'Left',
		ArrowRight: 'Right',
		Home: 'Home',
		End: 'End',
		PageUp: 'PageUp',
		PageDown: 'PageDown',
		Minus: '-',
		Equal: '=',
		BracketLeft: '[',
		BracketRight: ']',
		Semicolon: ';',
		Quote: '\'',
		Backquote: '`',
		Backslash: '\\',
		Comma: ',',
		Period: '.',
		Slash: '/',
	}
	return specialMap[event.code] ?? null
}

// Convert Electron accelerator string to display-friendly key names
function acceleratorToDisplayKeys(accelerator: string): string[] {
	if (!accelerator) return []
	return accelerator.split('+').map(part => {
		if (part === 'CmdOrCtrl') return isMac ? '\u2318' : 'Ctrl'
		if (part === 'Shift') return isMac ? '\u21E7' : 'Shift'
		if (part === 'Alt') return isMac ? '\u2325' : 'Alt'
		if (part === 'Space') return '\u2423'
		return part
	})
}

const displayKeys = computed(() => acceleratorToDisplayKeys(props.modelValue))

function startRecording() {
	recording.value = true
}

function stopRecording() {
	recording.value = false
}

function onKeyDown(event: KeyboardEvent) {
	// Tab and Shift+Tab always move on, so keyboard users are never trapped here (WCAG 2.1.2).
	// A global shortcut needs Ctrl, Cmd or Alt anyway.
	if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
		recording.value = false
		return
	}
	if (event.key === 'Escape') {
		// Escape only stops a recording; otherwise it belongs to the page (closing a dialog, for example).
		if (!recording.value) return
		event.preventDefault()
		recording.value = false
		return
	}
	event.preventDefault()
	if (!recording.value) {
		startRecording()
	}

	const accelerator = eventToAccelerator(event)
	if (accelerator) {
		emit('update:modelValue', accelerator)
		recording.value = false
	}
}

function clear() {
	emit('update:modelValue', '')
}
</script>

<style lang="scss" scoped>
.shortcut-recorder {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.recorder-button {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	cursor: pointer;
	min-inline-size: 150px;
	text-align: start;

	&.is-recording {
		border-color: var(--primary);
		background-color: var(--surface-selected);
	}
}

kbd {
	padding: 1px var(--space-2);
	border: 1px solid var(--border-default);
	border-block-end-width: 2px;
	background: var(--surface-sunken);
	border-radius: var(--radius-xs);
	color: var(--text-primary);
	font-size: var(--text-sm);
	font-family: inherit;
	line-height: 1.5;

	& + kbd {
		margin-inline-start: 2px;
	}
}

.recording-hint {
	color: var(--accent-text);
	font-size: var(--text-sm);
}

.placeholder {
	color: var(--input-placeholder-color);
}

.clear-button {
	display: inline-grid;
	place-items: center;
	min-inline-size: var(--control-height-sm);
	min-block-size: var(--control-height-sm);
	border-radius: var(--radius-sm);
	color: var(--text-tertiary);

	&:hover {
		background-color: var(--surface-hover);
		color: var(--danger-text);
	}
}
</style>
