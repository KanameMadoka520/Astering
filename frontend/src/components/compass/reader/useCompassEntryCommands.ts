import {
	computed,
	inject,
	nextTick,
	provide,
	ref,
	toValue,
	watch,
	type InjectionKey,
	type MaybeRefOrGetter,
} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {
	canAdminCompass,
	canWriteCompass,
	useDeleteCompassEntryMutation,
	useSetCompassEntryMetaMutation,
	type CompassEntry,
	type CompassEntryMetaChange,
} from '@/client/queries/compass'
import type {CompassEntryState} from '@/helpers/compass/constants'

/** Which write is running; one at a time, so a second click cannot race the first. */
export type CompassEntryBusy = 'pin' | 'state' | 'trash' | 'delete' | null

function createCompassEntryCommands(
	source: MaybeRefOrGetter<CompassEntry | undefined>,
	focusFallback: () => void,
) {
	const route = useRoute()
	const router = useRouter()
	const metaMutation = useSetCompassEntryMetaMutation()
	const deleteMutation = useDeleteCompassEntryMutation()

	const entry = computed(() => toValue(source))
	const busy = ref<CompassEntryBusy>(null)
	const trashConfirmOpen = ref(false)
	const deleteDialogOpen = ref(false)

	const canWrite = computed(() => canWriteCompass(entry.value))
	const canAdmin = computed(() => canAdminCompass(entry.value))

	// A dialog opened for one entry must never confirm an action on the next one.
	watch(() => entry.value?.id, () => {
		trashConfirmOpen.value = false
		deleteDialogOpen.value = false
	})

	async function changeMeta(
		change: CompassEntryMetaChange,
		kind: Exclude<CompassEntryBusy, null>,
	): Promise<boolean> {
		const current = entry.value
		if (!current || busy.value !== null || !canWrite.value) return false
		busy.value = kind
		try {
			await metaMutation.mutateAsync({
				entryId: current.id,
				spaceId: current.space_id,
				change,
			})
		} catch {
			// The mutation already toasted the failure; an aborted request has nothing to show.
			return false
		} finally {
			busy.value = null
		}
		if (entry.value?.id !== current.id) return true
		// The control that was clicked may be gone now (a banner after restoring); keep focus on the page.
		await nextTick()
		if (!document.activeElement || document.activeElement === document.body) focusFallback()
		return true
	}

	async function setPinned(pinned: boolean): Promise<boolean> {
		if (entry.value?.state !== 'active') return false
		return changeMeta({pinned}, 'pin')
	}

	async function setState(state: Exclude<CompassEntryState, 'trashed'>): Promise<boolean> {
		return changeMeta({state}, 'state')
	}

	function requestTrash() {
		if (!canWrite.value || entry.value?.state === 'trashed') return
		trashConfirmOpen.value = true
	}

	function cancelTrash() {
		if (busy.value === 'trash') return
		trashConfirmOpen.value = false
	}

	async function confirmTrash() {
		const entryId = entry.value?.id
		if (!trashConfirmOpen.value || entryId === undefined) return
		const done = await changeMeta({state: 'trashed'}, 'trash')
		if (done && trashConfirmOpen.value && entry.value?.id === entryId) trashConfirmOpen.value = false
	}

	function requestDelete() {
		if (!canAdmin.value || entry.value?.state !== 'trashed') return
		deleteDialogOpen.value = true
	}

	function closeDelete() {
		if (busy.value === 'delete') return
		deleteDialogOpen.value = false
	}

	async function confirmDelete() {
		const current = entry.value
		if (!current || busy.value !== null || !canAdmin.value || current.state !== 'trashed') return
		const startedAt = route.fullPath
		busy.value = 'delete'
		try {
			await deleteMutation.mutateAsync({
				entryId: current.id,
				spaceId: current.space_id,
				revision: current.revision,
			})
		} catch {
			// Toasted by the mutation; the dialog stays open so the user can try again or cancel.
			return
		} finally {
			busy.value = null
		}
		deleteDialogOpen.value = false
		// Someone who already moved on must not be pulled back into the trash view.
		if (route.fullPath !== startedAt) return
		await router.replace({
			name: 'compass.space',
			params: {spaceId: current.space_id},
			query: {state: 'trashed'},
		})
	}

	return {
		busy,
		canWrite,
		canAdmin,
		trashConfirmOpen,
		deleteDialogOpen,
		setPinned,
		setState,
		requestTrash,
		cancelTrash,
		confirmTrash,
		requestDelete,
		closeDelete,
		confirmDelete,
	}
}

export type CompassEntryCommands = ReturnType<typeof createCompassEntryCommands>

const COMMANDS: InjectionKey<CompassEntryCommands> = Symbol('compassEntryCommands')

/**
 * One set of entry writes per reader page: the toolbar and the archive/trash banner share the
 * pending state and the confirmation dialogs, so neither can start a second write mid-request.
 */
export function provideCompassEntryCommands(
	entry: MaybeRefOrGetter<CompassEntry | undefined>,
	focusFallback: () => void,
): CompassEntryCommands {
	const commands = createCompassEntryCommands(entry, focusFallback)
	provide(COMMANDS, commands)
	return commands
}

export function useCompassEntryCommands(): CompassEntryCommands {
	const commands = inject(COMMANDS)
	if (!commands) throw new Error('useCompassEntryCommands() needs provideCompassEntryCommands() in an ancestor')
	return commands
}
