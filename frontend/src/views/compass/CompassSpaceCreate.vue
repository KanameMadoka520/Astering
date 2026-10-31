<template>
	<CompassThemeScope
		:theme="theme"
		class="compass-create"
	>
		<header class="compass-create__header">
			<h1 class="compass-create__title">
				{{ t('compass.create.title') }}
			</h1>
			<p class="compass-create__lead">
				{{ t('compass.create.lead') }}
			</p>
		</header>

		<div class="compass-create__layout">
			<form
				class="compass-create__form"
				novalidate
				@submit.prevent="submit"
			>
				<FormField
					ref="titleField"
					v-model="title"
					:label="t('compass.settings.field.name')"
					:error="titleError"
					:maxlength="COMPASS_LIMITS.spaceTitle"
					type="text"
					autocomplete="off"
					required
				/>

				<FormField
					:label="t('compass.settings.field.motto')"
					:error="mottoError"
				>
					<template #default="{id, errorId}">
						<textarea
							:id="id"
							ref="mottoInput"
							v-model="motto"
							class="textarea compass-create__motto"
							rows="3"
							:maxlength="COMPASS_LIMITS.motto"
							:placeholder="t('compass.settings.field.mottoPlaceholder')"
							:aria-invalid="mottoError ? true : undefined"
							:aria-describedby="[mottoHintId, errorId].filter(Boolean).join(' ')"
						/>
						<p
							:id="mottoHintId"
							class="compass-create__hint"
						>
							<span>{{ t('compass.settings.field.mottoHint') }}</span>
							<span class="compass-create__count">
								{{ mottoCount }}
							</span>
						</p>
					</template>
				</FormField>

				<div class="compass-create__group">
					<CompassThemePicker
						v-model="theme"
						:label="t('compass.settings.field.theme')"
						name="compass-space-theme"
						:aria-describedby="themeHintId"
					/>
					<p
						:id="themeHintId"
						class="compass-create__hint"
					>
						{{ t('compass.settings.field.themeHint') }}
					</p>
				</div>

				<CompassSharingChoice
					v-model="sharing"
					v-model:team="team"
					name="compass-space-sharing"
					:team-error="teamError"
				/>

				<Message
					v-if="formError"
					variant="danger"
				>
					{{ formError }}
				</Message>

				<div class="compass-create__actions">
					<XButton
						variant="secondary"
						:shadow="false"
						@click="cancel"
					>
						{{ t('misc.cancel') }}
					</XButton>
					<!-- loading soft-disables it: the button keeps focus while the space is created. -->
					<XButton
						type="submit"
						variant="primary"
						:shadow="false"
						:loading="isCreating"
					>
						{{ t('compass.create.submit') }}
					</XButton>
				</div>
			</form>

			<div class="compass-create__preview">
				<CompassSpacePreview
					:title="title"
					:motto="motto"
					:theme="theme"
					:sharing="sharing"
					:team-name="team?.name ?? ''"
				/>
			</div>
		</div>
	</CompassThemeScope>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, useId, useTemplateRef} from 'vue'
