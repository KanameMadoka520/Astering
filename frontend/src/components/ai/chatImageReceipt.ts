import type {Action, Operation} from '@/client/generated'

export type ChatImageReceipt = {
	taskId: number
	kind: 'inserted' | 'removed' | 'replaced' | 'moved' | 'updated'
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function id(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Only a settled native task response can support a task link or a file-retention notice. */
export function parseChatImageReceipt(action?: Action, operation?: Operation): ChatImageReceipt | undefined {
	if (action?.success !== true || operation?.external
		|| !['insert_chat_image', 'update_task_description_image', 'remove_task_description_image'].includes(action.tool ?? '')
		|| (operation && (operation.tool !== action.tool || operation.status !== 'succeeded' || operation.verified === false))) {
		return undefined
	}
	try {
		const args: unknown = JSON.parse(action.arguments ?? '')
		const result: unknown = JSON.parse(action.result ?? '')
		if (!record(args) || !record(result) || !id(args.id) || result.id !== args.id || !id(result.project_id)
			|| typeof result.description !== 'string'
			|| result.success === false || result.executed === false || result.uncertain === true
			|| result.isError === true || result.error || result.code) return undefined
		const taskId = args.id
		if (action.tool === 'insert_chat_image') return {
			taskId,
			kind: 'inserted',
		}
		if (action.tool === 'remove_task_description_image') return {
			taskId,
			kind: 'removed',
		}
		if (typeof args.attachment_id === 'string' && args.attachment_id !== '') return {
			taskId,
			kind: 'replaced',
		}
		if (typeof args.position === 'string' && ['start', 'end', 'before', 'after'].includes(args.position)) {
			return {
				taskId,
				kind: 'moved',
			}
		}
		if (typeof args.alt === 'string' || typeof args.title === 'string') return {
			taskId,
			kind: 'updated',
		}
	} catch {
		return undefined
	}
	return undefined
}
