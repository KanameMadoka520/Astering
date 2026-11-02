<template>
	<div class="routine-timezone">
		<label
			:for="inputId"
			class="routine-timezone__label"
		>
			<Icon
				icon="globe"
				class="routine-timezone__icon"
			/>
			{{ $t('task.routine.settings.timezone') }}
		</label>
		<p
			v-if="disabled"
			class="routine-timezone__value"
		>
			{{ selected.label }}
		</p>
		<Multiselect
			v-else
			:id="inputId"
			:model-value="selected"
			:placeholder="$t('task.routine.settings.timezonePlaceholder')"
			:aria-label="$t('task.routine.settings.timezone')"
			:search-results="searchResults"
			:show-empty="true"
			class="routine-timezone__select"
			label="label"
			select-placeholder=""
			@search="query = $event"
			@update:modelValue="choose"
		/>
		<p class="routine-timezone__hint">
			{{ hint || $t('task.routine.settings.timezoneHint') }}
		</p>
	</div>
</template>

<script setup lang="ts">
import {computed, ref, useId} from 'vue'
import {useQuery} from '@tanstack/vue-query'

import Icon from '@/components/misc/Icon'
import Multiselect from '@/components/input/Multiselect.vue'
import {timezonesQuery} from '@/client/queries/account'

type ZoneOption = {value: string, label: string}

const props = defineProps<{
	modelValue: string
	disabled?: boolean
	hint?: string
}>()

const emit = defineEmits<{
	'update:modelValue': [zone: string | null],
}>()

const inputId = useId()

const zones = useQuery(timezonesQuery())
const query = ref('')

const options = computed<ZoneOption[]>(() => [...(zones.data.value ?? [])]
	.sort((a, b) => a.localeCompare(b))
	.map(value => ({
		value,
		label: value.replace(/_/g, ' '),
	})))

const searchResults = computed(() => {
	const needle = query.value.trim().toLowerCase()
	return needle === ''
		? options.value
		: options.value.filter(zone => zone.label.toLowerCase().includes(needle))
})

const selected = computed<ZoneOption>(() => ({
	value: props.modelValue,
	label: props.modelValue.replace(/_/g, ' '),
}))

// Clearing the field goes back to the default zone instead of sending an empty one.
function choose(value: ZoneOption | ZoneOption[] | null) {
	if (value === null || Array.isArray(value)) {
		emit('update:modelValue', null)
		return
	}
	emit('update:modelValue', value.value)
}
</script>

<style lang="scss" scoped>
.routine-timezone {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	min-inline-size: 0;
}

.routine-timezone__label {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.routine-timezone__icon {
	inline-size: .875rem;
	color: var(--text-tertiary);
}

.routine-timezone__select {
	max-inline-size: 22rem;
}

.routine-timezone__value {
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-md);
}

.routine-timezone__hint {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
</style>
