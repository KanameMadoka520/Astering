import {queryOptions} from '@tanstack/vue-query'
import {
	tcyAiMcpSettings,
	tcyAiMcpSaveSettings,
	tcyAiMcpTest,
	type McpConnection,
	type McpConnectionWritable,
	type McpSettings,
	type McpTestResult,
	type McpToolDefinition,
} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {useSecretMutation} from './secretMutation'

// Normalize optional wire fields once at the query boundary. Secrets exist only in local drafts/mutations.
export type MCPConnection = Omit<Required<McpConnection>, '$schema' | 'read_tools'> & {
	read_tools: string[]
	api_key: NonNullable<McpConnectionWritable['api_key']>
}
export type MCPSettings = Omit<Required<McpSettings>, '$schema' | 'connections'> & {
	connections: MCPConnection[]
}
export type MCPTool = Required<Pick<McpToolDefinition, 'name' | 'description' | 'read_only' | 'destructive'>>
export type MCPTestResult = Omit<Required<McpTestResult>, '$schema' | 'tools'> & {
	tools: MCPTool[]
}

export const WALLOS_MCP_URL = 'https://wallos.tcymc.space/api/agent/mcp.php'

export const mcpSettingsKey = ['tcymc-ai', 'mcp-settings'] as const

export function normalizeMCPConnection(connection: McpConnection): MCPConnection {
	return {
		id: connection.id ?? '',
		name: connection.name ?? '',
		url: connection.url ?? '',
		transport: connection.transport === 'sse' ? 'sse' : 'streamable_http',
		preset: connection.preset === 'wallos' ? 'wallos' : 'custom',
		enabled: connection.enabled === true,
		allow_write: connection.allow_write === true,
		allow_delete: connection.allow_delete === true,
		read_tools: [...new Set((connection.read_tools ?? []).filter(tool => typeof tool === 'string' && tool))],
		api_key: '',
		has_key: connection.has_key === true,
		revision: connection.revision ?? '',
	}
}

export function normalizeMCPSettings(settings: McpSettings): MCPSettings {
	return {
		revision: settings.revision ?? 0,
		connections: (settings.connections ?? []).map(normalizeMCPConnection),
	}
}

export function sameMCPDestination(a: MCPConnection, b: MCPConnection) {
	return a.url === b.url && a.transport === b.transport
}

function writableConnection(connection: MCPConnection): McpConnectionWritable {
	return {
		id: connection.id,
		name: connection.name,
		url: connection.url,
		transport: connection.transport,
		preset: connection.preset,
		enabled: connection.enabled,
		allow_write: connection.allow_write,
		allow_delete: connection.allow_delete,
		read_tools: [...connection.read_tools],
		api_key: connection.api_key,
	}
}

export function mcpSettingsQuery() {
	return queryOptions({
		queryKey: mcpSettingsKey,
		queryFn: async ({signal}) => normalizeMCPSettings((await tcyAiMcpSettings({signal})).data),
		meta: {handlesError: true},
		refetchOnWindowFocus: true,
	})
}

export function useSaveMCPSettings() {
	return useSecretMutation(contextMutationOptions({
		mutationFn: async (settings: MCPSettings) =>
			normalizeMCPSettings((await tcyAiMcpSaveSettings({body: {
				revision: settings.revision,
				connections: settings.connections.map(writableConnection),
			}})).data),
		onSuccess: (data, _input, client) => { client.setQueryData(mcpSettingsKey, data) },
		onSettled: (_input, cache) => cache.invalidateQueries({queryKey: mcpSettingsKey}),
		toastError: () => false,
	}))
}

export function useTestMCPConnection() {
	return useSecretMutation(contextMutationOptions({
		mutationFn: async (connection: MCPConnection): Promise<MCPTestResult> => {
			const response = (await tcyAiMcpTest({body: writableConnection(connection)})).data
			return {
				endpoint: response.endpoint ?? '',
				server_name: response.server_name ?? '',
				server_version: response.server_version ?? '',
				tools: (response.tools ?? []).map(tool => ({
					name: tool.name ?? '',
					description: tool.description ?? '',
					read_only: tool.read_only === true,
					destructive: tool.destructive === true,
				})),
				matched: response.matched ?? 0,
				more_available: response.more_available === true,
			}
		},
		toastError: () => false,
	}))
}
