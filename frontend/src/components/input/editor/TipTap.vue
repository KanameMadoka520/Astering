<template>
	<div
		ref="tiptapInstanceRef"
		class="tiptap"
	>
		<div
			class="tiptap__wrapper"
			:class="{'tiptap__wrapper-is-editing': isEditing}"
		>
			<!-- Using v-show instead of v-if to avoid unmounting which causes race condition
			 with tiptap's DOM manipulation. See: https://github.com/ueberdosis/tiptap/issues/7342 -->
			<EditorToolbar
				v-if="editor"
				v-show="isEditing"
				:editor="editor"
				:allow-images="allowImages"
				:allow-task-lists="allowTaskLists"
				@imageUploadClicked="triggerImageInput"
			/>
			<BubbleMenu
				v-if="editor"
				v-show="isEditing"
				:editor="editor"
				:options="bubbleMenuOptions"
				:should-show="showTextBubbleMenu"
			>
				<div class="editor-bubble__wrapper">
					<BaseButton
						v-tooltip="$t('input.editor.bold')"
						:aria-label="$t('input.editor.bold')"
						class="editor-bubble__button"
						:class="{ 'is-active': editor.isActive('bold') }"
						:aria-pressed="editor.isActive('bold')"
						@click="() => editor?.chain().focus().toggleBold().run()"
					>
						<Icon :icon="['fas', 'bold']" />
					</BaseButton>
					<BaseButton
						v-tooltip="$t('input.editor.italic')"
						:aria-label="$t('input.editor.italic')"
						class="editor-bubble__button"
						:class="{ 'is-active': editor.isActive('italic') }"
						:aria-pressed="editor.isActive('italic')"
						@click="() => editor?.chain().focus().toggleItalic().run()"
					>
						<Icon :icon="['fas', 'italic']" />
					</BaseButton>
					<BaseButton
						v-tooltip="$t('input.editor.underline')"
						:aria-label="$t('input.editor.underline')"
						class="editor-bubble__button"
						:class="{ 'is-active': editor.isActive('underline') }"
						:aria-pressed="editor.isActive('underline')"
						@click="() => editor?.chain().focus().toggleUnderline().run()"
					>
						<Icon :icon="['fas', 'underline']" />
					</BaseButton>
					<BaseButton
						v-tooltip="$t('input.editor.strikethrough')"
						:aria-label="$t('input.editor.strikethrough')"
						class="editor-bubble__button"
						:class="{ 'is-active': editor.isActive('strike') }"
						:aria-pressed="editor.isActive('strike')"
						@click="() => editor?.chain().focus().toggleStrike().run()"
					>
						<Icon :icon="['fas', 'strikethrough']" />
					</BaseButton>
					<BaseButton
						v-tooltip="$t('input.editor.code')"
						:aria-label="$t('input.editor.code')"
						class="editor-bubble__button"
						:class="{ 'is-active': editor.isActive('code') }"
						:aria-pressed="editor.isActive('code')"
						@click="() => editor?.chain().focus().toggleCode().run()"
					>
						<Icon :icon="['fas', 'code']" />
					</BaseButton>
					<BaseButton
						v-tooltip="$t('input.editor.link')"
						:aria-label="$t('input.editor.link')"
						class="editor-bubble__button"
						:class="{ 'is-active': editor.isActive('link') }"
						@click="setLink"
					>
						<Icon :icon="['fas', 'link']" />
					</BaseButton>
				</div>
			</BubbleMenu>
			<BubbleMenu
				v-if="editor"
				v-show="isEditing"
				plugin-key="imageBubbleMenu"
				:editor="editor"
				:options="bubbleMenuOptions"
				:should-show="showImageBubbleMenu"
			>
				<div class="editor-bubble__wrapper">
					<BaseButton
						class="editor-bubble__button editor-bubble__button--text"
						@click="setImageAlt"
					>
						{{ $t('input.editor.altText') }}
					</BaseButton>
					<template v-if="imageSource">
						<BaseButton
							class="editor-bubble__button editor-bubble__button--text"
							@click="setImageCaption"
						>
							{{ $t('input.editor.caption') }}
						</BaseButton>
						<BaseButton
							v-if="imageSource.replace"
							class="editor-bubble__button editor-bubble__button--text"
							@click="replaceImage"
						>
							{{ $t('input.editor.replaceImage') }}
						</BaseButton>
						<BaseButton
							class="editor-bubble__button editor-bubble__button--text"
							@click="removeImage"
						>
							{{ $t('input.editor.removeImage') }}
						</BaseButton>
					</template>
				</div>
			</BubbleMenu>

			<DrivePicker
				v-if="driveOpen"
				images
				:busy="attachDrive.isPending.value"
				@close="driveOpen = false"
				@select="insertDriveImage"
			/>
			<EditorContent
				class="tiptap__editor"
				data-user-content
				:class="{'tiptap__editor-is-edit-enabled': isEditing}"
				:editor="editor"
				@dblclick="setEditIfApplicable"
				@click="handleContentClick"
			/>

			<ImageLightbox
				v-if="lightboxBlobUrl !== null"
				:key="lightboxBlobUrl"
				:blob-url="lightboxBlobUrl"
				:alt="lightboxAlt"
				@close="closeLightbox"
			/>
		</div>

		<input
			v-if="isEditing"
			id="tiptap__image-upload"
			ref="uploadInputRef"
			type="file"
			class="is-hidden"
			:accept="imageSource?.accept"
			:multiple="imageSource !== undefined"
			@change="addImage"
		>

		<ul
			v-if="bottomActions.length === 0 && !isEditing && isEditEnabled"
			class="tiptap__editor-actions d-print-none"
		>
			<li>
				<BaseButton
					class="done-edit"
					@click="() => setEdit()"
				>
					<Icon icon="pen" />
					{{ $t('input.editor.edit') }}
				</BaseButton>
			</li>
		</ul>
		<ul
			v-if="bottomActions.length > 0"
			class="tiptap__editor-actions d-print-none"
		>
			<li v-if="isEditing && showSave">
				<BaseButton
					class="done-edit"
					@click="bubbleSave"
				>
					{{ $t('misc.save') }}
				</BaseButton>
			</li>
			<li v-if="!isEditing">
				<BaseButton
					class="done-edit"
					@click="() => setEdit()"
				>
					{{ $t('input.editor.edit') }}
				</BaseButton>
			</li>
			<li
				v-for="(action, k) in bottomActions"
				:key="k"
			>
				<BaseButton @click="action.action">
					{{ action.title }}
				</BaseButton>
			</li>
		</ul>
		<div
			v-if="isEditing && (hasSaveButton || driveTaskId)"
			class="tiptap__footer d-print-none"
		>
			<XButton
				v-if="hasSaveButton"
				v-cy="'saveEditor'"
				variant="secondary"
				class="is-small"
				:shadow="false"
				:disabled="!contentHasChanged"
				@click="bubbleSave"
			>
				{{ $t('misc.save') }}
			</XButton>
			<XButton
				v-if="driveTaskId"
				variant="tertiary"
				class="is-small"
				icon="folder"
				@click="driveOpen = true"
			>
				{{ $t('drive.insertImage') }}
			</XButton>
		</div>
	</div>
