<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {ModelStep} from '@/client/generated'
import {outputSpeed} from '@/helpers/outputSpeed'
const props = withDefaults(defineProps<{step?: ModelStep}>(), {step: undefined})
const {t, n} = useI18n({useScope: 'global'})
const speed = computed(() => outputSpeed(props.step))
const label = computed(() => t(`outputSpeed.${speed.value.rate == null ? 'stream' : speed.value.mode}`))
const rate = computed(() => speed.value.rate == null ? t('outputSpeed.unavailable') : t('outputSpeed.rate', {
	rate: n(speed.value.rate, {
		maximumFractionDigits: 1,
		minimumFractionDigits: 1,
	}),
}))
</script>

<template>
	<details
		class="output-speed"
		:class="{'has-rate': speed.rate != null}"
	>
		<summary
			:title="`${label}: ${rate}`"
			:aria-label="`${label}: ${rate}`"
		>
			<span class="speed-label">{{ label }}:</span>
			<strong v-if="speed.rate != null">{{ rate }}</strong>
			<span v-else>{{ rate }}</span>
		</summary>
		<div class="speed-explanation">
			<p v-if="speed.rate == null">
				{{ t(`outputSpeed.${speed.reason}`) }}
			</p>
			<template v-else>
				<p>{{ t(`outputSpeed.${speed.mode}Help`) }}</p>
				<p class="speed-calculation">
					{{ speed.mode === 'request' ? n(speed.tokens) : `(${n(speed.tokens)} − 1)` }} ÷ {{ n(speed.durationMs / 1000, {maximumFractionDigits: 3}) }} s
				</p>
			</template>
			<p>{{ t('outputSpeed.scope', {model: step?.model || t('chat.unavailable')}) }}</p>
		</div>
	</details>
</template>

<style scoped lang="scss">
.output-speed {
	min-inline-size: 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}

summary {
	padding-block: var(--space-1);
	border-radius: var(--radius-sm);
	cursor: pointer;

	&:focus-visible {
		@include focus-ring;
	}
}

strong {
	color: var(--text-secondary);
	font-weight: var(--weight-medium);
}

.speed-explanation {
	margin-block: var(--space-1) var(--space-2);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 2px solid var(--border-default);
	color: var(--text-secondary);
	line-height: var(--leading-normal);
}

p {
	margin: 0;
}

p + p {
	margin-block-start: var(--space-1);
}

@media (width <= 768px) {
	.output-speed {
		font-size: var(--text-sm);
	}

	summary {
		min-block-size: 2.75rem;
		padding-block: .75rem;
	}

	.output-speed.has-rate .speed-label {
		display: none;
	}
}
</style>
