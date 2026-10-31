<template>
	<div class="compass-team-picker">
		<fieldset
			class="compass-team-picker__group"
			:aria-describedby="error ? errorId : undefined"
			:aria-busy="isSearching || undefined"
		>
			<legend class="compass-team-picker__legend">
				{{ t('compass.sharing.pickerLegend') }}
			</legend>
			<p
				v-if="error"
				:id="errorId"
				class="compass-team-picker__error"
				role="alert"
			>
				{{ error }}
			</p>

			<div class="compass-team-picker__search">
				<label
					:for="searchId"
					class="compass-team-picker__search-label"
				>{{ t('compass.sharing.search') }}</label>
				<div class="compass-team-picker__search-control">
					<Icon
						class="compass-team-picker__search-icon"
						icon="search"
					/>
					<!-- Enter here searches; it must not submit the surrounding form. -->
					<input
						:id="searchId"
						v-model="search"
						class="input compass-team-picker__search-input"
						type="search"
						autocomplete="off"
						:placeholder="t('compass.sharing.searchPlaceholder')"
						@keydown.enter.prevent
					>
				</div>
			</div>

			<p
				v-if="firstLoad"
				class="compass-team-picker__note"
				role="status"
			>
				{{ t('compass.sharing.loading') }}
			</p>
			<div
				v-if="loadFailed"
				class="compass-team-picker__failed"
				role="alert"
			>
				<span>{{ t('compass.sharing.loadError') }}</span>
				<XButton
					variant="tertiary"
					:shadow="false"
					@click="retry"
				>
					{{ t('misc.retry') }}
				</XButton>
			</div>

			<ul
				v-if="rows.length > 0"
				class="compass-team-picker__list"
			>
				<li
					v-for="row in rows"
					:key="row.id"
					class="compass-team-picker__item"
				>
					<label
						v-if="row.eligible"
						class="compass-team-picker__team"
						:class="{'is-selected': row.id === modelValue?.id}"
					>
						<input
							class="compass-team-picker__input"
							type="radio"
							:name="name"
							:value="row.id"
							:checked="row.id === modelValue?.id"
							@change="choose(row)"
						>
						<span class="compass-team-picker__name">{{ row.name }}</span>
						<span
							v-if="row.members > 0"
							class="compass-team-picker__meta"
						>{{ t('compass.sharing.members', row.members) }}</span>
					</label>
					<!-- Listed so the choice is understandable, but never focusable or selectable. -->
					<div
						v-else
						class="compass-team-picker__team is-ineligible"
						role="radio"
						aria-checked="false"
						aria-disabled="true"
						:aria-labelledby="`${uid}-team-${row.id}`"
						:aria-describedby="`${uid}-reason-${row.id}`"
					>
						<span
							class="compass-team-picker__fake-radio"
							aria-hidden="true"
						/>
						<span
							:id="`${uid}-team-${row.id}`"
							class="compass-team-picker__name"
						>{{ row.name }}</span>
						<span
							:id="`${uid}-reason-${row.id}`"
							class="compass-team-picker__reason"
						>
							<Icon icon="lock" />
							{{ t('compass.sharing.notAdmin') }}
						</span>
					</div>
				</li>
			</ul>

			<p
				v-if="hint"
				class="compass-team-picker__note"
			>
				{{ hint.text }}
				<RouterLink
					v-if="hint.teamsLink"
					:to="{name: 'teams.index'}"
					class="compass-team-picker__link"
				>
					{{ t('compass.sharing.manageTeams') }}
				</RouterLink>
			</p>
		</fieldset>
	</div>
</template>