</template>

<script setup lang="ts">
import DrivePicker from '@/components/drive/DrivePicker.vue'
import {useAttachDriveMutation, type DriveEntry} from '@/client/queries/drive'
import {generateAttachmentUrl} from '@/helpers/attachments'
import {computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect} from 'vue'
import {useI18n} from 'vue-i18n'
import {eventToShortcutString} from '@/helpers/shortcut'

import EditorToolbar from './EditorToolbar.vue'

import {Extension, isTextSelection, mergeAttributes, type SetContentOptions} from '@tiptap/core'
import {EditorContent, type Extensions, useEditor, VueNodeViewRenderer} from '@tiptap/vue-3'
import type {EditorState} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {BubbleMenu} from '@tiptap/vue-3/menus'
import type {MiddlewareState} from '@floating-ui/dom'

import Mention from '@tiptap/extension-mention'

import {taskLinkCurrentProjectIdKey} from './taskLinkContext'
import {createEditorExtensions} from './editorExtensions'
import mentionSuggestionSetup from './mention/mentionSuggestion'
import MentionUser from './mention/MentionUser.vue'
import ImageLightbox from '@/components/misc/ImageLightbox.vue'

import type {BottomAction, EditorImageSource, UploadCallback} from './types'
import BaseButton from '@/components/base/BaseButton.vue'
import XButton from '@/components/input/Button.vue'

import {isEditorContentEmpty} from '@/helpers/editorContentEmpty'
import inputPrompt from '@/helpers/inputPrompt'
import {getScrollParent} from '@/helpers/getScrollParent'
import {setLinkInEditor} from '@/components/input/editor/setLinkInEditor'
import {getViewportBelowNavbar} from '@/components/input/editor/popupContainer'
import {captureClientRequestContext} from '@/client/requestContext'
import {saveEditorDraft, loadEditorDraft, clearEditorDraft, captureEditorDraftLease} from '@/helpers/editorDraftStorage'
import {error} from '@/message'

