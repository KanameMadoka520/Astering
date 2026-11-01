import {marked, type Tokens} from 'marked'
import type {Content, ContentText, TDocumentDefinitions} from 'pdfmake/interfaces'
import type {Conversation, ChatAttachment} from '@/client/generated'
import {fetchChatAttachment} from '@/client/queries/chatAttachments'
import {assistantInstant} from '@/helpers/assistantTime'

export function inlinePDF(text: string): ContentText['text'] {
	const parts: ContentText[] = []
	const visit = (tokens: ReturnType<typeof marked.Lexer.lexInline>, style: Partial<ContentText> = {}) => {
		for (const token of tokens) {
			if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
				visit((token as Tokens.Strong).tokens, {...style, ...(token.type === 'strong' ? {bold: true} : token.type === 'em' ? {italics: true} : {decoration: 'lineThrough' as const})})
			} else if (token.type === 'br') parts.push({text: '\n', ...style})
			else parts.push({text: ('text' in token ? token.text : token.raw) || '', ...style})
		}
	}
	visit(marked.Lexer.lexInline(text))
	return parts.length ? parts : ''
}

// No remote Markdown images are fetched. Only authenticated attachments are embedded.
export function markdownPDF(text: string): Content[] {
	return marked.lexer(text).flatMap((token): Content[] => {
		switch (token.type) {
			case 'space': return []
			case 'heading': return [{text: inlinePDF(token.text), bold: true, headlineLevel: 1, fontSize: Math.max(12, 21 - token.depth * 2), margin: [0, 10, 0, 5]}]
			case 'code': return [{text: token.text, fontSize: 9, color: '#334155', margin: [8, 5, 8, 8], preserveLeadingSpaces: true}]
			case 'table': return [{table: {headerRows: 1, widths: token.header.map(() => '*'), body: [(token as Tokens.Table).header.map(c => ({text: inlinePDF(c.text), bold: true})), ...(token as Tokens.Table).rows.map(row => row.map(c => ({text: inlinePDF(c.text)}))) ]}, layout: 'lightHorizontalLines', margin: [0, 6, 0, 8]}]
			case 'list': return [token.ordered ? {ol: (token as Tokens.List).items.map(item => ({text: inlinePDF(item.text)})), margin: [0, 4, 0, 8]} : {ul: (token as Tokens.List).items.map(item => ({text: inlinePDF(item.text)})), margin: [0, 4, 0, 8]}]
			case 'blockquote': return [{text: inlinePDF(token.text), color: '#64748b', margin: [12, 5, 0, 8]}]
			case 'hr': return [{text: '────────────────────', color: '#cbd5e1', margin: [0, 6, 0, 6]}]
			default: return [{text: inlinePDF(('text' in token ? token.text : token.raw) || ''), margin: [0, 0, 0, 7]}]
		}
	})
}
type PDFImage = {data: string, width: number, height: number}
async function imageData(blob: Blob): Promise<PDFImage> {
	const bitmap = await createImageBitmap(blob)
	try {
		const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height))
		const canvas = document.createElement('canvas')
		canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
		const ctx = canvas.getContext('2d')
		if (!ctx) throw new Error('Image conversion failed')
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
		return {data: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height}
	} finally { bitmap.close() }
}
export async function conversationPDF(c: Conversation, labels: {you: string, assistant: string, missing: string, unreadable: string, drafts: string, summary: string, generated: string, status: string, model: string, duration: string, steps: string, addition: string, pending: string, applied: string}, progress: (done: number, total: number, stage: 'files' | 'pdf') => void, signal: AbortSignal): Promise<Blob> {
	const {default: pdfMake} = await import('pdfmake/build/pdfmake')
	const font = new URL(`${import.meta.env.BASE_URL}fonts/NotoSansSC.ttf`, location.origin).href
	pdfMake.addFonts({NotoSansSC: {normal: font, bold: font, italics: font, bolditalics: font}})
	const all = [...(c.turns ?? []).flatMap(t => t.attachments ?? []), ...(c.draft_attachments ?? [])]
	const images = new Map<string, PDFImage>()
	const distinct = [...new Map(all.filter(a => /^image\/(png|jpeg|webp|gif)$/.test(a.mime || '')).map(a => [a.id!, a])).values()]
	let done = 0
	for (const a of distinct) {
		signal.throwIfAborted(); progress(done, distinct.length, 'files')
		if (!a.missing) {
			try { images.set(a.id!, await imageData(await fetchChatAttachment(c.id!, a.id!, signal))) }
			catch (error) { signal.throwIfAborted(); const e = error as {status?: number, response?: {status?: number}}; if (e.status !== 404 && e.response?.status !== 404) throw error }
		}
		done++; progress(done, distinct.length, 'files')
	}
	const files = (attachments: ChatAttachment[]): Content[] => attachments.flatMap(a => {
		if (a.missing) return [{text: `${labels.missing}: ${a.name}`, color: '#b91c1c', margin: [0, 6, 0, 8]}]
		const src = images.get(a.id!)
		if (src) return [{image: src.data, fit: [Math.min(480, src.width * .75), Math.min(440, src.height * .75)], margin: [0, 6, 0, 4]}, {text: a.name, fontSize: 9, color: '#64748b', margin: [0, 0, 0, 10]}] as Content[]
		return [{text: `${/^image\//.test(a.mime || '') ? labels.missing : labels.unreadable}: ${a.name}`, margin: [0, 6, 0, 8]}]
	})
	const at = (iso?: string) => {
		const instant = assistantInstant(iso)
		return instant ? ` · ${instant.full}` : ''
	}
	const content: Content[] = [{text: c.title || labels.assistant, fontSize: 22, bold: true, margin: [0, 0, 0, 12]}, {text: `${labels.generated}: ${assistantInstant(new Date().toISOString())!.full}\nID: ${c.id}`, fontSize: 9, color: '#64748b', margin: [0, 0, 0, 20]}]
	for (const turn of c.turns ?? []) {
		content.push({text: `${labels.you}${at(turn.started)}`, bold: true, headlineLevel: 1, color: '#0369a1', margin: [0, 14, 0, 6]}, {text: turn.prompt || '', margin: [0, 0, 0, 7]}, ...files(turn.attachments ?? []))
		for (const entry of turn.steering ?? []) {
			content.push({text: `${labels.you} · ${labels.addition}${at(entry.created)} · ${entry.status === 'applied' ? labels.applied : labels.pending}`, bold: true, color: '#0369a1', margin: [0, 10, 0, 6]}, {text: entry.message || '', margin: [0, 0, 0, 7]})
		}
		content.push({text: `${labels.assistant}${turn.status === 'running' ? '' : at(turn.finished)}`, bold: true, headlineLevel: 1, color: '#0369a1', margin: [0, 12, 0, 6]}, ...markdownPDF(turn.result?.reply || ''))
		if (turn.result?.error) content.push({text: turn.result.error, color: '#b91c1c'})
		content.push({text: `${labels.status}: ${turn.status} · ${labels.model}: ${turn.result?.model || '—'} · ${labels.duration}: ${((turn.result?.duration_ms || 0) / 1000).toFixed(2)} s\nTokens: ${turn.result?.usage?.reported ? `${turn.result.usage.input} input / ${turn.result.usage.output} output` : '—'}`, fontSize: 8, color: '#64748b', margin: [0, 6, 0, 12]})
		for (const action of turn.result?.actions ?? []) content.push({text: `${labels.steps}: ${action.tool}\n${action.arguments}\n${action.result}`, fontSize: 8, margin: [0, 3, 0, 6]})
	}
	if (c.draft_attachments?.length) content.push({text: labels.drafts, bold: true, margin: [0, 14, 0, 6]}, ...files(c.draft_attachments))
	for (const compact of c.compactions ?? []) content.push({text: labels.summary, bold: true, margin: [0, 14, 0, 6]}, ...markdownPDF(compact.summary || ''))
	signal.throwIfAborted(); progress(done, distinct.length, 'pdf')
	await new Promise(resolve => setTimeout(resolve, 50))
	const definition: TDocumentDefinitions = {info: {title: c.title || labels.assistant, author: 'vikunja-x'}, pageSize: 'A4', pageBreakBefore: (node, container) => node.headlineLevel === 1 && container.getFollowingNodesOnPage().length === 0, pageMargins: [40, 45, 40, 45], defaultStyle: {font: 'NotoSansSC', fontSize: 10, lineHeight: 1.3}, content, footer: (page, pages) => ({text: `${page} / ${pages}`, alignment: 'center', fontSize: 8, color: '#64748b', margin: [0, 12, 0, 0]})}
	const blob = await pdfMake.createPdf(definition).getBlob()
	signal.throwIfAborted()
	return blob
}
