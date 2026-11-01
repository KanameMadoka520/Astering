import {queryOptions, useMutation, type QueryClient} from '@tanstack/vue-query'
import {projectUsersList, projectUsersCreate, projectUsersUpdate, projectUsersDelete, projectTeamsList, projectTeamsCreate, projectTeamsUpdate, projectTeamsDelete} from '@/client/generated'
import type {UserWithPermission, TeamWithPermission} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {fetchAllPages} from './fetchAllPages'
import {projectKeys} from './projects'
import {userSearchKeys} from './userSearch'
import {PERMISSIONS, type Permission} from '@/constants/permissions'
import {i18n} from '@/i18n'

export const projectShareKeys = {
	users: (projectId: number) => ['project-shares', projectId, 'users'] as const,
	teams: (projectId: number) => ['project-shares', projectId, 'teams'] as const,
}

export function normalizeSharePermission(permission: unknown): Permission {
	return permission === PERMISSIONS.ADMIN || permission === PERMISSIONS.READ_WRITE ? permission : PERMISSIONS.READ
}

async function invalidateShares(client: QueryClient, projectId: number, kind: 'users' | 'teams') {
	await Promise.all([
		client.invalidateQueries({queryKey: projectShareKeys[kind](projectId)}),
		client.invalidateQueries({queryKey: projectKeys.detail(projectId)}),
		client.invalidateQueries({queryKey: projectKeys.list(), refetchType: 'none'}),
		client.invalidateQueries({queryKey: userSearchKeys.all, refetchType: 'none'}),
	])
}

// After removing your own share the project may be gone for you: refetch your project list now, and leave the share
// list and project detail stale instead of refetching them into a 403.
async function invalidateOwnRemoval(client: QueryClient, projectId: number) {
	await Promise.all([
		client.invalidateQueries({queryKey: projectShareKeys.users(projectId), refetchType: 'none'}),
		client.invalidateQueries({queryKey: projectKeys.detail(projectId), refetchType: 'none'}),
		client.invalidateQueries({queryKey: projectKeys.list()}),
		client.invalidateQueries({queryKey: userSearchKeys.all, refetchType: 'none'}),
	])
}

function addedSuccess(kind: 'users' | 'teams') {
	return i18n.global.t('project.share.userTeam.addedSuccess', {
		type: i18n.global.t(kind === 'users' ? 'project.share.userTeam.typeUser' : 'project.share.userTeam.typeTeam', 1),
	})
}

// Only the direct share is gone; access through a parent project or a team may remain.
function removedSuccess(name: string) {
	return i18n.global.t('project.share.userTeam.removeSuccess', {name})
}

// `name` only labels the outcome message. `self` marks a change to the current user's own share.
type UserShareInput = {projectId: number, username: string, name?: string, self?: boolean}
type TeamShareInput = {projectId: number, teamId: number, name?: string}

export function projectUserSharesQuery(projectId: number) {
	return queryOptions({
		queryKey: projectShareKeys.users(projectId),
		queryFn: ({signal}) => fetchAllPages(async page => (await projectUsersList({path: {project: projectId}, query: {page}, signal})).data),
		// The share page renders its own loading and error states.
		meta: {handlesError: true},
	})
}

export function createProjectUserShareMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({projectId, username}: UserShareInput) => (await projectUsersCreate({path: {project: projectId}, body: {username}})).data,
		onSettled: ({projectId}, client) => invalidateShares(client, projectId, 'users'),
		successMessage: () => addedSuccess('users'),
	})
}
export const useCreateProjectUserShareMutation = () => useMutation(createProjectUserShareMutationOptions())

export function updateProjectUserShareMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({projectId, username, permission}: UserShareInput & {permission: Permission}) => (await projectUsersUpdate({path: {project: projectId, user: username}, body: {username, permission}})).data,
		onSuccess: (updated, {projectId, username}, client) => {
			client.setQueryData<UserWithPermission[]>(projectShareKeys.users(projectId), current => current?.map(item => item.username === username ? {...item, permission: updated.permission} : item))
		},
		onSettled: ({projectId}, client) => invalidateShares(client, projectId, 'users'),
		successMessage: () => i18n.global.t('project.share.userTeam.updatedSuccess'),
	})
}
export const useUpdateProjectUserShareMutation = () => useMutation(updateProjectUserShareMutationOptions())

export function deleteProjectUserShareMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({projectId, username}: UserShareInput) => { await projectUsersDelete({path: {project: projectId, user: username}}) },
		onSuccess: (_data, {projectId, username}, client) => {
			client.setQueryData<UserWithPermission[]>(projectShareKeys.users(projectId), current => current?.filter(item => item.username !== username))
		},
		onSettled: ({projectId, self}, client) => self
			? invalidateOwnRemoval(client, projectId)
			: invalidateShares(client, projectId, 'users'),
		successMessage: (_data, {username, name}) => removedSuccess(name || username),
	})
}
export const useDeleteProjectUserShareMutation = () => useMutation(deleteProjectUserShareMutationOptions())

export function projectTeamSharesQuery(projectId: number) {
	return queryOptions({
		queryKey: projectShareKeys.teams(projectId),
		queryFn: ({signal}) => fetchAllPages(async page => (await projectTeamsList({path: {project: projectId}, query: {page}, signal})).data),
		meta: {handlesError: true},
	})
}

export function createProjectTeamShareMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({projectId, teamId}: TeamShareInput) => (await projectTeamsCreate({path: {project: projectId}, body: {team_id: teamId}})).data,
		onSettled: ({projectId}, client) => invalidateShares(client, projectId, 'teams'),
		successMessage: () => addedSuccess('teams'),
	})
}
export const useCreateProjectTeamShareMutation = () => useMutation(createProjectTeamShareMutationOptions())

export function updateProjectTeamShareMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({projectId, teamId, permission}: TeamShareInput & {permission: Permission}) => (await projectTeamsUpdate({path: {project: projectId, team: teamId}, body: {team_id: teamId, permission}})).data,
		onSuccess: (updated, {projectId, teamId}, client) => {
			client.setQueryData<TeamWithPermission[]>(projectShareKeys.teams(projectId), current => current?.map(item => item.id === teamId ? {...item, permission: updated.permission} : item))
		},
		onSettled: ({projectId}, client) => invalidateShares(client, projectId, 'teams'),
		successMessage: () => i18n.global.t('project.share.userTeam.updatedSuccess'),
	})
}
export const useUpdateProjectTeamShareMutation = () => useMutation(updateProjectTeamShareMutationOptions())

export function deleteProjectTeamShareMutationOptions() {
	return contextMutationOptions({
		mutationFn: async ({projectId, teamId}: TeamShareInput) => { await projectTeamsDelete({path: {project: projectId, team: teamId}}) },
		onSuccess: (_data, {projectId, teamId}, client) => {
			client.setQueryData<TeamWithPermission[]>(projectShareKeys.teams(projectId), current => current?.filter(item => item.id !== teamId))
		},
		onSettled: ({projectId}, client) => invalidateShares(client, projectId, 'teams'),
		successMessage: (_data, {teamId, name}) => removedSuccess(name || `#${teamId}`),
	})
}
export const useDeleteProjectTeamShareMutation = () => useMutation(deleteProjectTeamShareMutationOptions())