const props = withDefaults(defineProps<{
	uploadCallback?: UploadCallback,
allowImages?: boolean,
allowTaskLists?: boolean,
 driveTaskId?: number,
	isEditEnabled?: boolean,
	bottomActions?: BottomAction[],
	showSave?: boolean,
	placeholder?: string,
	editShortcut?: string,
	enableDiscardShortcut?: boolean,
	enableMentions?: boolean,
	projectId?: number,
	storageKey?: string,
	// A writing surface that never falls back to preview (Compass editor); saving is the parent's job.
	alwaysEditing?: boolean,
	// Images that are not task attachments (Compass): their node, picker and uploads.
	imageSource?: EditorImageSource,
}>(), {
	uploadCallback: undefined,
	allowImages: true,
	allowTaskLists: true,
	driveTaskId: undefined,
	isEditEnabled: true,
	bottomActions: () => [],
	showSave: false,
	placeholder: '',
	editShortcut: '',
	enableDiscardShortcut: false,
	enableMentions: false,
	projectId: 0,
	storageKey: '',
	alwaysEditing: false,
	imageSource: undefined,
})

const emit = defineEmits(['save', 'discard'])
// A mounted editor keeps its original lease even if a later account opens the same task id.
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const draftLease = captureEditorDraftLease(props.storageKey)

provide(taskLinkCurrentProjectIdKey, computed(() => props.projectId || undefined))

const modelValue = defineModel<string>({ default: '' })

const tiptapInstanceRef = ref<HTMLInputElement | null>(null)

const {t} = useI18n()

const defaultSetContentOptions: SetContentOptions = {
	parseOptions: {
		preserveWhitespace: true,
	},
}

type Mode = 'edit' | 'preview'

const internalMode = ref<Mode>('preview')
const isEditing = computed(() => (props.alwaysEditing || internalMode.value === 'edit') && props.isEditEnabled)
// Editors with bottom actions (comments) render their Save inside that list instead.
const hasSaveButton = computed(() => props.showSave && props.bottomActions.length === 0)
const contentHasChanged = ref<boolean>(false)

// TipTap crashes when inserting an image into an empty editor.
// To work around this, we're inserting an element first, then insert the image, then remove the element.
const UPLOAD_PLACEHOLDER_ELEMENT = '<p>UPLOAD_PLACEHOLDER</p>'

let lastSavedState = ''

watch(
	modelValue,
	(newValue) => {
		if (!contentHasChanged.value) {
			lastSavedState = newValue
		}
	},
	{ immediate: true },
)

watch(
	internalMode,
	mode => {
		if (mode === 'preview') {
			contentHasChanged.value = false
		}
	},
)

// Schema capabilities are fixed for this editor instance, just like enableMentions below.
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const extensions: Extensions = createEditorExtensions({
	t,
	isEditing,
	isEditEnabled: () => props.isEditEnabled,
	placeholder: () => props.placeholder,
	contentHasChanged,
	bubbleSave,
	getEditor: () => editor.value,
	uploadCallback: () => props.uploadCallback,
	uploadAndInsertFiles,
	allowImages: props.allowImages,
	allowTaskLists: props.allowTaskLists,
	imageSource: props.imageSource,
})

// Add mention extension if enabled
if (props.enableMentions && props.projectId > 0) {
	extensions.push(
		Mention.configure({
			HTMLAttributes: {
				class: 'mention',
			},
			suggestion: mentionSuggestionSetup(props.projectId),
		}).extend({

			parseHTML() {
				return [
					{
						tag: 'mention-user',
					},
				]
			},

			renderHTML({ HTMLAttributes }) {
				return ['mention-user', mergeAttributes(HTMLAttributes)]
			},

			addNodeView() {
				return VueNodeViewRenderer(MentionUser)
			},
		}),
	)
}

// Add a custom extension for the Escape key
if (props.enableDiscardShortcut) {
	extensions.push(Extension.create({
		name: 'escapeKey',

		addKeyboardShortcuts() {
			return {
				'Escape': () => {
					exitEditMode()
					return true
				},
			}
		},
	}))
}

// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const editor = useEditor({
	// eslint-disable-next-line vue/no-ref-object-reactivity-loss
	editable: isEditing.value,
	extensions: extensions,
	onUpdate: bubbleNow,
	editorProps: {
		attributes: {
			'aria-label': props.placeholder || t('input.editor.label'),
		},
	},
	parseOptions: {
		preserveWhitespace: true,
	},
})

