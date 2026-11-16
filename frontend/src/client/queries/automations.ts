import {queryOptions, useMutation, type QueryClient} from '@tanstack/vue-query'
import {
	automationList,
	automationCreate,
	automationRead,
	automationUpdate,
	automationDelete,
	automationRun,
	automationRuns,
	type Automation as ApiAutomation,
} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {removeFromPages, toPaginated, type Paginated} from './pagination'
import {normalizeOptions, type AssistantOptions} from '@/helpers/assistantProfiles'
import type {AutomationSchedule} from '@/helpers/automationSchedule'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	type ClientRequestContext,
} from '@/client/requestContext'
import {contextFetch} from '@/client/requestContextFetch'

export type AutomationDraft = {
	title: string
	prompt: string
	kind: 'agent' | 'reminder'
	enabled: boolean
	timezone: string
	schedule: AutomationSchedule
	options: AssistantOptions
	notify_on_success: boolean
	notify_on_failure: boolean
	max_runtime_seconds: number
}
export type Automation = AutomationDraft & {
	id: string
	revision: number
	created?: string
	updated?: string
	next_run?: string | null
	last_run_at?: string | null
	last_status?: string
}
export type AutomationRun = {
	id: string
	status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'canceled' | 'needs_attention'
	trigger: 'schedule' | 'manual'
	scheduled_for?: string
	started?: string
	finished?: string | null
	conversation_id?: string
	error_code?: string
	error?: string
	automation_revision: number
	notification_status?: 'none' | 'sent' | 'failed' | 'unknown'
}

export const automationKeys = {
	all: ['automations'] as const,
	scope: (context = captureClientRequestContext()) => ['automations', context] as const,
	lists: (context = captureClientRequestContext()) => ['automations', context, 'list'] as const,
	list: (page: number, context = captureClientRequestContext()) => ['automations', context, 'list', page] as const,
	detail: (id: string, context = captureClientRequestContext()) => ['automations', context, 'detail', id] as const,
	runs: (id: string, context = captureClientRequestContext()) => ['automations', context, 'runs', id] as const,
	runPage: (id: string, page: number, context = captureClientRequestContext()) =>
		['automations', context, 'runs', id, page] as const,
}

function normalizeAutomation(raw: ApiAutomation): Automation {
	return {
		id: raw.id ?? '',
		revision: raw.revision ?? 0,
		title: raw.title ?? '',
		prompt: raw.prompt ?? '',
		kind: raw.kind ?? 'agent',
		enabled: raw.enabled ?? false,
		timezone: raw.timezone ?? 'UTC',
		schedule: {
			...raw.schedule,
			kind: raw.schedule?.kind ?? 'daily',
			weekdays: raw.schedule?.weekdays ?? undefined,
		},
		options: normalizeOptions(raw.options ?? undefined),
		notify_on_success: raw.notify_on_success ?? false,
		notify_on_failure: raw.notify_on_failure ?? true,
		max_runtime_seconds: raw.max_runtime_seconds ?? 3600,
		created: raw.created,
		updated: raw.updated,
		next_run: raw.next_run,
		last_run_at: raw.last_run_at,
		last_status: raw.last_status,
	}
}

export function automationsQuery(page: number, context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: automationKeys.list(page, context),
		queryFn: async ({signal}): Promise<Paginated<Automation>> => {
			assertClientRequestContext(context)
			const {data} = await automationList({
				query: {page},
				signal,
				fetch: contextFetch(context),
			})
			assertClientRequestContext(context)
			const result = toPaginated(data, page)
			return {
				...result,
				items: result.items.map(normalizeAutomation),
			}
		},
		refetchInterval: 15_000,
		meta: {handlesError: true},
	})
}

export function automationQuery(id: string, context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: automationKeys.detail(id, context),
		queryFn: async ({signal}) => {
			assertClientRequestContext(context)
			const {data} = await automationRead({
				path: {id},
				signal,
				fetch: contextFetch(context),
			})
			assertClientRequestContext(context)
			return normalizeAutomation(data)
		},
		enabled: !!id,
		refetchInterval: 10_000,
		meta: {handlesError: true},
	})
}

