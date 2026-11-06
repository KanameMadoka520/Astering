import {
	queryOptions,
	useMutation,
	type QueryClient,
} from '@tanstack/vue-query'
import {
	projectVersionsList,
	projectVersionsCreate,
	projectVersionsRead,
	projectVersionsPreview,
	projectVersionsRestore,
	projectVersionsDelete,
	projectVersionEntityRead,
	projectVersionEntitiesList,
	projectVersionFileRead,
	tasksRead,
	type ProjectVersionSummary as ApiProjectVersion,
	type ProjectVersionActor,
	type ProjectVersionPreview as ApiProjectVersionPreview,
	type ProjectVersionChange as ApiProjectVersionChange,
	type ProjectVersionRestoreResult as ApiProjectVersionRestore,
	type ProjectVersionEntityReadData,
} from '@/client/generated'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	isRequestContextAbort,
	type ClientRequestContext,
} from '@/client/requestContext'
import {contextMutationOptions} from './contextMutation'
import {expectBlob} from './blobResponse'
import {projectKeys} from './projects'
import {reconcileServerBoards} from './taskMutations'
import {agentBoardKeys} from './kanbanServerRefresh'
import {
	bucketKeys,
	kanbanKeys,
} from './kanban'
import {
	isStaleTask,
	isTaskDeleted,
	recordServerTaskWrite,
	removeTaskEverywhere,
	replaceTaskEverywhere,
	reviveRestoredTasks,
} from './taskCache'
import {taskKeys} from './tasks'
import {projectTimelineKeys} from './projectTimeline'
import {projectAnnouncementKeys} from './projectAnnouncements'
import {invalidateCalendarTasks} from './calendar'
import {taskRoutineKeys} from './taskRoutines'
import {invalidateDrive} from './drive'
import {
	error,
	getErrorText,
} from '@/message'
import {i18n} from '@/i18n'
import {ApiError} from '@/client/problem'
import {
	toPaginated,
	type Paginated,
} from './pagination'

export type ProjectVersion = Required<Omit<ApiProjectVersion, '$schema' | 'created' | 'created_by'>> & {
	created?: string,
	created_by: Required<Omit<ProjectVersionActor, '$schema'>>,
}
export type ProjectVersionEntityKind = ProjectVersionEntityReadData['path']['kind']
export type ProjectVersionChange = Required<Omit<ApiProjectVersionChange, '$schema' | 'fields' | 'kind'>> & {
	fields: string[],
	kind: ProjectVersionEntityKind,
}
export type ProjectVersionPreview = Required<Omit<ApiProjectVersionPreview, '$schema' | 'changes' | 'preserved'>> & {
	changes: Paginated<ProjectVersionChange>,
	preserved: Omit<NonNullable<ApiProjectVersionPreview['preserved']>, '$schema'> & Required<Pick<
		NonNullable<ApiProjectVersionPreview['preserved']>, 'comments' | 'checkins' | 'progress' | 'time_entries' | 'permissions'
	>>,
}
export type ProjectVersionRestore = Required<Omit<ApiProjectVersionRestore,
	'$schema' | 'project_id' | 'changed_task_ids' | 'removed_task_ids' | 'version'
>> & {
	project_id: number,
	changed_task_ids: number[],
	removed_task_ids: number[],
	version: ProjectVersion,
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`Project checkpoint response is missing ${label}`)
	return value
}

export function projectVersionConflictText(code?: string) {
	return code && i18n.global.te(`projectVersions.errors.${code}`)
		? i18n.global.t(`projectVersions.errors.${code}`)
		: i18n.global.t('projectVersions.conflicts')
}

