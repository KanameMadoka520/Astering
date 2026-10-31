<template>
	<fieldset class="compass-sharing-choice">
		<legend class="compass-sharing-choice__legend">
			{{ t('compass.sharing.legend') }}
		</legend>
		<div class="compass-sharing-choice__options">
			<label
				v-for="option in OPTIONS"
				:key="option.value"
				class="compass-sharing-choice__option"
				:class="{'is-selected': modelValue === option.value}"
			>
				<input
					class="compass-sharing-choice__input"
					type="radio"
					:name="name"
					:value="option.value"
					:checked="modelValue === option.value"
					:aria-labelledby="`${uid}-${option.value}-title`"
					:aria-describedby="`${uid}-${option.value}-hint`"
					@change="emit('update:modelValue', option.value)"
				>
				<span class="compass-sharing-choice__body">
					<span class="compass-sharing-choice__head">
						<Icon
							class="compass-sharing-choice__icon"
							:icon="option.icon"
						/>
						<span
							:id="`${uid}-${option.value}-title`"
							class="compass-sharing-choice__title"
						>{{ t(option.title) }}</span>
					</span>
					<span
						:id="`${uid}-${option.value}-hint`"
						class="compass-sharing-choice__hint"
					>{{ t(option.hint) }}</span>
				</span>
			</label>
		</div>
		<CompassTeamPicker
			v-if="modelValue === 'team'"
			class="compass-sharing-choice__teams"
			:model-value="team"
			:name="`${name}-team`"
			:error="teamError"
			@update:modelValue="emit('update:team', $event)"
		/>
		<p class="compass-sharing-choice__permanent">
			<Icon
				class="compass-sharing-choice__permanent-icon"
				icon="circle-info"
			/>
			<span>{{ t('compass.sharing.permanent') }}</span>
		</p>
	</fieldset>
</template>

<script setup lang="ts">
import {useId} from 'vue'
import {useI18n} from 'vue-i18n'
import Icon from '@/components/misc/Icon'
import CompassTeamPicker from './CompassTeamPicker.vue'
import type {CompassSharing, CompassTeamChoice} from './sharing'

withDefaults(defineProps<{
	modelValue: CompassSharing
	team: CompassTeamChoice | null
	// Radio group name; unique per form.
	name: string
	teamError?: string
}>(), {
	teamError: '',
})

const emit = defineEmits<{
	'update:modelValue': [value: CompassSharing]
	'update:team': [value: CompassTeamChoice | null]
}>()

const OPTIONS = [
	{
		value: 'personal',
		icon: 'lock',
		title: 'compass.sharing.private',
		hint: 'compass.sharing.privateHint',
	},
	{
		value: 'team',
		icon: 'users',
		title: 'compass.sharing.team',
		hint: 'compass.sharing.teamHint',
	},
] as const satisfies readonly {
	value: CompassSharing
	icon: string
	title: string
	hint: string
}[]

const {t} = useI18n({useScope: 'global'})
const uid = useId()
</script>

<style lang="scss" scoped>
.compass-sharing-choice {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	min-inline-size: 0;
	margin: 0;
	padding: 0;
	border: 0;
}

.compass-sharing-choice__legend {
	margin-block-end: var(--space-2);
	padding: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.compass-sharing-choice__options {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
	gap: var(--space-3);
}

.compass-sharing-choice__option {
	display: flex;
	align-items: flex-start;
	gap: var(--space-3);
	padding: var(--space-3) var(--space-4);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-md);
	background: var(--surface);
	cursor: pointer;
	transition: border-color var(--motion-fast) var(--ease-standard);

	&:hover {
		border-color: var(--border-strong);
	}

	// Border weight and the native radio dot carry the state; the tint only supports them.
	&.is-selected {
		border-color: var(--compass-accent);
		background: var(--compass-accent-tint);
		box-shadow: inset 0 0 0 1px var(--compass-accent);
	}

	&:has(.compass-sharing-choice__input:focus-visible) {
		@include focus-ring;
	}
}

.compass-sharing-choice__input {
	flex: none;
	inline-size: 1.05rem;
	block-size: 1.05rem;
	margin: .15rem 0 0;
	accent-color: var(--compass-accent);
	cursor: pointer;

	// The ring sits on the whole card instead.
	&:focus-visible {
		outline: none;
	}
}

.compass-sharing-choice__body {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	min-inline-size: 0;
}

.compass-sharing-choice__head {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.compass-sharing-choice__icon {
	flex: none;
	color: var(--compass-accent);
}

.compass-sharing-choice__title {
	color: var(--compass-ink);
	font-size: var(--text-base);
	font-weight: var(--weight-semibold);
}

.compass-sharing-choice__hint {
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.compass-sharing-choice__permanent {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.compass-sharing-choice__permanent-icon {
	flex: none;
	margin-block-start: .2rem;
}

@media (pointer: coarse) {
	.compass-sharing-choice__option {
		min-block-size: var(--target-min);
	}

	.compass-sharing-choice__input {
		inline-size: 1.25rem;
		block-size: 1.25rem;
	}
}
</style>