// useEditor destroys the editor on unmount but leaves the ref populated, so `editor.value?.`
// still hands out a dead instance to anything resuming after an await.
function liveEditor() {
	const instance = editor.value
	return instance && !instance.isDestroyed ? instance : undefined
}

watchEffect(() => editor.value?.setEditable(isEditing.value, false))

watch(
	modelValue,
	value => {
		if (!editor?.value) return

		if (editor.value.getHTML() === value) {
			return
		}

		setModeAndValue(value)
	},
	{immediate: true},
)

function bubbleNow() {
	const instance = liveEditor()
	if (!instance) {
		return
	}

	const editorVal = instance.getHTML()
	if (editorVal === modelValue.value ||
		(editorVal === '<p></p>') && modelValue.value === '') {
		return
	}

	contentHasChanged.value = true

	// Save to localStorage if storageKey is provided
	if (props.storageKey) {
		saveEditorDraft(props.storageKey, editorVal, draftLease)
	}

	modelValue.value = editorVal
}

function bubbleSave() {
	bubbleNow()
	lastSavedState = editor.value?.getHTML() ?? ''

	// Save is an intent, not an acknowledgement: keep the copy until the parent confirms the HTTP write.
	if (props.storageKey) saveEditorDraft(props.storageKey, lastSavedState, draftLease)

	emit('save', lastSavedState)
	if (isEditing.value) {
		internalMode.value = 'preview'
	}
}

function exitEditMode() {
	editor.value?.commands.setContent(lastSavedState, {
		...defaultSetContentOptions,
		emitUpdate: false,
	})

	// Clear draft from localStorage when discarding changes
	if (props.storageKey) {
		clearEditorDraft(props.storageKey, draftLease)
	}

	// The parent already received every keystroke; without the restored text its pending save would write the
	// discarded one. 'discard' lets parents that save on their own fall back to their last saved value.
	contentHasChanged.value = false
	if (modelValue.value !== lastSavedState) modelValue.value = lastSavedState
	emit('discard')

	if (isEditing.value) {
		internalMode.value = 'preview'
	}
}

async function setEditIfApplicable(event: MouseEvent) {
	if (!props.isEditEnabled) return
	if (isEditing.value) return
	if (getLightboxImage(event.target) !== null) return

	const view = editor.value?.view
	const pos = view?.posAtCoords({left: event.clientX, top: event.clientY})?.pos
	if (view === undefined || pos === undefined) {
		setEdit()
		return
	}

	// The toolbar appearing above pushes the content down; scroll it back so the clicked text stays under the pointer.
	const topBefore = view.coordsAtPos(pos).top
	internalMode.value = 'edit'
	await nextTick()
	getScrollParent(view.dom).scrollBy(0, view.coordsAtPos(pos).top - topBefore)
	editor.value?.commands.focus(pos)
}

function setEdit(focus: boolean = true) {
	internalMode.value = 'edit'
	if (focus) {
		editor.value?.commands.focus()
	}
}

onBeforeUnmount(() => {
	if (props.enableDiscardShortcut) {
		tiptapInstanceRef.value?.removeEventListener('keydown', handleEscapeKey)
	}

	editor.value?.destroy()
})

const driveOpen = ref(false)
const attachDrive = useAttachDriveMutation(captureClientRequestContext())
async function insertDriveImage(file: DriveEntry) {
	if (!props.driveTaskId) return
	const taskId = props.driveTaskId
	const attachment = await attachDrive.mutateAsync({file, taskId}).catch(() => undefined)
	if (!attachment?.id || taskId !== props.driveTaskId) return
	liveEditor()?.chain().focus().setImage({src: generateAttachmentUrl(taskId, attachment.id)}).run()
	bubbleNow()
	driveOpen.value = false
}
const uploadInputRef = ref<HTMLInputElement | null>(null)

function uploadAndInsertFiles(files: File[] | FileList) {
	const instance = liveEditor()
	if (props.imageSource) {
		if (instance) props.imageSource.insertFiles(instance, Array.from(files))
		return
	}
	if (typeof props.uploadCallback === 'undefined') {
		throw new Error('Can\'t add files here')
	}

	// The server reports failed uploads (quota, disk full) in the response body,
	// so a rejection here is a message for the user, not a bug to report.
	props.uploadCallback(files).then(async urls => {
		urls?.forEach(url => {
			if (liveEditor()?.isEmpty) {
				liveEditor()
					?.chain()
					.focus()
					.insertContent(UPLOAD_PLACEHOLDER_ELEMENT)
					.run()
			}
			liveEditor()
				?.chain()
				.focus()
				.setImage({src: url})
				.run()
		})

		const html = liveEditor()?.getHTML().replace(UPLOAD_PLACEHOLDER_ELEMENT, '') ?? ''

		liveEditor()?.commands.setContent(html, {
			...defaultSetContentOptions,
			emitUpdate: false,
		})

		bubbleNow()

		// Prompt for alt text right after insertion. setContent above resets node
		// positions, so reliably locating each image is fragile for multi-uploads —
		// prompt only when a single image was inserted.
		if (urls?.length === 1) {
			await promptImageAlt(urls[0])
		}
	}).catch(e => error(e))
}

