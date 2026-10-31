<template>
	<Dropdown class="compass-switcher">
		<template #trigger="{toggleOpen, open}">
			<XButton
				variant="secondary"
				:shadow="false"
				:aria-expanded="open"
				@click="toggleOpen"
			>
				{{ t('compass.switcher.label') }}
				<Icon
					icon="chevron-down"
					class="compass-switcher__chevron"
				/>
			</XButton>
		</template>
		<template #default="{close}">
			<div
				class="compass-switcher__menu"
				@click="close"
			>
				<p
					v-if="isPending && spaces.length === 0"
					class="compass-switcher__note"
				>
					{{ t('compass.switcher.loading') }}
				</p>
				<template
					v-for="group in groups"
					:key="group.key"
				>
					<p
						v-if="showGroupLabels"
						class="compass-switcher__group"
					>
						{{ group.label }}
					</p>
					<DropdownItem
						v-for="space in group.spaces"
						:key="space.id"
						:to="{name: 'compass.space', params: {spaceId: space.id}}"
						:class="{'is-active': space.id === currentSpaceId}"
						:aria-current="space.id === currentSpaceId ? 'page' : undefined"
					>
						<span class="compass-switcher__item">
							<Icon
								:icon="space.team_id > 0 ? 'users' : 'lock'"
								class="compass-switcher__kind"
							/>
							<span class="compass-switcher__title">{{ space.title }}</span>
							<span
								v-if="space.team_id > 0"
								class="is-sr-only"
							>{{ t('compass.switcher.teamSpace') }}</span>
							<Icon
								v-if="space.id === currentSpaceId"
								icon="check"
								class="compass-switcher__check"
							/>
						</span>
					</DropdownItem>
				</template>
				<hr class="compass-switcher__divider">
				<DropdownItem
					icon="plus"
					:to="{name: 'compass.space.new'}"
				>
					{{ t('compass.switcher.new') }}
				</DropdownItem>
			</div>
		</template>
	</Dropdown>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import XButton from '@/components/input/Button.vue'
import Dropdown from '@/components/misc/Dropdown.vue'
import DropdownItem from '@/components/misc/DropdownItem.vue'
import Icon from '@/components/misc/Icon'
import {useCompassSpaces} from '@/composables/useCompass'

defineProps<{
	currentSpaceId: number
}>()

const {t} = useI18n({useScope: 'global'})
const {spaces, isPending} = useCompassSpaces()

const groups = computed(() => [
	{
		key: 'personal',
		label: t('compass.space.personal'),
		spaces: spaces.value.filter(space => space.team_id === 0),
	},
	{
		key: 'team',
		label: t('compass.switcher.shared'),
		spaces: spaces.value.filter(space => space.team_id > 0),
	},
].filter(group => group.spaces.length > 0))

const showGroupLabels = computed(() => groups.value.length > 1)
</script>

<style lang="scss" scoped>
.compass-switcher__chevron {
	inline-size: .75em;
	margin-inline-start: var(--space-1);
	color: var(--text-tertiary);
}

.compass-switcher__menu {
	min-inline-size: 14rem;
}

.compass-switcher__group,
.compass-switcher__note {
	padding: var(--space-2) var(--space-3) var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .03em;
}

.compass-switcher__note {
	font-weight: var(--weight-regular);
}

.compass-switcher__item {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	max-inline-size: min(20rem, calc(100vw - 4rem));
}

.compass-switcher__kind {
	flex: none;
	inline-size: .875em;
	color: var(--text-tertiary);
}

.compass-switcher__title {
	flex: 1 1 auto;
	min-inline-size: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.compass-switcher__check {
	flex: none;
	inline-size: .875em;
	margin-inline-start: auto;
	padding-inline-start: var(--space-2);
}

.compass-switcher__divider {
	block-size: 1px;
	margin: .3rem -.3rem;
	border: 0;
	background-color: var(--border-subtle);
}
</style>
