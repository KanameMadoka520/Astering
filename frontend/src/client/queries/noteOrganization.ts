import {
	queryOptions,
	useMutation,
	type MutationOptions,
	type QueryKey,
} from '@tanstack/vue-query'
import {
	noteOrganizationRead,
	noteOrganizationCreate,
	noteOrganizationControl,
	noteOrganizationApply,
	type AsterNoteOrganization,
	type ModelStep,
	type NoteOrganizationActivity,
} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import type {ClientRequestContext} from '@/client/requestContext'
import {
	noteKeys,
	normalizeNote,
	type Note,
} from './notes'
export type OrganizationJob = Required<Pick<AsterNoteOrganization,
	'id' |
	'note_id' |
	'connection_id' |
	'source' |
	'source_revision' |
	'source_bytes' |
	'processed_bytes' |
	'status' |
	'phase' |
	'completed_steps' |
	'level' |
	'attempt' |
	'model' |
	'input_tokens' |
	'output_tokens' |
	'usage_partial'
>>
	& Pick<AsterNoteOrganization, 'result' | 'error' | 'created' | 'updated'>
export type OrganizationActivity = {
	job?: OrganizationJob
	step?: ModelStep
}
export const organizationKey = (id: number) => ['notes', 'organization', id] as const
export const organizationActive = (job?: Pick<OrganizationJob, 'status'>) =>
	job?.status === 'running' || job?.status === 'queued'
export function normalizeOrganization(raw: NoteOrganizationActivity): OrganizationActivity {
	const job = raw.job
	return {
		step: raw.step,
		job: job ? {
			id: job.id ?? 0,
			note_id: job.note_id ?? 0,
			connection_id: job.connection_id ?? '',
			source: job.source ?? 'transcript',
			source_revision: job.source_revision ?? 0,
			source_bytes: job.source_bytes ?? 0,
			processed_bytes: job.processed_bytes ?? 0,
			status: job.status ?? 'failed',
			phase: job.phase ?? 'map',
			completed_steps: job.completed_steps ?? 0,
			level: job.level ?? 0,
			attempt: job.attempt ?? 0,
			model: job.model ?? '',
			input_tokens: job.input_tokens ?? 0,
			output_tokens: job.output_tokens ?? 0,
			usage_partial: job.usage_partial ?? false,
			result: job.result,
			error: job.error,
			created: job.created,
			updated: job.updated,
		} : undefined,
	}
}
export function noteOrganizationQuery(id: number) {
	return queryOptions({
		queryKey: organizationKey(id),
		queryFn: async ({signal}) => normalizeOrganization((await noteOrganizationRead({
			path: {id},
			signal,
		})).data),
		enabled: id > 0,
		refetchInterval: query => organizationActive(query.state.data?.job) ? 1200 : false,
		refetchOnWindowFocus: true,
		meta: {handlesError: true},
	})
}
type NoteOrganizationMutationContext = {
	request: ClientRequestContext
	previous: [QueryKey, unknown][]
	optimistic: undefined
}
type CreateInput = {
	id: number
	source: 'transcript' | 'article'
	connection_id: string
}
export function createNoteOrganizationMutationOptions(): MutationOptions<
	OrganizationActivity,
	Error,
	CreateInput,
	NoteOrganizationMutationContext
	> {
	return {
		...contextMutationOptions({
			mutationFn: async ({
				id,
				...body
			}: CreateInput) => normalizeOrganization((await noteOrganizationCreate({
				path: {id},
				body,
			})).data),
			toastError: () => false,
			onSuccess: (data, input, client) => client.setQueryData<OrganizationActivity>(
				organizationKey(input.id),
				current => current ? data : current,
			),
			onSettled: async (input, client) => {
				await client.invalidateQueries({
					queryKey: organizationKey(input.id),
					exact: true,
				})
			},
		}),
		networkMode: 'always' as const,
	}
}
export const useCreateNoteOrganization = () => useMutation(createNoteOrganizationMutationOptions())
type ControlInput = {
	id: number
	job_id: number
	action: 'cancel' | 'retry' | 'discard'
}
export function controlNoteOrganizationMutationOptions(): MutationOptions<
	OrganizationActivity,
	Error,
	ControlInput,
	NoteOrganizationMutationContext
	> {
	return {
		...contextMutationOptions({
			mutationFn: async ({
				id,
				job_id,
				action,
			}: ControlInput) => normalizeOrganization((await noteOrganizationControl({
				path: {
					id,
					job_id,
				},
				body: {action},
			})).data),
			toastError: () => false,
			onSuccess: (data, input, client) => client.setQueryData<OrganizationActivity>(
				organizationKey(input.id),
				current => current ? data : current,
			),
			onSettled: async (input, client) => {
				await client.invalidateQueries({
					queryKey: organizationKey(input.id),
					exact: true,
				})
			},
		}),
		networkMode: 'always' as const,
	}
}
export const useControlNoteOrganization = () => useMutation(controlNoteOrganizationMutationOptions())
type ApplyInput = {
	id: number
	job_id: number
	expected_revision: number
	mode: 'append' | 'replace'
}
export function applyNoteOrganizationMutationOptions(): MutationOptions<
	Note,
	Error,
	ApplyInput,
	NoteOrganizationMutationContext
	> {
	return {
		...contextMutationOptions({
			mutationFn: async ({
				id,
				job_id,
				...body
			}: ApplyInput) => normalizeNote((await noteOrganizationApply({
				path: {
					id,
					job_id,
				},
				body,
			})).data),
			toastError: () => false,
			onSuccess: (data, input, client) => client.setQueryData<Note | null>(
				noteKeys.detail(input.id),
				current => current ? data : current,
			),
			onSettled: async (input, client) => {
				await Promise.all([
					client.invalidateQueries({
						queryKey: noteKeys.detail(input.id),
						exact: true,
					}),
					client.invalidateQueries({queryKey: noteKeys.lists}),
				])
			},
		}),
		networkMode: 'always' as const,
	}
}
export const useApplyNoteOrganization = () => useMutation(applyNoteOrganizationMutationOptions())