export function projectVersionErrorText(cause: unknown) {
	if (cause instanceof ApiError && typeof cause.detail === 'string'
		&& i18n.global.te(`projectVersions.errors.${cause.detail}`)) {
		return i18n.global.t(`projectVersions.errors.${cause.detail}`)
	}
	return getErrorText(cause)
}
export function normalizeProjectVersion(data: ApiProjectVersion): ProjectVersion {
	return {
		...data,
		id: required(data.id, 'id'),
		project_id: required(data.project_id, 'project_id'),
		sequence: required(data.sequence, 'sequence'),
		name: required(data.name, 'name'),
		kind: required(data.kind, 'kind'),
		content_hash: required(data.content_hash, 'content_hash'),
		schema_version: required(data.schema_version, 'schema_version'),
		restored_from_version_id: data.restored_from_version_id ?? 0,
		task_count: data.task_count ?? 0,
		view_count: data.view_count ?? 0,
		bucket_count: data.bucket_count ?? 0,
		attachment_count: data.attachment_count ?? 0,
		file_count: data.file_count ?? 0,
		referenced_file_bytes: data.referenced_file_bytes ?? 0,
		content_bytes: data.content_bytes ?? 0,
		new_object_bytes: data.new_object_bytes ?? 0,
		created_by: {
			id: data.created_by?.id ?? 0,
			username: data.created_by?.username ?? '',
			name: data.created_by?.name ?? '',
		},
	}
}
const ENTITY_KINDS: ProjectVersionEntityKind[] = [
	'project', 'task', 'view', 'bucket', 'attachment', 'position',
	'announcement', 'routine', 'assignee', 'label', 'reminder', 'relation',
]
function entityKind(kind: string): ProjectVersionEntityKind {
	const known = ENTITY_KINDS.find(value => value === kind)
	if (!known) throw new Error('Unknown project checkpoint entity kind')
	return known
}
function normalizePreview(data: ApiProjectVersionPreview, page: number): ProjectVersionPreview {
	const preserved = required(data.preserved, 'preserved')
	return {
		...data,
		project_id: required(data.project_id, 'project_id'),
		target_version_id: required(data.target_version_id, 'target_version_id'),
		current_hash: required(data.current_hash, 'current_hash'),
		target_hash: required(data.target_hash, 'target_hash'),
		plan_hash: required(data.plan_hash, 'plan_hash'),
		can_restore: required(data.can_restore, 'can_restore'),
		summary: required(data.summary, 'summary'),
		conflicts: data.conflicts ?? [],
		changes: {
			...toPaginated(data.changes ?? {}, page),
			items: (data.changes?.items ?? []).map(change => ({
				...change,
				kind: entityKind(required(change.kind, 'kind')),
				entity_id: required(change.entity_id, 'entity_id'),
				title: change.title ?? '',
				operation: required(change.operation, 'operation'),
				fields: change.fields ?? [],
			})),
		},
		preserved: {
			...preserved,
			comments: required(preserved.comments, 'comments'),
			checkins: required(preserved.checkins, 'checkins'),
			progress: required(preserved.progress, 'progress'),
			time_entries: required(preserved.time_entries, 'time_entries'),
			permissions: required(preserved.permissions, 'permissions'),
		},
	}
}

export const projectVersionKeys = {
	all: ['project-versions'] as const,
	project: (project: number) => [...projectVersionKeys.all, project] as const,
	lists: (project: number) => [...projectVersionKeys.project(project), 'list'] as const,
	list: (project: number, page: number) => [...projectVersionKeys.lists(project), page] as const,
	version: (project: number, version: number) => [...projectVersionKeys.project(project), version] as const,
	detail: (project: number, version: number) => [...projectVersionKeys.version(project, version), 'summary'] as const,
	preview: (project: number, version: number, page: number) =>
		[...projectVersionKeys.version(project, version), 'preview', page] as const,
	entity: (project: number, version: number, kind: string, entity: string) =>
		[...projectVersionKeys.version(project, version), 'entity', kind, entity] as const,
}

export function projectVersionsQuery(project: number, page: number) {
	return queryOptions({
		queryKey: projectVersionKeys.list(project, page),
		queryFn: async ({signal}) => {
			const {data} = await projectVersionsList({
				path: {project},
				query: {page},
				signal,
			})
			return {
				...toPaginated(data, page),
				items: (data.items ?? []).map(normalizeProjectVersion),
			}
		},
		enabled: project > 0,
		meta: {handlesError: true},
	})
}

export function projectVersionQuery(project: number, version: number) {
	return queryOptions({
		queryKey: projectVersionKeys.detail(project, version),
		queryFn: async ({signal}) => normalizeProjectVersion((await projectVersionsRead({
			path: {
				project,
				version,
			},
			signal,
		})).data),
		enabled: project > 0 && version > 0,
		meta: {handlesError: true},
	})
}

export function projectVersionPreviewQuery(project: number, version: number, page: number) {
	return queryOptions({
		queryKey: projectVersionKeys.preview(project, version, page),
		queryFn: async ({signal}) => normalizePreview((await projectVersionsPreview({
			path: {
				project,
				version,
			},
			query: {page},
			signal,
		})).data, page),
		enabled: project > 0 && version > 0,
		staleTime: 0,
		meta: {handlesError: true},
	})
}

