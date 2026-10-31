// Tools whose labels live under agent.tools.<name>.
const AGENT_TOOLS = [
	'list_project_history',
	'list_project_timeline',
	'set_project_completed',
	'update_project',
	'find_tools',
	'ask_user',
	'get_project',
	'list_labels',
	'list_comments',
	'list_project_users',
	'bulk_update_tasks',
	'create_label',
	'add_task_label',
	'remove_task_label',
	'add_comment',
	'assign_task',
	'unassign_task',
	'relate_tasks',
	'unrelate_tasks',
	'get_project_announcement',
	'update_project_announcement',
	'get_task_routine',
	'configure_task_routine',
	'check_in_task_routine',
	'get_task_routine_history',
	'delegate_tasks',
	'read_tool_result',
	'view_attachment',
	'list_project_views',
	'list_buckets',
	'create_bucket',
	'update_bucket',
	'move_task_to_bucket',
	'set_view_buckets',
	'delete_bucket',
] as const

// Deleting is irreversible; everything else Arona writes can be edited back.
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(['delete_task', 'delete_bucket'])

export function toolLabels(t: (key: string) => string): Record<string, string> {
	return {
		web_search: t('webSearch.title'),
		invoke_tool: t('cacheEfficiency.callTool'),
		list_projects: t('tcymc.text.find_projects'),
		list_tasks: t('tcymc.text.find_tasks'),
		get_task: t('tcymc.text.read_task'),
		create_project: t('tcymc.text.create_project'),
		create_task: t('tcymc.text.create_task'),
		update_task: t('tcymc.text.update_task'),
		delete_task: t('tcymc.text.delete_task'),
		...Object.fromEntries(AGENT_TOOLS.map(name => [name, t(`agent.tools.${name}`)])),
	}
}