function triggerImageInput(event: Event) {
	if (!props.allowImages) return
	if (typeof props.uploadCallback !== 'undefined' || props.imageSource) {
		uploadInputRef.value?.click()
		return
	}

	addImage(event)
}

async function addImage(event: Event) {
	if (!props.allowImages) return

	if (props.imageSource) {
		const input = uploadInputRef.value
		const files = Array.from(input?.files ?? [])
		// Picking the same file again must fire another change.
		if (input) input.value = ''
		if (files.length > 0) uploadAndInsertFiles(files)
		return
	}

	if (typeof props.uploadCallback !== 'undefined') {
		const files = uploadInputRef.value?.files

		if (!files || files.length === 0) {
			return
		}

		uploadAndInsertFiles(files)

		return
	}

	if (!(event.target instanceof Element)) return
	const url = await inputPrompt(event.target.getBoundingClientRect(), t('input.editor.urlPlaceholder'), '', editor.value)

	if (url) {
		liveEditor()?.chain().focus().setImage({src: url}).run()
		bubbleNow()
		await promptImageAlt(url)
	}
}

function setLink(event: MouseEvent) {
	const target = event.target as HTMLElement
	setLinkInEditor(target.getBoundingClientRect(), editor.value)
}

// Compose the plugin's default predicate: keep its focus and empty-text-block
// guards (a doubleclicked empty paragraph reports a non-empty range; focus
// prevents a sibling editor's menu from lingering), but also hide the menu over
// a selected image node so only the image menu shows there.
function showTextBubbleMenu({view, element, state, from, to}: {view: EditorView, element: HTMLElement, state: EditorState, from: number, to: number}) {
	const isEmptyTextBlock = !state.doc.textBetween(from, to).length && isTextSelection(state.selection)
	const hasEditorFocus = view.hasFocus() || element.contains(document.activeElement)
	return hasEditorFocus && from !== to && !isEmptyTextBlock && !editor.value?.isActive('image') && !editor.value?.isActive('taskLink')
}

function showImageBubbleMenu() {
	return editor.value?.isActive('image') ?? false
}

// The bubble menus open above the selection. When the selection sits just below the
// fixed navbar they flip below it instead of hiding behind the navbar.
const BUBBLE_MENU_OFFSET = 8
const bubbleMenuOptions = {
	offset: BUBBLE_MENU_OFFSET,
	flip: ({elements}: MiddlewareState) => ({
		rootBoundary: getViewportBelowNavbar(elements.floating),
		// TipTap runs flip before offset, so the offset counts towards the room needed.
		padding: {top: BUBBLE_MENU_OFFSET},
	}),
}

async function promptAndApplyImageAlt(rect: DOMRect, previous: string) {
	const alt = await inputPrompt(rect, t('input.editor.altTextPlaceholder'), previous, editor.value ?? undefined)

	if (alt === null) {
		return
	}

	liveEditor()?.chain().focus().updateAttributes('image', {alt}).run()
	bubbleNow()
}

async function setImageAlt(event: MouseEvent) {
	const target = event.target as HTMLElement
	const previousAlt = editor.value?.getAttributes('image').alt || ''
	await promptAndApplyImageAlt(target.getBoundingClientRect(), previousAlt)
}

async function setImageCaption(event: MouseEvent) {
	const target = event.target as HTMLElement
	const previous = editor.value?.getAttributes('image').title || ''
	const title = await inputPrompt(target.getBoundingClientRect(), t('input.editor.captionPlaceholder'), previous, editor.value ?? undefined)
	if (title === null) return
	liveEditor()?.chain().focus().updateAttributes('image', {title: title.trim() || null}).run()
	bubbleNow()
}

function replaceImage() {
	const instance = liveEditor()
	if (instance && props.imageSource?.replace) props.imageSource.replace(instance)
}

function removeImage() {
	liveEditor()?.chain().focus().deleteSelection().run()
	bubbleNow()
}

