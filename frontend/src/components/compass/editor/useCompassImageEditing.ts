import {computed, onBeforeUnmount, ref, shallowRef} from 'vue'
import {useI18n} from 'vue-i18n'
import type {Editor} from '@tiptap/core'
import type {Transaction} from '@tiptap/pm/state'
import {useUploadDriveMutation, type DriveEntry} from '@/client/queries/drive'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import type {EditorImageSource} from '@/components/input/editor/types'
import {
	COMPASS_IMAGE_LIMITS,
	COMPASS_IMAGE_TYPES,
	compassImageIds,
	compassUploadedSize,
	isCompassImageType,
	isUploadableCompassImage,
} from '@/helpers/compass/images'
import {fetchCompassImageBlob, measureCompassImage} from '@/helpers/compass/imageUrls'
import {chooseImageBatch, uploads, type ImageBatch} from '@/helpers/uploadTransport'
import {getErrorText} from '@/message'
import {createCompassImageExtension, type CompassImageNodeAttributes} from './compassImageExtension'

export type CompassImageUploadState = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'

export type CompassImageUpload = {
	key: string
	name: string
	size: number
	state: CompassImageUploadState
	// The transport's progress row for this file.
	recordId?: string
	error?: string
	retryable: boolean
}

// A document position that follows edits made while uploads run.
type Anchor = {pos: number}

type Target =
	| {kind: 'insert', anchor: Anchor}
	| {kind: 'replace', anchor: Anchor, fileId: number}

type Job = {
	key: string
	file: File
	batch: ImageBatch | null
	target: Target
	width: number
	height: number
}

// Finished rows fold away after the same pause as the upload center's.
const DONE_LINGER_MS = 2500

export const COMPASS_IMAGE_ACCEPT = [...COMPASS_IMAGE_TYPES, 'image/bmp', 'image/*'].join(',')

/**
 * Pictures in one Compass body: the editor's image node, local uploads into the writer's drive (one format
 * choice per selection, one file at a time with its own progress), drive picks, replacing and removing.
 * Each finished image lands where the writer was when they asked for it, even if they kept typing.
 * Nothing here talks to the space: the server mounts an image when the body is saved.
 */