import {useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'

import XButton from '@/components/input/Button.vue'
import FormField from '@/components/input/FormField.vue'
import Message from '@/components/misc/Message.vue'
import CompassThemePicker from '@/components/compass/base/CompassThemePicker.vue'
import CompassThemeScope from '@/components/compass/base/CompassThemeScope.vue'
import CompassSharingChoice from '@/components/compass/settings/CompassSharingChoice.vue'
import CompassSpacePreview from '@/components/compass/settings/CompassSpacePreview.vue'
import type {CompassSharing, CompassTeamChoice} from '@/components/compass/settings/sharing'

import {useCreateCompassSpaceMutation, type CompassSpace} from '@/client/queries/compass'
import {useTitle} from '@/composables/useTitle'
import {
	COMPASS_DEFAULT_THEME,
	COMPASS_LIMITS,
	runeLength,
	type CompassTheme,
} from '@/helpers/compass/constants'
import {classifyCompassFailure, type CompassFailure} from '@/helpers/compass/errors'
import {getErrorText} from '@/message'

const {t} = useI18n({useScope: 'global'})
const router = useRouter()

useTitle(() => t('compass.create.title'))

const uid = useId()
const mottoHintId = `${uid}-motto-hint`
const themeHintId = `${uid}-theme-hint`

const title = ref(t('compass.create.defaultTitle'))
const motto = ref('')
const theme = ref<CompassTheme>(COMPASS_DEFAULT_THEME)
// Private unless the person deliberately picks a team.
const sharing = ref<CompassSharing>('personal')
const team = ref<CompassTeamChoice | null>(null)

const titleField = useTemplateRef<InstanceType<typeof FormField>>('titleField')
const mottoInput = useTemplateRef<HTMLTextAreaElement>('mottoInput')

// "Required" waits for the first submit; length limits show as soon as they are crossed.
const attempted = ref(false)
const formError = ref('')

const trimmedTitle = computed(() => title.value.trim())
const trimmedMotto = computed(() => motto.value.trim())
const mottoLength = computed(() => runeLength(trimmedMotto.value))
const mottoCount = computed(() => t('compass.settings.field.count', {
	count: mottoLength.value,
	max: COMPASS_LIMITS.motto,
}))

const titleError = computed(() => {
	if (trimmedTitle.value === '') {
		return attempted.value ? t('compass.settings.field.nameRequired') : ''
	}
	return runeLength(trimmedTitle.value) > COMPASS_LIMITS.spaceTitle
		? t('compass.settings.field.nameTooLong', {max: COMPASS_LIMITS.spaceTitle})
		: ''
})

const mottoError = computed(() => mottoLength.value > COMPASS_LIMITS.motto
	? t('compass.settings.field.mottoTooLong', {max: COMPASS_LIMITS.motto})
	: '')

const teamError = computed(() => attempted.value && sharing.value === 'team' && team.value === null
	? t('compass.sharing.teamRequired')
	: '')

const create = useCreateCompassSpaceMutation()
// Set from the answer until the space page has opened: a click in between would create a second space.
const opening = ref(false)
const isCreating = computed(() => create.isPending.value || opening.value)

// The page can be left while the request runs; its answer must not pull the person back.
let active = true
onBeforeUnmount(() => {
	active = false
})

function failureText(failure: CompassFailure, cause: unknown, shared: boolean): string {
	if (failure === 'forbidden' && shared) return t('compass.create.forbiddenTeam')
	if (failure === 'network') return t('compass.create.network')
	return t('compass.create.failed', {reason: getErrorText(cause)})
}

async function submit() {
	if (isCreating.value) return
	attempted.value = true
	formError.value = ''
	if (titleError.value) {
		titleField.value?.focus()
		return
	}
	if (mottoError.value) {
		mottoInput.value?.focus()
		return
	}
	if (teamError.value) return

	const teamId = sharing.value === 'team' ? (team.value?.id ?? 0) : 0
	let space: CompassSpace
	try {
		space = await create.mutateAsync({
			title: trimmedTitle.value,
			motto: trimmedMotto.value,
			introduction: '',
			theme: theme.value,
			team_id: teamId,
		})
	} catch (cause) {
		const failure = classifyCompassFailure(cause)
		if (failure === 'aborted' || !active) return
		formError.value = failureText(failure, cause, teamId > 0)
		return
	}
	if (!active) return
	opening.value = true
	const navigationFailure = await router.push(space.id > 0
		? {
			name: 'compass.space',
			params: {spaceId: space.id},
		}
		: {name: 'compass.index'})
	if (navigationFailure && active) opening.value = false
}

function cancel() {
	// router.back() does nothing when this page opened a fresh tab.
	if (router.options.history.state.back) {
		router.back()
		return
	}
	router.push({name: 'compass.index'})
}
</script>

<style lang="scss" scoped>
.compass-create {
	container-type: inline-size;
	max-inline-size: 70rem;
	margin-inline: auto;
}

.compass-create__header {
	max-inline-size: 40rem;
	margin-block-end: var(--space-6);
}

.compass-create__title {
	margin: 0;
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: clamp(1.6rem, 1.3rem + 1.2vw, 2.1rem);
	font-weight: var(--weight-semibold);
	line-height: 1.2;
	letter-spacing: .005em;
}

.compass-create__lead {
	margin-block: var(--space-2) 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-base);
	line-height: 1.7;
}

.compass-create__layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--space-6);
}

.compass-create__form {
	display: flex;
	flex-direction: column;
	gap: var(--space-6);
	min-inline-size: 0;
	max-inline-size: 40rem;

	:deep(.field) {
		margin-block-end: 0;
	}
}

// Stacked: the preview comes first so the sky sits right under the heading while typing.
.compass-create__preview {
	order: -1;
	min-inline-size: 0;
	max-inline-size: 40rem;
}

@container (min-width: 54rem) {
	.compass-create__layout {
		grid-template-columns: minmax(0, 40rem) minmax(15rem, 1fr);
		align-items: start;
		gap: var(--space-8);
	}

	.compass-create__preview {
		position: sticky;
		inset-block-start: calc(var(--header-height) + var(--space-6));
		order: 0;
		max-inline-size: none;
	}
}

.compass-create__motto {
	min-block-size: 5.5rem;
	resize: vertical;
}

.compass-create__group {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
}

.compass-create__hint {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: var(--space-1) var(--space-3);
	margin: var(--space-1) 0 0;
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.compass-create__count {
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.compass-create__actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: var(--space-2);
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--compass-rule);
}
</style>