// Cancelling leaves the image without alt text.
async function promptImageAlt(src: string) {
	const instance = liveEditor()
	if (!instance) {
		return
	}

	let pos: number | null = null
	instance.state.doc.descendants((node, p) => {
		if (node.type.name === 'image' && (node.attrs.src === src || node.attrs['data-src'] === src)) {
			pos = p
		}
	})
	if (pos === null) {
		return
	}

	instance.chain().setNodeSelection(pos).run()
	await nextTick()

	const dom = liveEditor()?.view.nodeDOM(pos) as HTMLElement | null
	const rect = dom?.getBoundingClientRect() ?? new DOMRect()
	await promptAndApplyImageAlt(rect, '')

	// Drop the node selection the prompt relied on so the next insert appends a new
	// image instead of replacing this one.
	liveEditor()?.chain().setTextSelection(pos + 1).run()
}

onMounted(async () => {
	if (props.editShortcut !== '') {
		document.addEventListener('keydown', setFocusToEditor)
	}

	// Add Escape key handler to prevent event bubbling when editing
	if (props.enableDiscardShortcut) {
		tiptapInstanceRef.value?.addEventListener('keydown', handleEscapeKey)
	}

	await nextTick()

	// Load draft from localStorage if available
	if (props.storageKey) {
		const draft = loadEditorDraft(props.storageKey)
		if (draft && isEditorContentEmpty(modelValue.value)) {
			// Only load draft if current content is empty
			// Set content and force edit mode for immediate editing
			editor.value?.commands.setContent(draft, {
				...defaultSetContentOptions,
				emitUpdate: false,
			})
			internalMode.value = 'edit'
			// The normalized HTML, not the raw draft: a mismatch would make the
			// modelValue watcher reset the editor into preview mode.
			modelValue.value = editor.value?.getHTML() ?? draft
			return
		}
	}

	setModeAndValue(modelValue.value)
})

onBeforeUnmount(() => {
	if (props.editShortcut !== '') {
		document.removeEventListener('keydown', setFocusToEditor)
	}
})

function setModeAndValue(value: string) {
	internalMode.value = isEditorContentEmpty(value) ? 'edit' : 'preview'
	editor.value?.commands.setContent(value, {
		...defaultSetContentOptions,
		emitUpdate: false,
	})
}

// Replace the editor content with a reply draft (prefilled blockquote + empty
// paragraph) and enter edit mode immediately so the user can start typing.
// Returns synchronously after the next tick to let DOM updates settle.
async function setReplyContent(value: string) {
	if (!editor.value) return
	editor.value.commands.setContent(value, {
		...defaultSetContentOptions,
		emitUpdate: false,
	})
	internalMode.value = 'edit'
	modelValue.value = editor.value.getHTML()
	contentHasChanged.value = true
	await nextTick()
	editor.value.commands.focus('end')
}

defineExpose({setReplyContent})


// See https://github.com/github/hotkey/discussions/85#discussioncomment-5214660
function setFocusToEditor(event: KeyboardEvent) {
	const target = event.target
	if (!(target instanceof HTMLElement)) return
	if (target.shadowRoot) {
		return
	}

	const shortcutString = eventToShortcutString(event)
	if (!shortcutString) return
	if (shortcutString !== props.editShortcut ||
		target.tagName.toLowerCase() === 'input' ||
		target.tagName.toLowerCase() === 'textarea' ||
		target.contentEditable === 'true') {
		return
	}

	event.preventDefault()

	if (!isEditing.value && props.isEditEnabled) {
		internalMode.value = 'edit'
	}

	editor.value?.commands.focus()
}

function focusIfEditing() {
	if (isEditing.value) {
		editor.value?.commands.focus()
	}
}

const lightboxBlobUrl = ref<string | null>(null)
const lightboxAlt = ref('')

function getLightboxImage(target: EventTarget | null): HTMLImageElement | null {
	if (
		target instanceof HTMLImageElement
		&& target.dataset.src !== undefined
		&& target.src.startsWith('blob:')
	) {
		return target
	}

	return null
}

function handleContentClick(event: MouseEvent) {
	focusIfEditing()
	if (isEditing.value) {
		return
	}

	const image = getLightboxImage(event.target)
	if (image !== null) {
		lightboxBlobUrl.value = image.src
		lightboxAlt.value = image.alt
	}
}

function closeLightbox() {
	lightboxBlobUrl.value = null
}

