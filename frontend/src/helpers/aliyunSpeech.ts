import type {AIConnection, AIProtocol, SpeechModel} from '@/client/queries/tcyAi'

export type AliyunSpeechRegion = 'beijing' | 'singapore'
export type AliyunSpeechAccess = AliyunSpeechRegion | 'workspace' | 'custom'

const paths: Partial<Record<AIProtocol, string>> = {
	'dashscope-asr': '/api-ws/v1/inference',
	'qwen-asr-realtime': '/api-ws/v1/realtime',
	'dashscope-file-asr': '/api/v1/services/aigc/multimodal-generation/generation',
}
const sharedHosts: Record<AliyunSpeechRegion, string> = {
	beijing: 'dashscope.aliyuncs.com',
	singapore: 'dashscope-intl.aliyuncs.com',
}
const workspaceRegions: Record<AliyunSpeechRegion, string> = {
	beijing: 'cn-beijing',
	singapore: 'ap-southeast-1',
}

export function supportsAliyunSpeechAccess(protocol: AIProtocol): boolean {
	return Boolean(paths[protocol])
}

export function speechConnectionCanProbe(connection: AIConnection): boolean {
	return connection.kind === 'transcription'
		&& (connection.protocol === 'dashscope-asr' || connection.protocol === 'qwen-asr-realtime')
}

export function speechWorkspaceRequired(connection: AIConnection): boolean {
	return connection.base_url.includes('{workspace_id}')
}

function parsedBase(connection: AIConnection): URL | undefined {
	try {
		return new URL(connection.base_url.trim())
	} catch {
		return undefined
	}
}

export function aliyunSpeechAccess(connection: AIConnection): AliyunSpeechAccess {
	const url = parsedBase(connection)
	if (!url || url.username || url.password || url.port || url.search || url.hash) return 'custom'
	const scheme = connection.protocol === 'dashscope-file-asr' ? 'https:' : 'wss:'
	if (url.protocol !== scheme || (url.pathname !== '/' && url.pathname.replace(/\/+$/, '') !== paths[connection.protocol])) {
		return 'custom'
	}
	if (url.hostname === sharedHosts.beijing) return 'beijing'
	if (url.hostname === sharedHosts.singapore) return 'singapore'
	if (/^(?:\{workspace_id\}|[a-z0-9-]+)\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/i.test(url.hostname)) {
		return 'workspace'
	}
	return 'custom'
}

export function aliyunSpeechBaseURL(
	protocol: AIProtocol,
	region: AliyunSpeechRegion,
	workspace = false,
): string | undefined {
	const path = paths[protocol]
	if (!path) return undefined
	const scheme = protocol === 'dashscope-file-asr' ? 'https' : 'wss'
	const host = workspace ? `{workspace_id}.${workspaceRegions[region]}.maas.aliyuncs.com` : sharedHosts[region]
	return `${scheme}://${host}${path}`
}

// Choosing a model never migrates an existing Alibaba host or credential destination.
// Known official endpoints may change their path/scheme to match the chosen wire protocol.
export function aliyunSpeechModelConnection(connection: AIConnection, model: SpeechModel): AIConnection {
	let baseURL = connection.base_url
	if (!baseURL.trim()) {
		baseURL = model.base_url
	} else if (connection.protocol !== model.protocol && supportsAliyunSpeechAccess(model.protocol)
		&& aliyunSpeechAccess(connection) !== 'custom') {
		const current = parsedBase(connection)!
		const scheme = model.protocol === 'dashscope-file-asr' ? 'https:' : 'wss:'
		baseURL = `${scheme}//${current.host}${paths[model.protocol]}`
	}
	return {
		...connection,
		model: model.id,
		protocol: model.protocol,
		base_url: baseURL,
	}
}
