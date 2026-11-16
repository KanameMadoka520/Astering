const errorCodes = new Set([
	'INVALID_OPTIONS',
	'MODEL_NOT_CONFIGURED',
	'MCP_NOT_CONFIGURED',
	'ACCOUNT_REVOKED',
	'CREDENTIAL_FAILED',
	'CONVERSATION_FAILED',
	'CONVERSATION_LIMIT',
	'AUTOMATION_REMOVED',
	'START_FAILED',
	'CONVERSATION_UNAVAILABLE',
	'AGENT_FAILED',
	'NEEDS_ATTENTION',
	'STOPPED',
	'INTERRUPTED',
	'TIMEOUT',
	'INTERNAL_ERROR',
	'UNKNOWN_RESULT',
	'NOTIFICATION_FAILED',
])

export function automationRunErrorKey(code?: string): string {
	return `automations.errors.${code && errorCodes.has(code) ? code : 'unknown'}`
}

export function automationNotificationKey(status?: string): string {
	const receipt = status && ['none', 'sent', 'failed', 'unknown'].includes(status) ? status : 'unknown'
	return `automations.notifications.${receipt}`
}
