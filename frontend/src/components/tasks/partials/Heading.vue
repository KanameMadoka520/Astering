<template>
	<div class="heading">
		<div class="task-properties">
			<ColorBubble
				v-if="task.hex_color !== ''"
				:color="getHexColor(task.hex_color)"
			/>
			<BaseButton
				v-tooltip="$t('task.detail.copyLink')"
				class="task-id-chip"
				@click="copyUrl"
			>
				<span class="title task-id">
					{{ textIdentifier }}
				</span>
				<Icon
					icon="link"
					class="task-id-chip__icon"
				/>
				<span class="is-sr-only">{{ $t('task.detail.copyLink') }}</span>
			</BaseButton>
			<Done
				:is-done="task.done"
			/>
			<span
				class="heading__save-status"
				role="status"
			>
				<CustomTransition name="fade">
					<span
						v-if="loading && saving"
						class="heading__save-state"
					>
						<span class="loader is-inline-block" />
						{{ $t('misc.saving') }}
					</span>
					<span
						v-else-if="!loading && showSavedMessage"
						class="heading__save-state has-text-success"
					>
						<Icon icon="check" />
						{{ $t('misc.saved') }}
					</span>
				</CustomTransition>
			</span>
			<BaseButton
				v-if="hasClose"
				:aria-label="$t('task.detail.closeTaskDetail')"
				class="close d-print-none"
				@click="$emit('close')"
			>
				<Icon icon="times" />
			</BaseButton>
		</div>
		<!-- The text is written by showServerTitle, so a title being typed survives a re-render. -->
		<h1
			ref="titleElement"
			class="title input"
			:class="{'disabled': !canWrite}"
			:contenteditable="canWrite ? true : undefined"
			:tabindex="canWrite ? 0 : undefined"
			:spellcheck="false"
			@input="handleTitleInput"
			@blur="save($event.target as HTMLElement)"
			@keydown.enter.prevent.stop="!$event.isComposing && ($event.target as HTMLInputElement).blur()"
			@keydown.esc.prevent.stop="!$event.isComposing && cancel($event.target as HTMLInputElement)"
		/>
	</div>
</template>