function handleEscapeKey(event: KeyboardEvent) {
	// Only intercept Escape when discard shortcut is enabled
	if (event.key !== 'Escape' || !props.enableDiscardShortcut) {
		return
	}

	// Check if the event originated from within the ProseMirror editor
	const target = event.target as HTMLElement
	const isInEditor = target.contentEditable === 'true' || target.closest('.ProseMirror')
	if (!isInEditor) {
		return
	}

	// Stop propagation to prevent modal/parent handlers from firing
	event.stopPropagation()
	// Don't preventDefault - let ProseMirror's extension handle the actual exit
}

function clickTasklistCheckbox(event: Event) {
	event.stopImmediatePropagation()

	const target = event.target
	if (!(target instanceof HTMLElement)) return
	if (target.localName !== 'p') {
		return
	}

	const label = target.parentElement?.parentElement?.firstElementChild
	if (label instanceof HTMLElement) label.click()
}

watch(
	() => isEditing.value,
	async editing => {
		await nextTick()

		let checkboxes = tiptapInstanceRef.value?.querySelectorAll('[data-checked]')
		if (typeof checkboxes === 'undefined' || checkboxes.length === 0) {
			// For some reason, this works when we check a second time.
			await nextTick()

			checkboxes = tiptapInstanceRef.value?.querySelectorAll('[data-checked]')
			if (typeof checkboxes === 'undefined' || checkboxes.length === 0) {
				return
			}
		}

		if (editing) {
			checkboxes.forEach(check => {
				if (check.children.length < 2) {
					return
				}

				// We assume the first child contains the label element with the checkbox and the second child the actual label
				// When the actual label is clicked, we forward that click to the checkbox.
				const secondChild = check.children[1]
				if (secondChild) {
					secondChild.removeEventListener('click', clickTasklistCheckbox)
				}
			})

			return
		}

		checkboxes.forEach(check => {
			if (check.children.length < 2) {
				return
			}

			// We assume the first child contains the label element with the checkbox and the second child the actual label
			// When the actual label is clicked, we forward that click to the checkbox.
			const secondChild = check.children[1]
			if (secondChild) {
				secondChild.removeEventListener('click', clickTasklistCheckbox)
				secondChild.addEventListener('click', clickTasklistCheckbox)
			}
		})
	},
	{immediate: true},
)
</script>

<style lang="scss">
.tiptap__wrapper {
	// The border is always there (transparent in preview) so entering edit mode never changes the box size.
	border: 1px solid transparent;
	border-radius: var(--radius-md);
	transition: border-color var(--motion-fast) var(--ease-standard);

	&.tiptap__wrapper-is-editing {
		border-color: var(--input-border-color);
		background-color: var(--surface);
	}

	// The is-editing guard prevents a border flash when focusing checkboxes in preview mode
	&.tiptap__wrapper-is-editing:focus-within {
		border-color: var(--focus-ring-color);
	}
}

.tiptap__editor {
	&.tiptap__editor-is-edit-enabled {
		min-block-size: 6rem;

		.ProseMirror {
			padding: var(--space-2) var(--space-3);
		}

		ul[data-type='taskList'] li > div {
			cursor: text;
		}
	}
}

.tiptap p::before {
	content: attr(data-placeholder);
	color: var(--text-tertiary);
	pointer-events: none;
	block-size: 0;
	float: inline-start;
}

.tiptap__footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	margin-block-start: var(--space-2);
}

