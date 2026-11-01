import type {ChatTurn} from '@/client/generated'

export type SteeringEntry = NonNullable<ChatTurn['steering']>[number]

// An instruction this tab sent for a running turn, shown until the server's copy of it arrives.
export type LocalSteer = {
	chat: string
	turn: string
	request_id: string
	message: string
	// 'sent' was acknowledged; the stream or refetch carrying the server's copy may still be on its way.
	state: 'sending' | 'sent'
}

export type SteeringItem = {
	key: string
	// The server's receipt id and status, unset for an instruction this tab has not seen confirmed yet.
	id?: string
	status?: SteeringEntry['status']
	message: string
	created?: string
	appliedAt?: string
	// What the row says: 'missed' is a pending instruction of a run that ended, not a server status.
	state: 'sending' | 'pending' | 'applied' | 'missed' | 'unknown'
}

const ENDED: ReadonlySet<ChatTurn['status']> = new Set(['completed', 'failed', 'stopped', 'interrupted'])

function serverState(entry: SteeringEntry, status: ChatTurn['status']): SteeringItem['state'] {
	if (entry.status === 'applied') return 'applied'
	// Pending survives the end of a run (a retry still takes it in), so an ended run's entry is "not yet applied".
	if (entry.status === 'pending') return ENDED.has(status) ? 'missed' : 'pending'
	return 'unknown'
}

/**
 * The instructions of one turn: the server's in its acceptance order, which is authoritative even when clocks step
 * back or two share a timestamp, then this tab's unconfirmed ones. A local entry the server already lists shows once.
 */
export function steeringItems(
	entries: readonly SteeringEntry[] | null | undefined,
	status: ChatTurn['status'],
	local: readonly LocalSteer[] = [],
): SteeringItem[] {
	const server = entries ?? []
	const known = new Set(server.map(entry => entry.request_id).filter(Boolean))
	return [
		...server.map((entry, index) => ({
			// The request id first: this tab's unconfirmed row then turns into the server's without being replaced.
			key: entry.request_id || entry.id || `index-${index}`,
			id: entry.id,
			status: entry.status,
			message: entry.message ?? '',
			created: entry.created,
			appliedAt: entry.applied_at,
			state: serverState(entry, status),
		})),
		...local.filter(entry => !known.has(entry.request_id)).map(entry => ({
			key: entry.request_id,
			message: entry.message,
			state: entry.state === 'sending' ? 'sending' as const : 'pending' as const,
		})),
	]
}

/** How many of the turn's instructions the run has not taken in yet. */
export function pendingSteeringCount(turn: ChatTurn | undefined): number {
	return turn?.steering?.filter(entry => entry.status === 'pending').length ?? 0
}

export function hasSteeringRequest(turn: ChatTurn | undefined, requestID: string): boolean {
	return Boolean(requestID && turn?.steering?.some(entry => entry.request_id === requestID))
}