<script setup lang="ts">
import {ref, computed, onMounted, onBeforeUnmount, useTemplateRef, watch} from 'vue'
import {useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'

import {error} from '@/message'
import BaseButton from '@/components/base/BaseButton.vue'
import CustomTransition from '@/components/misc/CustomTransition.vue'
import ColorBubble from '@/components/misc/ColorBubble.vue'
import Done from '@/components/misc/Done.vue'

import {useCopyToClipboard} from '@/composables/useCopyToClipboard'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {useUpdateTaskMutation} from '@/client/queries/taskMutations'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'

import type {Task as ITask} from '@/client/generated'
import {getHexColor, getTaskIdentifier} from '@/helpers/task'

const props = defineProps<{
	task: ITask,
	canWrite: boolean,
	hasClose: boolean,
}>()

const emit = defineEmits<{
	'update:task': [task: ITask],
	'close': [],
}>()

const router = useRouter()
const copy = useCopyToClipboard()
const {t} = useI18n({useScope: 'global'})

async function copyUrl() {
	const route = router.resolve({name: 'task.detail', query: {taskId: props.task.id}})
	const absoluteURL = new URL(route.href, window.location.href).href

	await copy(absoluteURL)
}

const updateTask = useUpdateTaskMutation()
const loading = useDelayedLoading(updateTask.isPending)
// A title typed for one account is never sent once the session ended or another account signed in.
const owner = captureClientRequestContext()

const textIdentifier = computed(() => getTaskIdentifier(props.task))

// Since loading is global state, this variable ensures we're only showing the saving icon when saving the description.
const saving = ref(false)

const showSavedMessage = ref(false)

// Track if title has unsaved changes
const titleHasChanges = ref(false)

function handleBeforeUnload(e: BeforeUnloadEvent) {
	if (titleHasChanges.value) {
		e.preventDefault()
		// Modern browsers ignore custom messages but this is still required
		e.returnValue = ''
		return ''
	}
}

onMounted(() => {
	window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
	window.removeEventListener('beforeunload', handleBeforeUnload)
})

const titleElement = useTemplateRef<HTMLElement>('titleElement')

// A title being typed keeps its text; otherwise the heading shows the latest server title.
function showServerTitle() {
	const element = titleElement.value
	if (!element || titleHasChanges.value) return
	const title = (props.task.title ?? '').trim()
	if (element.textContent !== title) element.textContent = title
}

watch(() => props.task.id, () => {
	titleHasChanges.value = false
})
watch([() => props.task.id, () => props.task.title, titleElement], showServerTitle, {flush: 'post'})

function handleTitleInput(event: Event) {
	const target = event.target as HTMLInputElement
	titleHasChanges.value = target.textContent !== (props.task.title ?? '')
}

type TitleSaveOutcome = 'none' | 'saved' | 'failed'

async function save(element: HTMLElement): Promise<TitleSaveOutcome> {
	// An untouched heading has nothing to save, even if the server title changed while it had focus.
	if (!titleHasChanges.value) {
		showServerTitle()
		return 'none'
	}

	const title = element.textContent ?? ''

	// An empty title would be discarded by the api, so revert and tell the user instead of failing silently.
	if (title.trim() === '') {
		titleHasChanges.value = false
		showServerTitle()
		error({message: t('task.detail.titleRequired')})
		return 'failed'
	}

	// We only want to save if the title was actually changed.
	// so we only continue if the task title changed.
	if (title === props.task.title) {
		titleHasChanges.value = false
		return 'none'
	}

	const taskId = props.task.id!
	if (!isClientRequestContextCurrent(owner)) return 'failed'
	try {
		saving.value = true
		// Only the title: the rest of this copy may be older than what the server holds.
		const newTask = await updateTask.mutateAsync({
			id: taskId,
			title,
		})
		if (props.task.id !== taskId) return 'saved'
		emit('update:task', newTask)
		// The heading picks up the saved title once the cache update reaches the task prop.
		if (element.textContent === title) titleHasChanges.value = false
		if (props.task.title === newTask.title) showServerTitle()
		showSavedMessage.value = true
		setTimeout(() => {
			showSavedMessage.value = false
		}, 2000)
		return 'saved'
	} catch {
		// The mutation already reported the failure; the typed title stays for another try.
		return 'failed'
	} finally {
		saving.value = false
	}
}

/** Saves a title that is still being typed (the save shortcut); 'none' when there was nothing to send. */
function flush(): Promise<TitleSaveOutcome> {
	const element = titleElement.value
	return element ? save(element) : Promise.resolve('none')
}

defineExpose({flush})

async function cancel(element: HTMLInputElement) {
	titleHasChanges.value = false
	showServerTitle()
	element.blur()
}
</script>

<style lang="scss" scoped>
.heading {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	min-inline-size: 0;
	text-transform: none;
}

.task-properties {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
}

.color-bubble {
	block-size: .625rem;
	inline-size: .625rem;
	flex-shrink: 0;
}

.task-id-chip {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: var(--target-min);
	padding-inline: var(--space-2);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	background: var(--surface);
	color: var(--text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		border-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		border-color: var(--border-strong);
		background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.title.task-id {
	margin: 0;
	font-family: var(--font-mono);
	font-size: var(--text-xs);
	font-weight: var(--weight-medium);
	line-height: 1;
	color: inherit;
	white-space: nowrap;
}

.task-id-chip__icon {
	font-size: var(--text-2xs);
	color: var(--text-tertiary);
}

// Done.vue paints a large solid block for lists; the heading only needs a status chip.
.task-properties :deep(.is-done) {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: var(--target-min);
	padding: 0 var(--space-2);
	border: 1px solid hsla(var(--success-h), var(--success-s), var(--success-l), .45);
	border-radius: var(--radius-full);
	background: var(--tint-success);
	color: var(--text-primary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	line-height: 1;

	&::before {
		content: '';
		inline-size: .5rem;
		block-size: .5rem;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--success) 70%, var(--text-primary));
	}
}

.heading__save-status {
	display: inline-flex;
	font-size: var(--text-xs);
	color: var(--text-secondary);
}

.heading__save-state {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);

	.loader {
		inline-size: .75rem;
		block-size: .75rem;
	}
}

.title {
	margin-block-end: 0;
}

.title.input {
	block-size: auto;
	min-block-size: calc(var(--text-2xl) * var(--leading-tight) + var(--space-2) + 2px);
	margin: 0 calc(-1 * var(--space-2));
	padding: var(--space-1) var(--space-2);
	border: 1px solid transparent;
	border-radius: $radius;
	background: transparent;
	box-shadow: none;
	color: var(--text-primary);
	font-size: var(--text-2xl);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
	overflow-wrap: anywhere;
	white-space: normal;
	cursor: text;
	transition: border-color var(--motion-fast) var(--ease-standard);

	&:not(.disabled):hover {
		border-color: var(--border-default);
	}

	// The keyboard ring comes from the global .user-is-tabbing .input:focus rule.
	&:focus {
		border-color: var(--input-border-color);
		box-shadow: none;
	}

	&.disabled {
		cursor: default;
	}

	@media screen and (max-width: $tablet) {
		font-size: var(--text-xl);
		min-block-size: calc(var(--text-xl) * var(--leading-tight) + var(--space-2) + 2px);
	}
}

// Modal renders its own fixed close button from $tablet up
.close {
	display: none;
	margin-inline-start: auto;
	align-items: center;
	justify-content: center;
	inline-size: max(2.25rem, var(--target-min));
	block-size: max(2.25rem, var(--target-min));
	border-radius: $radius;
	color: var(--text-secondary);
	font-size: var(--text-xl);

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	@media screen and (max-width: $tablet) {
		display: inline-flex;
	}
}
</style>