export function automationRunsQuery(id: string, page: number, context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: automationKeys.runPage(id, page, context),
		queryFn: async ({signal}): Promise<Paginated<AutomationRun>> => {
			assertClientRequestContext(context)
			const {data} = await automationRuns({
				path: {id},
				query: {page},
				signal,
				fetch: contextFetch(context),
			})
			assertClientRequestContext(context)
			const result = toPaginated(data, page)
			return {
				...result,
				items: result.items.map(raw => ({
					...raw,
					id: raw.id ?? '',
					status: raw.status ?? 'failed',
					trigger: raw.trigger ?? 'manual',
					automation_revision: raw.automation_revision ?? 0,
					notification_status: ['none', 'sent', 'failed', 'unknown'].includes(raw.notification_status ?? '')
						? raw.notification_status as AutomationRun['notification_status'] : 'unknown',
				})),
			}
		},
		enabled: !!id,
		refetchInterval: query => query.state.data?.items.some(run => run.status === 'running') ? 3_000 : 15_000,
		meta: {handlesError: true},
	})
}

function patchAutomation(client: QueryClient, value: Automation, context: ClientRequestContext) {
	client.setQueryData<Automation>(automationKeys.detail(value.id, context), old => old ? value : old)
	client.setQueriesData<Paginated<Automation>>({queryKey: automationKeys.lists(context)}, current => current && {
		...current,
		items: current.items.map(row => row.id === value.id ? value : row),
	})
}

function writableAutomationSpec(draft: AutomationDraft): AutomationDraft {
	// A previously read record is also assignable to AutomationDraft. Never echo
	// server-owned metadata into the strict create/update request schema.
	return {
		title: draft.title,
		prompt: draft.prompt,
		kind: draft.kind,
		enabled: draft.enabled,
		timezone: draft.timezone,
		schedule: draft.schedule,
		options: draft.options,
		notify_on_success: draft.notify_on_success,
		notify_on_failure: draft.notify_on_failure,
		max_runtime_seconds: draft.max_runtime_seconds,
	}
}

export function saveAutomationMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: {
			id?: string
			expected_revision?: number
			body: AutomationDraft
		}, {request}) => {
			const body = writableAutomationSpec(input.body)
			const {data} = input.id
				? await automationUpdate({
					path: {id: input.id},
					body: {
						...body,
						expected_revision: input.expected_revision ?? 0,
					},
					fetch: contextFetch(request),
				})
				: await automationCreate({
					body,
					fetch: contextFetch(request),
				})
			return normalizeAutomation(data)
		},
		onSuccess: (value, _input, client) => patchAutomation(client, value, captureClientRequestContext()),
		onSettled: (_input, client) => client.invalidateQueries({queryKey: automationKeys.scope()}),
		toastError: () => false,
	})
}
export function useSaveAutomation() { return useMutation(saveAutomationMutationOptions()) }

export function deleteAutomationMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: {
			id: string
			expected_revision: number
		}, {request}) => {
			await automationDelete({
				path: {id: input.id},
				body: {expected_revision: input.expected_revision},
				fetch: contextFetch(request),
			})
			return input.id
		},
		onSuccess: (id, _input, client) => {
			client.setQueryData<Automation | null>(automationKeys.detail(id), old => old === undefined ? old : null)
			removeFromPages<Automation>(client, automationKeys.lists(), row => row.id === id)
		},
		onSettled: (_input, client) => client.invalidateQueries({queryKey: automationKeys.lists()}),
		toastError: () => false,
	})
}
export function useDeleteAutomation() { return useMutation(deleteAutomationMutationOptions()) }

export function runAutomationMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (input: {
			id: string
			request_id: string
		}, {request}) => (await automationRun({
			path: {id: input.id},
			body: {request_id: input.request_id},
			fetch: contextFetch(request),
		})).data,
		onSettled: (input, client) => Promise.all([
			client.invalidateQueries({queryKey: automationKeys.detail(input.id)}),
			client.invalidateQueries({queryKey: automationKeys.lists()}),
			client.invalidateQueries({queryKey: automationKeys.runs(input.id)}),
		]),
		toastError: () => false,
	})
}
export function useRunAutomation() { return useMutation(runAutomationMutationOptions()) }