<script setup lang="ts">
import {computed, ref, useId, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {refDebounced} from '@vueuse/core'
import XButton from '@/components/input/Button.vue'
import Icon from '@/components/misc/Icon'
import type {Team} from '@/client/generated'
import {PICKER_PAGE_SIZE} from '@/client/queries/pagination'
import {useTeamSearch} from '@/composables/useTeams'
import {useAuthStore} from '@/stores/auth'
import {isCompassTeamAdmin, type CompassTeamChoice} from './sharing'

type TeamRow = {
	id: number
	name: string
	// 0 when unknown (a remembered choice the current results don't include).
	members: number
	eligible: boolean
}

type SearchResults = {
	query: string
	teams: Team[]
}

type PickerHint = {
	text: string
	teamsLink: boolean
}

const props = withDefaults(defineProps<{
	modelValue: CompassTeamChoice | null
	// Radio group name; unique per form.
	name: string
	error?: string
}>(), {
	error: '',
})

const emit = defineEmits<{
	'update:modelValue': [value: CompassTeamChoice | null]
}>()

const {t} = useI18n({useScope: 'global'})
const authStore = useAuthStore()

const uid = useId()
const searchId = `${uid}-search`
const errorId = `${uid}-error`

const search = ref('')
const query = refDebounced(computed(() => search.value.trim()), 300)
const teamSearch = useTeamSearch({search: query})

// The answer and the search it belongs to, kept while the next search loads so the list does not blink.
const results = ref<SearchResults>()
watch(() => teamSearch.data.value, teams => {
	if (teams) {
		results.value = {
			query: query.value,
			teams,
		}
	}
}, {immediate: true})

const loadFailed = computed(() => teamSearch.isError.value && !teamSearch.isFetching.value)
const firstLoad = computed(() => results.value === undefined && !loadFailed.value)
const isSearching = computed(() => teamSearch.isFetching.value || search.value.trim() !== query.value)

const myId = computed(() => authStore.info?.id ?? 0)

const rows = computed<TeamRow[]>(() => {
	const list: TeamRow[] = (results.value?.teams ?? [])
		.filter(team => (team.id ?? 0) > 0)
		.map(team => ({
			id: team.id ?? 0,
			name: team.name ?? '',
			members: team.members?.length ?? 0,
			eligible: isCompassTeamAdmin(team, myId.value),
		}))
	const selected = props.modelValue
	// A choice made under an earlier search stays visible and checked.
	if (selected && !list.some(row => row.id === selected.id)) {
		list.unshift({
			id: selected.id,
			name: selected.name,
			members: 0,
			eligible: true,
		})
	}
	return [
		...list.filter(row => row.eligible),
		...list.filter(row => !row.eligible),
	]
})

// Admin rights can be gone by the time the list reloads; such a team must not stay chosen.
watch(rows, current => {
	const selected = props.modelValue
	if (selected && current.some(row => row.id === selected.id && !row.eligible)) {
		emit('update:modelValue', null)
	}
})

const hint = computed<PickerHint | null>(() => {
	const shown = results.value
	if (!shown) return null
	const total = shown.teams.length
	const searched = shown.query !== ''
	const truncated = total >= PICKER_PAGE_SIZE
	const eligible = rows.value.some(row => row.eligible)
	if (total === 0 && searched) {
		return {
			text: t('compass.sharing.noMatch', {query: shown.query}),
			teamsLink: false,
		}
	}
	if (!eligible && !searched && !truncated) {
		return {
			text: t('compass.sharing.noAdminTeams'),
			teamsLink: true,
		}
	}
	if (!eligible && truncated) {
		return {
			text: t('compass.sharing.noAdminShown'),
			teamsLink: false,
		}
	}
	if (truncated) {
		return {
			text: t('compass.sharing.firstOnly', {count: total}),
			teamsLink: false,
		}
	}
	return null
})

function choose(row: TeamRow) {
	if (!row.eligible) return
	emit('update:modelValue', {
		id: row.id,
		name: row.name,
	})
}

function retry() {
	teamSearch.refetch()
}
</script>

<style lang="scss" scoped>
.compass-team-picker {
	min-inline-size: 0;
	padding: var(--space-4);
	border: 1px solid var(--compass-rule-strong);
	border-radius: var(--radius-md);
	background: var(--surface);
}

.compass-team-picker__group {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	min-inline-size: 0;
	margin: 0;
	padding: 0;
	border: 0;
}

.compass-team-picker__legend {
	margin-block-end: var(--space-3);
	padding: 0;
	color: var(--compass-ink);
	font-size: var(--text-md);
	font-weight: var(--weight-semibold);
}

.compass-team-picker__error {
	margin: 0;
	color: var(--danger-text);
	font-size: var(--text-sm);
}

.compass-team-picker__search {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
}

.compass-team-picker__search-label {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.compass-team-picker__search-control {
	position: relative;
}

.compass-team-picker__search-icon {
	position: absolute;
	inset-block-start: 50%;
	inset-inline-start: .7rem;
	color: var(--text-tertiary);
	pointer-events: none;
	transform: translateY(-50%);
}

.compass-team-picker__search-input {
	padding-inline-start: 2.1rem;
}

.compass-team-picker__note {
	margin: 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.compass-team-picker__link {
	margin-inline-start: var(--space-1);
	color: var(--compass-accent);
	font-weight: var(--weight-medium);
	text-decoration: underline;
	text-underline-offset: .2em;

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-team-picker__failed {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-sm);
	background: var(--tint-danger);
	font-size: var(--text-sm);
}

.compass-team-picker__list {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
	border-block-start: 1px solid var(--compass-rule);
}

.compass-team-picker__item {
	border-block-end: 1px solid var(--compass-rule);
}

.compass-team-picker__team {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);
	min-block-size: 2.5rem;
	padding: var(--space-2);
	border-radius: var(--radius-sm);
	cursor: pointer;

	&:hover:not(.is-ineligible) {
		background: var(--surface-hover);
	}

	&.is-selected {
		background: var(--compass-accent-tint);
	}

	&:has(.compass-team-picker__input:focus-visible) {
		@include focus-ring;
	}

	&.is-ineligible {
		color: var(--compass-ink-soft);
		cursor: not-allowed;
	}
}

.compass-team-picker__input {
	flex: none;
	inline-size: 1rem;
	block-size: 1rem;
	margin: 0;
	accent-color: var(--compass-accent);
	cursor: pointer;

	&:focus-visible {
		outline: none;
	}
}

// Stands in for a radio that cannot be chosen: dashed, so it does not read as an empty choice.
.compass-team-picker__fake-radio {
	flex: none;
	inline-size: 1rem;
	block-size: 1rem;
	border: 1px dashed var(--border-strong);
	border-radius: var(--radius-full);
}

.compass-team-picker__name {
	flex: 1 1 8rem;
	min-inline-size: 0;
	font-weight: var(--weight-medium);
	overflow-wrap: anywhere;
}

.compass-team-picker__meta {
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
}

.compass-team-picker__reason {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
}

@media (pointer: coarse) {
	.compass-team-picker__team {
		min-block-size: var(--target-min);
	}

	.compass-team-picker__input {
		inline-size: 1.25rem;
		block-size: 1.25rem;
	}
}
</style>
