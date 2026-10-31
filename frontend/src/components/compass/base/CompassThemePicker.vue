<template>
	<fieldset class="compass-theme-picker">
		<legend class="compass-theme-picker__legend">
			{{ label }}
		</legend>
		<div class="compass-theme-picker__options">
			<label
				v-for="option in options"
				:key="option"
				class="compass-theme-picker__option"
				:class="{'is-selected': option === modelValue}"
			>
				<input
					class="compass-theme-picker__input"
					type="radio"
					:name="name"
					:value="option"
					:checked="option === modelValue"
					@change="emit('update:modelValue', option)"
				>
				<!-- Each swatch carries its own theme scope, so it paints with that theme's sky tokens. -->
				<span
					class="compass-theme compass-theme-picker__sky"
					:data-compass-theme="option === 'inherit' ? inheritFrom : option"
					aria-hidden="true"
				>
					<CompassGlyph
						class="compass-theme-picker__star"
						kind="guide"
					/>
				</span>
				<span class="compass-theme-picker__name">{{ t(`compass.theme.${option}`) }}</span>
			</label>
		</div>
	</fieldset>
</template>

<script setup lang="ts" generic="T extends CompassEntryTheme">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import CompassGlyph from './CompassGlyph.vue'
import {
	COMPASS_DEFAULT_THEME,
	COMPASS_THEMES,
	type CompassEntryTheme,
	type CompassTheme,
} from '@/helpers/compass/constants'

const props = withDefaults(defineProps<{
	modelValue: T
	label: string
	// Radio group name; unique per form.
	name: string
	includeInherit?: boolean
	// What "same as the space" currently looks like.
	inheritFrom?: CompassTheme
}>(), {
	includeInherit: false,
	inheritFrom: COMPASS_DEFAULT_THEME,
})

const emit = defineEmits<{
	'update:modelValue': [value: T]
}>()

const {t} = useI18n({useScope: 'global'})

const options = computed(() => (props.includeInherit
	? ['inherit', ...COMPASS_THEMES]
	: [...COMPASS_THEMES]) as T[])
</script>

<style lang="scss" scoped>
.compass-theme-picker {
	min-inline-size: 0;
	margin: 0;
	padding: 0;
	border: 0;
}

.compass-theme-picker__legend {
	margin-block-end: var(--space-2);
	padding: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.compass-theme-picker__options {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
	gap: var(--space-2);
}

.compass-theme-picker__option {
	position: relative;
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding: var(--space-1);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	cursor: pointer;
	transition: border-color var(--motion-fast) var(--ease-standard);

	&:hover {
		border-color: var(--border-strong);
	}

	&.is-selected {
		border-color: var(--compass-accent, var(--primary));
		box-shadow: inset 0 0 0 1px var(--compass-accent, var(--primary));
	}

	&:has(.compass-theme-picker__input:focus-visible) {
		@include focus-ring;
	}
}

// Visually hidden but focusable: the label is the visible control.
.compass-theme-picker__input {
	position: absolute;
	inline-size: 1px;
	block-size: 1px;
	opacity: 0;
	pointer-events: none;
}

.compass-theme-picker__sky {
	position: relative;
	display: block;
	block-size: 2.75rem;
	border-radius: var(--radius-sm);
	background:
		radial-gradient(circle at 78% 30%, var(--compass-glow-a), transparent 60%),
		radial-gradient(circle at 20% 90%, var(--compass-glow-b), transparent 65%),
		linear-gradient(135deg, var(--compass-sky-from), var(--compass-sky-via) 55%, var(--compass-sky-to));
}

.compass-theme-picker__star {
	--compass-glyph-size: .9rem;

	position: absolute;
	inset-block-start: .45rem;
	inset-inline-end: .5rem;
	color: var(--compass-star);
}

.compass-theme-picker__name {
	padding-inline: var(--space-1);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	text-align: center;
}

@media (pointer: coarse) {
	.compass-theme-picker__sky {
		block-size: 3rem;
	}
}
</style>
