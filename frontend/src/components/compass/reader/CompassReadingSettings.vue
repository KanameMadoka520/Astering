<template>
	<Dropdown class="compass-reading-settings">
		<template #trigger="{toggleOpen, open}">
			<BaseButton
				class="compass-tool"
				:aria-expanded="open"
				@click="toggleOpen"
			>
				<Icon
					icon="font"
					aria-hidden="true"
				/>
				<span class="compass-tool__label">{{ t('compass.readingPrefs.title') }}</span>
			</BaseButton>
		</template>

		<div class="compass-reading-settings__panel">
			<p class="compass-reading-settings__title">
				{{ t('compass.readingPrefs.title') }}
			</p>
			<div class="compass-reading-settings__field">
				<span
					class="compass-reading-settings__label"
					aria-hidden="true"
				>{{ t('compass.readingPrefs.typeface') }}</span>
				<SegmentedControl
					:model-value="prefs.font"
					:options="fontOptions"
					:label="t('compass.readingPrefs.typeface')"
					@update:modelValue="font => emit('update', {font})"
				/>
			</div>
			<div class="compass-reading-settings__field">
				<span
					class="compass-reading-settings__label"
					aria-hidden="true"
				>{{ t('compass.readingPrefs.size') }}</span>
				<SegmentedControl
					:model-value="prefs.size"
					:options="sizeOptions"
					:label="t('compass.readingPrefs.size')"
					@update:modelValue="size => emit('update', {size})"
				/>
			</div>
			<p
				class="compass-reading-settings__sample"
				:class="[
					`compass-reading-settings__sample--${prefs.font}`,
					`compass-reading-settings__sample--${prefs.size}`,
				]"
				aria-hidden="true"
			>
				{{ t('compass.readingPrefs.sample') }}
			</p>
		</div>
	</Dropdown>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import BaseButton from '@/components/base/BaseButton.vue'
import SegmentedControl, {type SegmentedOption} from '@/components/input/SegmentedControl.vue'
import Dropdown from '@/components/misc/Dropdown.vue'
import Icon from '@/components/misc/Icon'
import {
	COMPASS_READING_FONTS,
	COMPASS_READING_SIZES,
	type CompassReadingFont,
	type CompassReadingPrefs,
	type CompassReadingSize,
} from '@/helpers/compass/storage'

defineProps<{
	prefs: CompassReadingPrefs
}>()

const emit = defineEmits<{
	update: [change: Partial<CompassReadingPrefs>]
}>()

const {t} = useI18n({useScope: 'global'})

const fontOptions = computed<SegmentedOption<CompassReadingFont>[]>(() => COMPASS_READING_FONTS.map(font => ({
	value: font,
	label: t(`compass.readingPrefs.font.${font}`),
})))

const sizeOptions = computed<SegmentedOption<CompassReadingSize>[]>(() => COMPASS_READING_SIZES.map(size => ({
	value: size,
	label: t(`compass.readingPrefs.sizes.${size}`),
})))
</script>

<style lang="scss" scoped>
.compass-reading-settings__panel {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	inline-size: min(18rem, calc(100vw - 2rem));
	padding: var(--space-2);
}

.compass-reading-settings__title {
	margin: 0;
	color: var(--text-strong);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
}

.compass-reading-settings__field {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
}

.compass-reading-settings__label {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

// A line in the chosen face and size, so the choice is seen before the page reflows.
.compass-reading-settings__sample {
	margin: 0;
	padding-block-start: var(--space-3);
	border-block-start: 1px solid var(--border-subtle);
	color: var(--text-primary);
	font-family: var(--compass-serif);
	font-size: 1.0625rem;
	line-height: 1.7;

	&--sans {
		font-family: var(--compass-sans);
	}

	&--small {
		font-size: .95rem;
	}

	&--large {
		font-size: 1.2rem;
	}
}
</style>