export function useCompassImageEditing(spaceId: number) {
	const {t} = useI18n({useScope: 'global'})
	const upload = useUploadDriveMutation()

	const list = shallowRef<CompassImageUpload[]>([])
	const running = ref(false)
	// Images whose bytes could not be shown here; saving them would fail the same way.
	const unavailable = shallowRef<ReadonlySet<number>>(new Set())
	// The last thing that went wrong outside a row: a refused file, the limit, a drive pick.
	const notice = ref('')
	const driveOpen = ref(false)
	const driveBusy = ref(false)
	const replacing = ref(false)

	let editor: Editor | undefined
	const anchors = new Set<Anchor>()
	const jobs = new Map<string, Job>()
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	let pendingTarget: Target | null = null
	let controller: AbortController | undefined
	let owner = captureClientRequestContext()
	// Ends with the desk: a format question still open then goes away instead of starting uploads later.
	const life = new AbortController()

	function liveEditor(): Editor | undefined {
		return editor && !editor.isDestroyed ? editor : undefined
	}

	function onTransaction({transaction}: {transaction: Transaction}) {
		if (!transaction.docChanged) return
		for (const anchor of anchors) anchor.pos = transaction.mapping.map(anchor.pos)
	}

	const extension = createCompassImageExtension({
		spaceId,
		labels: {
			loading: t('compass.images.loading'),
			unavailable: t('compass.images.unavailableEditor'),
			unnamed: t('compass.images.unnamed'),
		},
		onAvailability(fileId, available) {
			if (unavailable.value.has(fileId) === !available) return
			const next = new Set(unavailable.value)
			if (available) next.delete(fileId)
			else next.add(fileId)
			unavailable.value = next
		},
		onEditor(next) {
			editor?.off('transaction', onTransaction)
			editor = next
			editor?.on('transaction', onTransaction)
		},
	})

	function anchorAtSelection(instance: Editor): Anchor {
		const anchor = {pos: instance.state.selection.to}
		anchors.add(anchor)
		return anchor
	}

	function find(key: string) {
		return list.value.find(item => item.key === key)
	}

	// Every file of one selection shares its anchor; it stays mapped while any of them may still be placed.
	function releaseAnchor(anchor: Anchor) {
		const needed = [...jobs.values()].some(job => {
			if (job.target.anchor !== anchor) return false
			const item = find(job.key)
			return item !== undefined && item.state !== 'done' && (item.state !== 'failed' || item.retryable)
		})
		if (!needed) anchors.delete(anchor)
	}

	function patch(key: string, change: Partial<CompassImageUpload>) {
		list.value = list.value.map(item => item.key === key ? {...item, ...change} : item)
	}

	function remove(predicate: (item: CompassImageUpload) => boolean) {
		const removed = list.value.filter(predicate)
		if (removed.length === 0) return
		list.value = list.value.filter(item => !predicate(item))
		// The transport rows are scoped to this list, so the shared upload panel never clears them.
		const records = new Set(removed.map(item => item.recordId))
		uploads.value = uploads.value.filter(row => !records.has(row.id))
		for (const {key} of removed) {
			clearTimeout(timers.get(key))
			timers.delete(key)
			const job = jobs.get(key)
			jobs.delete(key)
			if (!job) continue
			releaseAnchor(job.target.anchor)
			// A selection's format choice lives as long as one of its files may still be retried.
			if (job.batch && ![...jobs.values()].some(other => other.batch === job.batch)) job.batch.release()
		}
	}

	function reset() {
		controller?.abort()
		controller = undefined
		running.value = false
		remove(() => true)
		anchors.clear()
		pendingTarget = null
		driveOpen.value = false
		replacing.value = false
	}

	// Rows and anchors belong to the account that picked the files.
	function ensureOwner(): boolean {
		if (isClientRequestContextCurrent(owner)) return true
		reset()
		owner = captureClientRequestContext()
		return false
	}

	function bodyImageCount(): number {
		const instance = liveEditor()
		return instance ? compassImageIds(instance.getHTML()).length : 0
	}

	function pendingCount(): number {
		return list.value.filter(item => item.state === 'queued' || item.state === 'uploading').length
	}

	/** Puts one image where its target says; false when the editor is gone. */
	function place(target: Target, attrs: CompassImageNodeAttributes): boolean {
		const instance = liveEditor()
		if (!instance) return false
		const doc = instance.state.doc
		const pos = Math.min(Math.max(target.anchor.pos, 0), doc.content.size)
		if (target.kind === 'replace') {
			const node = doc.nodeAt(pos)
			if (node?.type.name === 'image' && node.attrs.fileId === target.fileId) {
				// Alt text and caption stay; the writer adjusts them in the image menu if the new picture differs.
				return instance.chain().command(({tr}) => {
					tr.setNodeMarkup(pos, undefined, {
						...node.attrs,
						fileId: attrs.fileId,
						width: attrs.width,
						height: attrs.height,
					})
					return true
				}).run()
			}
		}
		const node = {type: 'image', attrs}
		const $pos = doc.resolve(pos)
		const parent = $pos.parent
		// Pictures are blocks: an empty paragraph becomes the picture, the edges of a paragraph put it
		// before or after, and only a cursor inside the text splits it.
		let at: number | null = null
		if ($pos.depth > 0 && parent.isTextblock) {
			if (parent.content.size === 0) {
				const from = $pos.before()
				if (!instance.chain().insertContentAt({from, to: $pos.after()}, node, {updateSelection: false}).run()) return false
				target.anchor.pos = from + 1
				return true
			}
			if ($pos.parentOffset === 0) at = $pos.before()
			else if ($pos.parentOffset === parent.content.size) at = $pos.after()
		}
		// The writer may be typing elsewhere by now: their cursor stays where it is.
		if (at === null) return instance.chain().insertContentAt(pos, node, {updateSelection: false}).run()
		if (!instance.chain().insertContentAt(at, node, {updateSelection: false}).run()) return false
		target.anchor.pos = at + 1
		return true
	}

	function failure(cause: unknown): string | undefined {
		return getErrorText(cause).trim() || undefined
	}

	async function run(signal: AbortSignal) {
		running.value = true
		try {
			for (;;) {
				const item = list.value.find(row => row.state === 'queued')
				if (!item || signal.aborted) break
				const job = jobs.get(item.key)
				if (!job) {
					patch(item.key, {state: 'failed'})
					continue
				}
				patch(item.key, {state: 'uploading', error: undefined})
				try {
					const saved = await upload.mutateAsync({
						file: job.file,
						signal,
						headers: job.batch?.headers(item.recordId),
						quiet: true,
					})
					if (!ensureOwner()) return
					const fileId = saved?.file_id ?? 0
					const mime = saved?.file?.mime ?? ''
					if (fileId <= 0) throw new Error(t('compass.images.uploadFailed'))
					// The file is in the drive now; it just cannot illustrate a body.
					if (!isCompassImageType(mime)) {
						patch(item.key, {state: 'failed', error: t('compass.images.unsupportedUploaded', {name: job.file.name}), retryable: false})
						continue
					}
					if (job.target.kind === 'insert' && bodyImageCount() >= COMPASS_IMAGE_LIMITS.perEntry) {
						patch(item.key, {state: 'failed', error: t('compass.images.limitUploaded', {limit: COMPASS_IMAGE_LIMITS.perEntry}), retryable: false})
						continue
					}
					const placed = place(job.target, {
						fileId,
						alt: null,
						title: null,
						width: job.width || null,
						height: job.height || null,
					})
					if (!placed) {
						patch(item.key, {state: 'failed', error: t('compass.images.notPlaced'), retryable: false})
						continue
					}
					patch(item.key, {state: 'done', retryable: false})
					releaseAnchor(job.target.anchor)
					timers.set(item.key, setTimeout(() => remove(row => row.key === item.key), DONE_LINGER_MS))
				} catch (cause) {
					if (!ensureOwner()) return
					// Cancelling, or dismissing a fallback format choice, stops the rest of the run.
					if (isRequestContextAbort(cause) || signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) {
						patch(item.key, {state: 'cancelled'})
						break
					}
					patch(item.key, {state: 'failed', error: failure(cause)})
				}
			}
			for (const item of list.value) {
				if (item.state === 'queued') patch(item.key, {state: 'cancelled'})
			}
		} finally {
			running.value = false
		}
	}

	function start() {
		if (running.value || life.signal.aborted) return
		const own = new AbortController()
		controller = own
		void run(own.signal).finally(() => {
			if (controller === own) controller = undefined
		})
	}

	/** Files from the picker, a paste or a drop; replaces the image at `target` when given. */
	async function addFiles(files: File[], target: Target) {
		notice.value = ''
		if (!ensureOwner()) return
		const images = files.filter(file => file.type.startsWith('image/'))
		const others = files.length - images.length
		if (others > 0) notice.value = t('compass.images.notImages', {n: others}, others)
		if (images.length === 0) {
			anchors.delete(target.anchor)
			return
		}
		let accepted = images
		if (target.kind === 'replace') {
			accepted = images.slice(0, 1)
		} else {
			const room = COMPASS_IMAGE_LIMITS.perEntry - bodyImageCount() - pendingCount()
			if (room <= 0) {
				notice.value = t('compass.images.limit', {limit: COMPASS_IMAGE_LIMITS.perEntry})
				anchors.delete(target.anchor)
				return
			}
			if (images.length > room) {
				accepted = images.slice(0, room)
				notice.value = t('compass.images.limitPartial', {limit: COMPASS_IMAGE_LIMITS.perEntry, n: images.length - room}, images.length - room)
			}
		}
		const batch = await chooseImageBatch(accepted, life.signal)
		// Dismissing the format choice adds nothing.
		if (!batch || life.signal.aborted || !ensureOwner()) {
			batch?.release()
			anchors.delete(target.anchor)
			return
		}
		const added: CompassImageUpload[] = []
		for (const file of accepted) {
			const key = crypto.randomUUID()
			if (!isUploadableCompassImage(file, batch.choice)) {
				added.push({key, name: file.name, size: file.size, state: 'failed', error: t('compass.images.unsupported', {name: file.name}), retryable: false})
				continue
			}
			const original = await measureCompassImage(file)
			const size = compassUploadedSize(original.width, original.height, file, batch.choice)
			jobs.set(key, {
				key,
				file,
				batch,
				target,
				width: size.width,
				height: size.height,
			})
			added.push({key, name: file.name, size: file.size, state: 'queued', recordId: crypto.randomUUID(), retryable: true})
		}
		// The desk closed, or another account signed in, while the pictures were measured.
		if (life.signal.aborted || !ensureOwner()) {
			for (const item of added) jobs.delete(item.key)
			batch.release()
			anchors.delete(target.anchor)
			return
		}
		if (!added.some(item => item.state === 'queued')) {
			batch.release()
			anchors.delete(target.anchor)
		}
		list.value = [...list.value, ...added]
		start()
	}

	function insertFiles(instance: Editor, files: File[]) {
		if (instance.isDestroyed) return
		void addFiles(files, {kind: 'insert', anchor: anchorAtSelection(instance)})
	}

	/** The selected image node, when the selection is one. */
	function selectedImage(instance: Editor): {pos: number, fileId: number} | null {
		const {selection} = instance.state
		const node = instance.state.doc.nodeAt(selection.from)
		if (node?.type.name !== 'image' || typeof node.attrs.fileId !== 'number') return null
		return {pos: selection.from, fileId: node.attrs.fileId}
	}

	function replace(instance: Editor) {
		const image = selectedImage(instance)
		if (!image) return
		const anchor = {pos: image.pos}
		anchors.add(anchor)
		pendingTarget = {kind: 'replace', anchor, fileId: image.fileId}
		replacing.value = true
	}

	function closeReplace() {
		replacing.value = false
		if (pendingTarget && !driveOpen.value) {
			anchors.delete(pendingTarget.anchor)
			pendingTarget = null
		}
	}

	/** Replacement files from the chooser's own file input. */
	function replaceWithFiles(files: File[]) {
		const target = pendingTarget
		replacing.value = false
		pendingTarget = null
		if (!target || files.length === 0) {
			if (target) anchors.delete(target.anchor)
			return
		}
		void addFiles(files, target)
	}

	/** Files from the desk's own "Add images" button. */
	function addFromButton(files: File[]) {
		const instance = liveEditor()
		if (!instance || files.length === 0) return
		insertFiles(instance, files)
	}

	function openDrive(forReplace = false) {
		notice.value = ''
		const instance = liveEditor()
		if (!instance) return
		if (!forReplace) {
			if (pendingTarget) anchors.delete(pendingTarget.anchor)
			pendingTarget = {kind: 'insert', anchor: anchorAtSelection(instance)}
		}
		replacing.value = false
		driveOpen.value = true
	}

	function closeDrive() {
		if (driveBusy.value) return
		driveOpen.value = false
		if (pendingTarget) anchors.delete(pendingTarget.anchor)
		pendingTarget = null
	}

	async function pickFromDrive(file: DriveEntry) {
		const target = pendingTarget
		if (!target || driveBusy.value) return
		notice.value = ''
		if (!isCompassImageType(file.file?.mime)) {
			notice.value = t('compass.images.unsupported', {name: file.file?.name ?? ''})
			return
		}
		if (target.kind === 'insert' && bodyImageCount() >= COMPASS_IMAGE_LIMITS.perEntry) {
			notice.value = t('compass.images.limit', {limit: COMPASS_IMAGE_LIMITS.perEntry})
			return
		}
		const context = captureClientRequestContext()
		driveBusy.value = true
		let size: {width: number, height: number}
		try {
			// Read through the space, as the body will be: a file in the recycle bin cannot be used.
			size = await measureCompassImage(await fetchCompassImageBlob(spaceId, file.file_id))
		} catch (cause) {
			if (!isClientRequestContextCurrent(context)) return
			notice.value = isRequestContextAbort(cause) ? '' : t('compass.images.driveUnavailable', {name: file.file?.name ?? ''})
			return
		} finally {
			driveBusy.value = false
		}
		if (!isClientRequestContextCurrent(context)) return
		const placed = place(target, {
			fileId: file.file_id,
			alt: null,
			title: null,
			width: size.width || null,
			height: size.height || null,
		})
		driveOpen.value = false
		anchors.delete(target.anchor)
		pendingTarget = null
		if (!placed) notice.value = t('compass.images.notPlaced')
	}

	/** Flags an image the server refused, so the editor shows which one to remove or replace. */
	function markUnavailable(fileId: number) {
		if (unavailable.value.has(fileId)) return
		unavailable.value = new Set([...unavailable.value, fileId])
	}

	/** Removes every image of the body whose bytes cannot be shown here. */
	function removeUnavailable() {
		const instance = liveEditor()
		if (!instance) return
		const gone = unavailable.value
		const positions: number[] = []
		instance.state.doc.descendants((node, pos) => {
			if (node.type.name === 'image' && gone.has(node.attrs.fileId)) positions.push(pos)
		})
		if (positions.length === 0) return
		instance.chain().command(({tr}) => {
			for (const pos of positions.reverse()) {
				const node = tr.doc.nodeAt(pos)
				if (node) tr.delete(pos, pos + node.nodeSize)
			}
			return true
		}).run()
	}

	function retry(key: string) {
		if (!ensureOwner()) return
		const item = find(key)
		if (!item?.retryable || !jobs.has(key)) return
		patch(key, {state: 'queued', error: undefined})
		start()
	}

	function cancel() {
		controller?.abort()
	}

	function dismiss(key: string) {
		remove(item => item.key === key && item.state !== 'uploading')
	}

	function clearFinished() {
		remove(item => item.state === 'done' || item.state === 'failed' || item.state === 'cancelled')
	}

	onBeforeUnmount(() => {
		life.abort()
		reset()
		editor?.off('transaction', onTransaction)
		editor = undefined
	})

	const source: EditorImageSource = {
		extension,
		accept: COMPASS_IMAGE_ACCEPT,
		insertFiles,
		replace,
	}

	return {
		source,
		items: computed(() => list.value),
		running: computed(() => running.value),
		unavailable: computed(() => unavailable.value),
		notice,
		driveOpen,
		driveBusy,
		replacing,
		addFromButton,
		openDrive,
		closeDrive,
		pickFromDrive,
		closeReplace,
		replaceWithFiles,
		removeUnavailable,
		markUnavailable,
		retry,
		cancel,
		dismiss,
		clearFinished,
		clearNotice: () => {
			notice.value = ''
		},
	}
}
