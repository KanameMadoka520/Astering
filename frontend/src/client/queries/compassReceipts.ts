import {hashKey, type QueryClient, type QueryKey} from '@tanstack/vue-query'
import {assertClientRequestContext, captureClientRequestContext} from '@/client/requestContext'
import {compassKeys} from './compass'

export type CompassReceiptChange = {
	space: number
	entry?: number
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Only a successful, scope-consistent server receipt can refresh a Compass resource. */
export function parseCompassReceipt(
	tool: string,
	args: Record<string, unknown>,
	result: unknown,
): CompassReceiptChange | undefined {
	if (!record(result) || !positive(result.id) || !positive(result.revision)) return
	switch (tool) {
		case 'create_compass_space':
			if (result.team_id !== (args.team_id ?? 0)) return
			return {space: result.id}
		case 'update_compass_space':
			if (args.id !== result.id || !positive(args.revision) || result.revision <= args.revision) return
			return {space: result.id}
		case 'create_compass_entry':
			if (args.space_id !== result.space_id || !positive(result.space_id)) return
			return {space: result.space_id, entry: result.id}
		case 'update_compass_entry':
		case 'restore_compass_revision': {
			const previous = tool === 'restore_compass_revision' ? args.expected_revision : args.revision
			if (args.id !== result.id || !positive(result.space_id) || !positive(previous)
				|| result.revision <= previous
				|| (args.space_id !== undefined && args.space_id !== result.space_id)) return
			return {space: result.space_id, entry: result.id}
		}
	}
}

export async function refreshCompassReceipts(client: QueryClient, changes: readonly CompassReceiptChange[]) {
	if (!changes.length) return
	const request = captureClientRequestContext()
	const keys = new Map<string, QueryKey>()
	const add = (key: QueryKey) => keys.set(hashKey(key), key)
	for (const {space, entry} of changes) {
		// A response cannot move an existing entry to a different space.
		if (entry) {
			const current = client.getQueryData<{space_id?: number}>(compassKeys.entry(entry))
			if (current?.space_id !== undefined && current.space_id !== space) continue
			add(compassKeys.entry(entry))
			add(compassKeys.entryLists(space))
			add(compassKeys.topics(space))
			// Historic snapshots are immutable; only the paged revision catalogue has changed.
			add([...compassKeys.revisions(entry), 'list'])
		}
		add(compassKeys.space(space))
		add(compassKeys.spaces)
	}
	// Invalidation alone does not restart an initial GET without cached data. Cancel its old
	// snapshot first, then read the committed write. No response is assigned to an editor draft.
	await Promise.all([...keys.values()].map(queryKey => client.cancelQueries({queryKey})))
	assertClientRequestContext(request)
	await Promise.all([...keys.values()].map(queryKey => client.invalidateQueries({queryKey})))
}
