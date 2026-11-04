<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {clearDiagnostics, diagnosticReport, diagnostics, diagnosticsOpen, selectedDiagnostic} from '@/helpers/diagnostics'
const {t} = useI18n({useScope: 'global'})
const dialog = ref<HTMLDialogElement>()
const includeDetails = ref(false)
const copied = ref(false)
const selected = computed(() => diagnostics.value.find(item => item.id === selectedDiagnostic.value) ?? diagnostics.value[0])
const report = computed(() => diagnosticReport(selected.value, includeDetails.value))
let previousFocus: HTMLElement | null = null
watch(diagnosticsOpen, async open => {
	await nextTick()
	if (open) {
		includeDetails.value = false
		if (!diagnostics.value.some(item => item.id === selectedDiagnostic.value)) selectedDiagnostic.value = diagnostics.value[0]?.id ?? ''
		copied.value = false
		previousFocus = document.activeElement as HTMLElement
		dialog.value?.showModal()
	} else {
		dialog.value?.close()
		previousFocus?.focus()
	}
})
watch(selectedDiagnostic, () => { includeDetails.value = false; copied.value = false })
async function copy() {
	try { await navigator.clipboard.writeText(report.value); copied.value = true } catch { copied.value = false }
}
function download() {
	const url = URL.createObjectURL(new Blob([report.value], {type: 'application/json'}))
	const link = document.createElement('a')
	link.href = url
	link.download = `astering-diagnostic-${selected.value?.id ?? 'environment'}.json`
	link.click()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
	<dialog
		ref="dialog"
		class="diagnostic-window"
		aria-labelledby="diagnostic-heading"
		@cancel.prevent="diagnosticsOpen = false"
		@close="diagnosticsOpen = false"
	>
		<header>
			<h2 id="diagnostic-heading">
				<Icon icon="code" /> {{ t('debug.title') }}
			</h2><XButton
				variant="secondary"
				:shadow="false"
				@click="diagnosticsOpen = false"
			>
				{{ t('misc.close') }}
			</XButton>
		</header>
		<p>{{ t('debug.description') }}</p>
		<label class="records-label">{{ t('debug.records') }}<select
			v-model="selectedDiagnostic"
			class="input"
		><option
			v-for="item in diagnostics"
			:key="item.id"
			:value="item.id"
		>{{ item.time }} · {{ item.code }} ×{{ item.count }}</option></select></label>
		<p v-if="!diagnostics.length">
			{{ t('debug.empty') }}
		</p>
		<p
			v-if="selected?.metadata.trace_id"
			class="trace-id"
		>
			{{ t('debug.trace') }}: {{ selected.metadata.trace_id }}
		</p>
		<label class="details-opt-in"><input
			v-model="includeDetails"
			type="checkbox"
		> {{ t('debug.includeDetails') }}</label>
		<p class="detail-warning">
			{{ t('debug.privacy') }}
		</p>
		<pre
			tabindex="0"
			:aria-label="t('debug.report')"
		>{{ report }}</pre>
		<footer>
			<XButton
				icon="copy"
				@click="copy"
			>
				{{ copied ? t('chat.copied') : t('debug.copy') }}
			</XButton><XButton
				variant="secondary"
				icon="download"
				@click="download"
			>
				{{ t('debug.download') }}
			</XButton><XButton
				variant="secondary"
				@click="clearDiagnostics"
			>
				{{ t('debug.clear') }}
			</XButton>
		</footer>
	</dialog>
</template>

<style scoped lang="scss">
.diagnostic-window {
	inline-size: min(58rem, calc(100vw - 1.5rem));
	max-block-size: calc(100dvh - 2rem);
	padding: var(--space-5);
	overflow: auto;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
	color: var(--text-primary);

	&::backdrop {
		background: var(--scrim);
	}

	> p {
		color: var(--text-secondary);
		font-size: var(--text-md);
	}
}

header,
footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
}

header {
	justify-content: space-between;
	margin-block-end: var(--space-2);
}

footer {
	margin-block-start: var(--space-3);
}

h2 {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
}

.records-label {
	display: grid;
	gap: var(--space-1);
	margin-block: var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

pre {
	max-block-size: 45dvh;
	padding: var(--space-3);
	overflow: auto;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	color: var(--text-primary);
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	white-space: pre-wrap;
	overflow-wrap: anywhere;

	&:focus-visible {
		@include focus-ring;
	}
}

.detail-warning {
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

.trace-id {
	font-family: var(--font-mono);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;
}

.details-opt-in {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	font-size: var(--text-md);
}
</style>
