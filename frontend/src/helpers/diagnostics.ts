import {ref, shallowRef} from 'vue'
import type {ChatTurn, Conversation} from '@/client/generated'
import {VERSION} from '@/version.json'
import {captureClientRequestContext, isRequestContextAbort} from '@/client/requestContext'

export type Diagnostic = {
	id: string
	time: string
	kind: 'http' | 'agent' | 'browser'
	code: string
	count: number
	metadata: Record<string, unknown>
	// Technical details stay in memory; exported only after the user opts in.
	detail?: unknown
}
export const diagnostics = shallowRef<Diagnostic[]>([])
export const diagnosticsOpen = ref(false)
export const selectedDiagnostic = ref('')
let owner = ''
const sensitiveKey = /^(authorization|proxy.authorization|cookies?|set.cookie|api.?key|password|passwd|secret|access.?token|refresh.?token|token|audio|native|signature|headers)$/i
export function redactDiagnostic(value: unknown, depth = 0): unknown {
	if (depth > 20) return '[depth limit]'
	if (typeof value === 'string') {
		if (value.length <= 64000 && /^\s*[[{]/.test(value)) {
			try { return JSON.stringify(redactDiagnostic(JSON.parse(value), depth + 1)) } catch { /* Plain technical text below. */ }
		}
		return value.slice(0, 64000)
			.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
			.replace(/\b(?:sk-|ghp_|github_pat_|tk_)[A-Za-z0-9_-]{6,}/g, '[REDACTED]')
			.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
			.replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s&,;"'<>]+/gi, '$1[REDACTED]')
			.replace(/((?:api[_-]?key|password|secret|token)["']?\s*:\s*["'])[^"']+/gi, '$1[REDACTED]')
			.replace(/https?:\/\/[^\s"'<>]+/gi, url => safeDiagnosticURL(url))
	}
	if (Array.isArray(value)) return value.slice(0, 200).map(v => redactDiagnostic(v, depth + 1))
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, v]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactDiagnostic(v, depth + 1)]))
	return value
}
export function safeDiagnosticURL(value: string): string {
	try {
		const url = new URL(value, window.location.origin)
		return `${url.origin}${url.pathname}`
	} catch { return '[invalid URL]' }
}
export function clearDiagnostics() {
	diagnostics.value = []
	selectedDiagnostic.value = ''
	diagnosticsOpen.value = false
}
function ensureOwner() {
	const current = captureClientRequestContext()
	const key = JSON.stringify([current.identity, current.authSessionEpoch, current.apiBaseUrl])
	if (owner !== key) { clearDiagnostics(); owner = key }
}
function remember(input: Omit<Diagnostic, 'id' | 'time' | 'count'>, open = false) {
	ensureOwner()
	const fingerprint = JSON.stringify([input.kind, input.code, input.metadata])
	const previous = diagnostics.value.find(item => JSON.stringify([item.kind, item.code, item.metadata]) === fingerprint)
	const entry: Diagnostic = {
		...input, id: previous?.id ?? crypto.randomUUID(), time: new Date().toISOString(), count: (previous?.count ?? 0) + 1,
		metadata: redactDiagnostic(input.metadata) as Record<string, unknown>, detail: redactDiagnostic(input.detail),
	}
	diagnostics.value = [entry, ...diagnostics.value.filter(item => item.id !== entry.id)].slice(0, 30)
	if (open) { selectedDiagnostic.value = entry.id; diagnosticsOpen.value = true }
	return entry
}
export function captureHttpDiagnostic(error: unknown, response?: Response, request?: Request) {
	if (isRequestContextAbort(error)) return
	const body = error as {code?: unknown; message?: unknown; detail?: unknown; status?: unknown} | null
	const html = typeof error === 'string' && /<!doctype|<html/i.test(error)
	remember({kind: 'http', code: html ? 'PROXY_HTML' : `HTTP_${response?.status ?? body?.status ?? 'NETWORK'}`, metadata: {
		method: request?.method, endpoint: safeDiagnosticURL(request?.url ?? response?.url ?? '/'),
		status: response?.status, domain_code: body?.code, content_type: response?.headers.get('Content-Type'),
		request_id: response?.headers.get('X-Request-ID'), cf_ray: response?.headers.get('CF-Ray'),
	}, detail: html ? 'Proxy returned an HTML block page instead of JSON. Check site WAF rules.' : (error instanceof Error ? error.message : body?.detail ?? body?.message ?? error)})
}
export function openAgentDiagnostic(turn: ChatTurn) {
	const r = turn.result
	remember({kind: 'agent', code: r?.error_code || r?.operations?.find(op => op.error_code)?.error_code || turn.status || 'AGENT', metadata: {
		turn_id: turn.id, trace_id: r?.trace_id, status: turn.status, stage: r?.stage,
		model: r?.model, requested_model: r?.requested_model, protocol: r?.protocol,
		endpoint: safeDiagnosticURL(r?.endpoint ?? '/'), duration_ms: r?.duration_ms,
		first_token_ms: r?.first_token_ms, first_text_ms: r?.first_text_ms, usage: r?.usage, budget: r?.budget, configuration: r?.configuration,
		steps: r?.steps?.map(step => ({round: step.round, context_window: step.context_window, max_output_tokens: step.max_output_tokens, stop_reason: step.stop_reason, model: step.model, http_status: step.http_status, request_id: step.request_id, duration_ms: step.duration_ms, first_token_ms: step.first_token_ms, first_text_ms: step.first_text_ms, usage: step.usage, loaded_tools: step.loaded_tools, tool_schema_bytes: step.tool_schema_bytes, catalog_schema_bytes: step.catalog_schema_bytes, catalog_tool_count: step.catalog_tool_count})),
		operations: r?.operations?.map(op => ({id: op.id, tool: op.tool, status: op.status, error_code: op.error_code, approved: op.approved, verified: op.verified, units: op.units})),
		actions: r?.actions?.map(a => ({tool: a.tool, round: a.round, success: a.success, duration_ms: a.duration_ms})),
	}, detail: {error: r?.error, pending: r?.pending, actions: r?.actions}}, true)
}
export function openCompactDiagnostic(conversation: Conversation) {
	const progress = conversation.compact_progress
	remember({kind: 'agent', code: progress?.error_code || (conversation.compact_error ? 'COMPACT_FAILED' : 'COMPACT'), metadata: {
		conversation_id: conversation.id, stage: 'compaction', ...progress,
		endpoint: safeDiagnosticURL(progress?.endpoint ?? '/'),
	}, detail: {error: conversation.compact_error}}, true)
}
export function openDiagnostics() { ensureOwner(); diagnosticsOpen.value = true }
export function diagnosticReport(entry: Diagnostic | undefined, includeDetails = false) {
	return JSON.stringify(redactDiagnostic({
		format: 'astering-diagnostic-v1', version: VERSION, exported_at: new Date().toISOString(),
		page: safeDiagnosticURL(window.location.href), viewport: {width: window.innerWidth, height: window.innerHeight},
		browser: navigator.userAgent, language: document.documentElement.lang,
		entry: entry ? {...entry, detail: includeDetails ? entry.detail : undefined} : undefined,
		includes_private_details: includeDetails,
	}), null, 2)
}
export function captureBrowserDiagnostic(error: unknown, phase: string) {
	if (isRequestContextAbort(error)) return
	remember({kind: 'browser', code: 'VUE_ERROR', metadata: {phase}, detail: error instanceof Error ? error.message : String(error)})
}
export function installBrowserDiagnostics() {
	const error = (event: ErrorEvent) => remember({kind: 'browser', code: 'BROWSER_ERROR', metadata: {file: safeDiagnosticURL(event.filename || '/'), line: event.lineno, column: event.colno}, detail: event.message})
	const rejection = (event: PromiseRejectionEvent) => {
		if (isRequestContextAbort(event.reason)) return
		remember({kind: 'browser', code: 'UNHANDLED_REJECTION', metadata: {}, detail: event.reason instanceof Error ? event.reason.message : String(event.reason)})
	}
	window.addEventListener('error', error)
	window.addEventListener('unhandledrejection', rejection)
	return () => { window.removeEventListener('error', error); window.removeEventListener('unhandledrejection', rejection) }
}