// Basic editor styles
.ProseMirror {
	padding: .5rem .5rem .5rem 0;
	overflow-wrap: break-word;

	&:focus-within, &:focus {
		box-shadow: none;
	}

	> * + * {
		margin-block-start: 0.75em;
	}

	ul,
	ol {
		padding: 0 1rem;
	}

	h1,
	h2,
	h3,
	h4,
	h5,
	h6 {
		line-height: 1.1;
	}

	code {
		background-color: var(--surface-active);
		color: var(--text-primary);
		border-radius: var(--radius-xs);
	}

	pre {
		background: var(--surface-sunken);
		border: 1px solid var(--border-subtle);
		color: var(--text-primary);
		font-family: var(--font-mono);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);

		code {
			color: inherit;
			padding: 0;
			background: none;
			font-size: var(--text-sm);
		}

		.hljs-comment,
		.hljs-quote {
			color: var(--text-tertiary);
		}

		.hljs-variable,
		.hljs-template-variable,
		.hljs-attribute,
		.hljs-tag,
		.hljs-name,
		.hljs-regexp,
		.hljs-link,
		.hljs-selector-id,
		.hljs-selector-class {
			color: var(--code-variable);
		}

		.hljs-number,
		.hljs-meta,
		.hljs-built_in,
		.hljs-builtin-name,
		.hljs-literal,
		.hljs-type,
		.hljs-params {
			color: var(--code-literal);
		}

		.hljs-string,
		.hljs-symbol,
		.hljs-bullet {
			color: var(--code-symbol);
		}

		.hljs-title,
		.hljs-section {
			color: var(--code-section);
		}

		.hljs-keyword,
		.hljs-selector-tag {
			color: var(--code-keyword);
		}

		.hljs-emphasis {
			font-style: italic;
		}

		.hljs-strong {
			font-weight: 700;
		}
	}

	img {
		max-inline-size: 100%;
		block-size: auto;

		&.ProseMirror-selectednode {
			outline: 2px solid var(--focus-ring-color);
			outline-offset: 2px;
		}
	}

	blockquote {
		padding-inline-start: var(--space-4);
		border-inline-start: 2px solid var(--border-strong);
	}

	hr {
		border: none;
		border-block-start: 1px solid var(--border-default);
		margin: var(--space-6) 0;
	}
	
	// Table-specific styling
	table {
		border-collapse: collapse;
		table-layout: fixed;
		inline-size: 100%;
		margin: 0;
		overflow: hidden;

		td,
		th {
			min-inline-size: 1em;
			border: 1px solid var(--border-default) !important;
			padding: 3px 5px;
			vertical-align: top;
			box-sizing: border-box;
			position: relative;

			> * {
				margin-block-end: 0;
			}
		}

		th {
			font-weight: var(--weight-semibold);
			text-align: start;
			background-color: var(--surface-sunken);
		}

		.selectedCell:after {
			z-index: 2;
			position: absolute;
			content: '';
			inset-inline-start: 0;
			inset-inline-end: 0;
			inset-block-start: 0;
			inset-block-end: 0;
			background: var(--surface-selected-strong);
			pointer-events: none;
		}

		.column-resize-handle {
			position: absolute;
			inset-inline-end: -2px;
			inset-block-start: 0;
			inset-block-end: -2px;
			inline-size: 4px;
			background-color: var(--focus-ring-color);
			pointer-events: none;
		}

		p {
			margin: 0;
		}
	}

	// Lists

	ul {
		margin-inline-start: .5rem;
		margin-block-start: 0 !important;

		li {
			margin-block-start: 0;
		}

		p {
			margin-block-end: 0 !important;
		}
	}
}

.tableWrapper {
	overflow-x: auto;
}

.resize-cursor {
	cursor: ew-resize;
	cursor: col-resize;
}

// tasklist
ul[data-type='taskList'] {
	list-style: none;
	padding: 0;
	margin-inline-start: 0;

	li[data-checked='true'] > div > :not(ul, ol) {
		color: var(--text-tertiary);
		text-decoration: line-through;
	}

	li {
		display: flex;
		margin-block-start: 0.25rem;

		> label {
			flex: 0 0 auto;
			margin-inline-end: 0.5rem;
			user-select: none;
		}

		> div {
			flex: 1 1 auto;
			cursor: pointer;
		}
	}

	input[type='checkbox'] {
		cursor: pointer;
	}
}

.editor-bubble__wrapper {
	display: flex;
	gap: 2px;
	padding: 2px;
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-raised);
	box-shadow: var(--elevation-3);
}

.editor-bubble__button {
	border-radius: var(--radius-sm);
	background: transparent;
	color: var(--text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	svg {
		box-sizing: border-box;
		display: block;
		inline-size: 2rem;
		block-size: 2rem;
		padding: .5rem;
		margin: 0;
	}

	&:hover {
		background: var(--surface-hover);
		color: var(--text-primary);
	}

	&.is-active {
		background: var(--surface-selected);
		color: var(--accent-text);
	}

	&:focus-visible {
		@include focus-ring;
		outline-offset: -2px;
	}

	&--text {
		padding: .5rem .75rem;
		font-size: var(--text-sm);
		white-space: nowrap;
	}
}

// Inside .content the list would pick up bullets and indentation.
.tiptap ul.tiptap__editor-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1);
	margin: var(--space-1) 0 0;
	padding: 0;
	list-style: none;
	font-size: var(--text-sm);

	li,
	li + li {
		display: inline-flex;
		margin: 0;
	}

	button,
	a {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-block-size: var(--target-min);
		padding-inline: var(--space-2);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		text-decoration: none;
		transition:
			background-color var(--motion-fast) var(--ease-standard),
			color var(--motion-fast) var(--ease-standard);

		&:hover {
			background: var(--surface-hover);
			color: var(--text-primary);
		}

		&.done-edit {
			color: var(--accent-text);
		}

		svg {
			font-size: var(--text-xs);
		}
	}
}
</style>