export function projectVersionEntityQuery(project: number, version: number, kind: string, entity: string) {
	return queryOptions({
		queryKey: projectVersionKeys.entity(project, version, kind, entity),
		queryFn: async ({signal}) => (await projectVersionEntityRead({
			path: {
				project,
				version,
				kind: entityKind(kind),
				entity,
			},
			signal,
		})).data,
		enabled: project > 0 && version > 0 && kind !== '' && entity !== '',
		staleTime: 0,
		meta: {handlesError: true},
	})
}

export function projectVersionEntitiesQuery(project: number, version: number, page: number, enabled: boolean) {
	return queryOptions({
		queryKey: [...projectVersionKeys.version(project, version), 'entities', page],
		queryFn: async ({signal}) => {
			const {data} = await projectVersionEntitiesList({
				path: {
					project,
					version,
				},
				query: {page},
				signal,
			})
			return {
				...toPaginated(data, page),
				items: (data.items ?? []).map(item => ({
					...item,
					kind: entityKind(required(item.kind, 'kind')),
					entity_id: required(item.entity_id, 'entity_id'),
					title: item.title ?? '',
				})),
			}
		},
		enabled: enabled && project > 0 && version > 0,
		meta: {handlesError: true},
	})
}

export function projectVersionFileQuery(project: number, version: number, file: number) {
	return queryOptions({
		queryKey: [...projectVersionKeys.version(project, version), 'file', file],
		queryFn: ({signal}) => fetchProjectVersionFile(project, version, file, signal),
		// Recheck current project access and this checkpoint's reference on each download.
		staleTime: 0,
		gcTime: 60_000,
		retry: false,
		enabled: project > 0 && version > 0 && file > 0,
		meta: {handlesError: true},
	})
}

export async function fetchProjectVersionFile(project: number, version: number, file: number, signal?: AbortSignal) {
	const owner = captureClientRequestContext()
	signal?.throwIfAborted()
	const {data} = await projectVersionFileRead({
		path: {
			project,
			version,
			file,
		},
		parseAs: 'blob',
		signal,
	})
	assertClientRequestContext(owner)
	signal?.throwIfAborted()
	return expectBlob(data, 'Project checkpoint file')
}

export function createProjectVersionMutationOptions(owner?: ClientRequestContext) {
	return contextMutationOptions({
		mutationFn: async (input: {
			project: number,
			name: string,
			requestId: string,
		}) =>
			normalizeProjectVersion((await projectVersionsCreate({
				path: {project: input.project},
				body: {
					name: input.name,
					request_id: input.requestId,
				},
			})).data),
		onSettled: (input, client) => client.invalidateQueries({queryKey: projectVersionKeys.lists(input.project)}),
		toastError: () => false,
	}, owner)
}

export function useCreateProjectVersionMutation(owner?: ClientRequestContext) {
	return useMutation(createProjectVersionMutationOptions(owner))
}

