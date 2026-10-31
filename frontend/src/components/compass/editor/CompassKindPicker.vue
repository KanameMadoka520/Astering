<template>
	<fieldset
		class="compass-kind-picker"
		role="radiogroup"
		:aria-labelledby="`${uid}-legend`"
	>
		<legend
			:id="`${uid}-legend`"
			class="compass-kind-picker__legend"
		>
			{{ label }}
		</legend>
		<div class="compass-kind-picker__frame">
			<div class="compass-kind-picker__options">
				<label
					v-for="kind in COMPASS_KINDS"
					:key="kind"
					class="compass-kind-picker__option"
					:class="{'is-selected': kind === modelValue}"
				>
					<CompassGlyph
						:kind="kind"
						class="compass-kind-picker__glyph"
					/>
					<span class="compass-kind-picker__text">
						<span
							:id="`${uid}-${kind}-name`"
							class="compass-kind-picker__name"
						>{{ t(`compass.kind.${kind}`) }}</span>
						<span
							:id="`${uid}-${kind}`"
							class="compass-kind-picker__hint"
						>{{ t(`compass.kindHint.${kind}`) }}</span>
					</span>
					<!-- Named by the kind alone: the wrapping label also holds the hint, which is the description. -->
					<input
						class="compass-kind-picker__input"
						type="radio"
						:name="name"
						:value="kind"
						:checked="kind === modelValue"
						:aria-labelledby="`${uid}-${kind}-name`"
						:aria-describedby="`${uid}-${kind}`"
						@change="emit('update:modelValue', kind)"
					>
				</label>
			</div>
		</div>
	</fieldset>
</template>

<script setup lang="ts">
import {useId} from 'vue'
import {useI18n} from 'vue-i18n'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import {COMPASS_KINDS, type CompassKind} from '@/helpers/compass/constants'

defineProps<{
	modelValue: CompassKind
	label: string
	// Radio group name; unique per form.
	name: string
}>()

const emit = defineEmits<{
	'update:modelValue': [kind: CompassKind]
}>()

const {t} = useI18n({useScope: 'global'})
const uid = useId()
</script>

<style lang="scss" scoped>
.compass-kind-picker {
	min-inline-size: 0;
	margin: 0;
	padding: 0;
	border: 0;
}

.compass-kind-picker__legend {
	margin-block-end: var(--space-2);
	padding: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.compass-kind-picker__frame {
	container-type: inline-size;
}

.compass-kind-picker__options {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-2);
}

// In the wide "Details" section on tablets the cards sit side by side.
@container (min-width: 34rem) {
	.compass-kind-picker__options {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}

@container (min-width: 52rem) {
	.compass-kind-picker__options {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
}

.compass-kind-picker__option {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr) auto;
	align-items: start;
	gap: var(--space-3);
	min-block-size: var(--target-min);
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--compass-rule-strong);
	border-radius: var(--radius-md);
	background: var(--compass-paper);
	cursor: pointer;
	transition:
		border-color var(--motion-fast) var(--ease-standard),
		background-color var(--motion-fast) var(--ease-standard);

	&:hover {
		border-color: var(--border-strong);
	}

	// Border, tint and the checked radio: the choice never rests on colour alone.
	&.is-selected {
		border-color: var(--compass-accent);
		background-color: var(--compass-accent-tint);
		box-shadow: inset 0 0 0 1px var(--compass-accent);
	}

	&:has(.compass-kind-picker__input:focus-visible) {
		@include focus-ring;
	}
}

.compass-kind-picker__glyph {
	--compass-glyph-size: 1.35rem;

	margin-block-start: .1rem;
}

.compass-kind-picker__text {
	display: flex;
	flex-direction: column;
	gap: .1rem;
	min-inline-size: 0;
}

.compass-kind-picker__name {
	color: var(--compass-ink);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
	line-height: 1.35;
}

.compass-kind-picker__hint {
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	line-height: 1.45;
}

.compass-kind-picker__input {
	flex: none;
	inline-size: 1rem;
	block-size: 1rem;
	margin: .2rem 0 0;
	accent-color: var(--compass-accent);
	cursor: pointer;

	// The whole card shows the focus ring.
	&:focus-visible {
		outline: none;
	}
}
</style>
