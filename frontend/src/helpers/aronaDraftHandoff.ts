import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'

let pending: {id: string, text: string, owner: ClientRequestContext} | undefined

/** The URL carries only a one-use identifier; personal source text stays in this tab's memory. */
export function stageAronaDraftHandoff(text: string): string {
	const id = crypto.randomUUID()
	pending = {id, text, owner: captureClientRequestContext()}
	return id
}

export function takeAronaDraftHandoff(id: unknown): string {
	const candidate = pending
	if (!candidate || candidate.id !== id) return ''
	pending = undefined
	return isClientRequestContextCurrent(candidate.owner) ? candidate.text : ''
}

export function appendAronaDraft(existing: string, incoming: string): string {
	return incoming ? [existing, incoming].filter(text => text.trim() !== '').join('\n\n') : existing
}