/** UI restores and Arona receipts use the same local reconciliation, including mounted deleted-task editors. */
export async function applyProjectVersionRestoreResult(
	client: QueryClient,
	result: Pick<ProjectVersionRestore, 'project_id' | 'changed_task_ids' | 'removed_task_ids'>,
) {
	const owner = captureClientRequestContext()
	const changed = new Set(result.changed_task_ids ?? [])
	const removed = new Set(result.removed_task_ids ?? [])
	const affected = new Set([...changed, ...removed])
	const projects = new Set([result.project_id])
	const boards = agentBoardKeys(client, {
		projectIds: [result.project_id],
		taskIds: [...changed, ...removed],
	})
	const detailIds = new Set(client.getQueryCache().findAll({queryKey: taskKeys.details})
		.filter(query => query.state.data !== undefined || query.getObserversCount() > 0)
		.map(query => Number(query.queryKey[2])))
	const loaded = [...affected].filter(id => isTaskDeleted(client, id) || detailIds.has(id))
	let refreshFailed = false
	// Only cached details need individual reads; lists and boards refresh their already loaded pages together.
	for (let offset = 0; offset < loaded.length; offset += 8) {
		const batch = loaded.slice(offset, offset + 8)
		const tasks = await Promise.allSettled(batch.map(id => tasksRead({path: {task: id}})))
		assertClientRequestContext(owner)
		for (const [index, task] of tasks.entries()) {
			if (task.status === 'rejected') {
				if (task.reason instanceof ApiError && [403, 404].includes(task.reason.status)) {
					removeTaskEverywhere(client, batch[index])
				} else refreshFailed = true
				continue
			}
			if (task.value.data.id !== batch[index]) {
				refreshFailed = true
				continue
			}
			if (isStaleTask(client, task.value.data)) continue
			if (task.value.data.id !== undefined) reviveRestoredTasks(client, [task.value.data.id])
			if (task.value.data.project_id) projects.add(task.value.data.project_id)
			recordServerTaskWrite(client, task.value.data)
			replaceTaskEverywhere(client, task.value.data)
		}
	}
	assertClientRequestContext(owner)
	const affects = (project: number | null | undefined) => !project || project < 0 || projects.has(project)
	await Promise.all([
		client.invalidateQueries({
			queryKey: projectKeys.detail(result.project_id),
			exact: true,
		}),
		client.invalidateQueries({queryKey: projectKeys.list()}),
		client.invalidateQueries({queryKey: projectVersionKeys.project(result.project_id)}),
		client.invalidateQueries({queryKey: projectTimelineKeys.all}),
		client.invalidateQueries({queryKey: projectAnnouncementKeys.detail(result.project_id)}),
		client.invalidateQueries({
			queryKey: taskKeys.details,
			predicate: query => affected.has(Number(query.queryKey[2])),
		}),
		client.invalidateQueries({
			queryKey: taskRoutineKeys.all,
			predicate: query => affected.has(Number(query.queryKey[1])),
		}),
		client.invalidateQueries({
			queryKey: taskKeys.lists,
			predicate: query => affects(taskKeys.projectOf(query.queryKey)),
		}),
		client.invalidateQueries({
			queryKey: taskKeys.allLists,
			predicate: query => affects(taskKeys.projectOf(query.queryKey)),
		}),
		client.invalidateQueries({
			queryKey: bucketKeys.all,
			predicate: query => query.queryKey[1] === result.project_id,
		}),
		client.invalidateQueries({
			queryKey: kanbanKeys.all,
			refetchType: 'none',
			predicate: query => affects(kanbanKeys.projectOf(query.queryKey)),
		}),
		invalidateCalendarTasks(client),
		invalidateDrive(client),
	])
	assertClientRequestContext(owner)
	await reconcileServerBoards(client, boards)
	assertClientRequestContext(owner)
	if (refreshFailed) error({message: i18n.global.t('projectVersions.refreshFailed')})
}

export function restoreProjectVersionMutationOptions(owner?: ClientRequestContext) {
	const refreshes = new WeakMap<object, Promise<unknown>>()
	return contextMutationOptions({
		mutationFn: async (input: {
			project: number,
			version: number,
			currentHash: string,
			planHash: string,
			requestId: string,
		}): Promise<ProjectVersionRestore> => {
			const {data} = await projectVersionsRestore({
				path: {
					project: input.project,
					version: input.version,
				},
				body: {
					expected_current_hash: input.currentHash,
					plan_hash: input.planHash,
					request_id: input.requestId,
				},
			})
			if (data.verified !== true) throw new Error('Project restore was not verified')
			return {
				...data,
				project_id: required(data.project_id, 'project_id'),
				before_version_id: required(data.before_version_id, 'before_version_id'),
				restored_from_version_id: required(data.restored_from_version_id, 'restored_from_version_id'),
				current_hash: required(data.current_hash, 'current_hash'),
				id_map: required(data.id_map, 'id_map'),
				verified: true,
				version: normalizeProjectVersion(required(data.version, 'version')),
				changed_task_ids: data.changed_task_ids ?? [],
				removed_task_ids: data.removed_task_ids ?? [],
			}
		},
		onSuccess: (data, input, client) => {
			// The restore already committed; a failed refresh must not turn it into a failed restore/retry.
			refreshes.set(input, applyProjectVersionRestoreResult(client, data).catch(cause => {
				if (!isRequestContextAbort(cause)) error(cause)
			}))
		},
		onSettled: async (input, client) => {
			await refreshes.get(input)
			await client.invalidateQueries({queryKey: projectVersionKeys.project(input.project)})
		},
		toastError: () => false,
	}, owner)
}

export function useRestoreProjectVersionMutation(owner?: ClientRequestContext) {
	return useMutation(restoreProjectVersionMutationOptions(owner))
}

export function deleteProjectVersionMutationOptions(owner?: ClientRequestContext) {
	return contextMutationOptions({
		mutationFn: async (input: {
			project: number,
			version: number,
			confirmName: string,
		}) => {
			await projectVersionsDelete({
				path: {
					project: input.project,
					version: input.version,
				},
				body: {confirm_name: input.confirmName},
			})
		},
		onSettled: (input, client) => client.invalidateQueries({queryKey: projectVersionKeys.project(input.project)}),
		toastError: () => false,
	}, owner)
}

export function useDeleteProjectVersionMutation(owner?: ClientRequestContext) {
	return useMutation(deleteProjectVersionMutationOptions(owner))
}
