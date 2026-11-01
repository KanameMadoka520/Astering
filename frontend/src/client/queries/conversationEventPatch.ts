type StreamRecord = Record<string, unknown>
type StreamContainer = StreamRecord | unknown[]

export class ConversationStreamSyncError extends Error {}

export function isStreamRecord(value: unknown): value is StreamRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContainer(value: unknown): value is StreamContainer {
	return isStreamRecord(value) || Array.isArray(value)
}

export function streamRevision(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new ConversationStreamSyncError('Invalid conversation event revision')
	}
	return value
}

function arrayIndex(value: string, length: number, append = false): number {
	const index = Number(value)
	if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(index)
		|| index > length || (!append && index === length)) {
		throw new ConversationStreamSyncError('Invalid conversation event array index')
	}
	return index
}

function readChild(container: StreamContainer, key: string): unknown {
	if (Array.isArray(container)) return container[arrayIndex(key, container.length)]
	if (!Object.hasOwn(container, key)) {
		throw new ConversationStreamSyncError('Missing conversation event path')
	}
	return container[key]
}

function writeChild(container: StreamContainer, key: string, value: unknown) {
	if (Array.isArray(container)) container[arrayIndex(key, container.length, true)] = value
	else container[key] = value
}

/** Copy only modified paths; a frame never mutates the cached snapshot, even when a later operation is invalid. */
export function applyConversationPatch(current: StreamRecord, patch: unknown): StreamRecord {
	if (!Array.isArray(patch) || !patch.length) {
		throw new ConversationStreamSyncError('Invalid conversation event patch')
	}
	const copies = new WeakMap<StreamContainer, StreamContainer>()
	function writable(value: StreamContainer): StreamContainer {
		const existing = copies.get(value)
		if (existing) return existing
		const copy = Array.isArray(value) ? [...value] : {...value}
		copies.set(value, copy)
		copies.set(copy, copy)
		return copy
	}
	const next = writable(current) as StreamRecord
	for (const operation of patch) {
		if (!isStreamRecord(operation) || typeof operation.op !== 'string'
			|| !['set', 'remove', 'append'].includes(operation.op)
			|| !Array.isArray(operation.path) || !operation.path.length
			|| operation.path.some(key => typeof key !== 'string'
				|| ['__proto__', 'constructor', 'prototype'].includes(key))) {
			throw new ConversationStreamSyncError('Invalid conversation event operation')
		}
		const path = operation.path as string[]
		let container: StreamContainer = next
		for (const key of path.slice(0, -1)) {
			const child = readChild(container, key)
			if (!isContainer(child)) {
				throw new ConversationStreamSyncError('Invalid conversation event path')
			}
			const copy = writable(child)
			writeChild(container, key, copy)
			container = copy
		}
		const key = path[path.length - 1]
		if (operation.op === 'remove') {
			if (Array.isArray(container) || !Object.hasOwn(container, key)) {
				throw new ConversationStreamSyncError('Invalid conversation event removal')
			}
			delete container[key]
		} else if (operation.op === 'append') {
			const before = readChild(container, key)
			if (typeof before !== 'string' || typeof operation.value !== 'string') {
				throw new ConversationStreamSyncError('Invalid conversation event text append')
			}
			writeChild(container, key, before + operation.value)
		} else {
			if (!Object.hasOwn(operation, 'value')) {
				throw new ConversationStreamSyncError('Missing conversation event value')
			}
			writeChild(container, key, operation.value)
		}
	}
	return next
}
