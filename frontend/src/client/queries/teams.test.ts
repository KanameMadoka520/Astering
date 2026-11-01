import {QueryClient, QueryObserver} from '@tanstack/vue-query'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {
	Team,
	TeamReadBody,
} from '@/client/generated'
import {success} from '@/message'

const sdk = vi.hoisted(() => ({teamsList: vi.fn(), teamsRead: vi.fn(), teamsCreate: vi.fn(), teamsUpdate: vi.fn(), teamsDelete: vi.fn(), teamsMembersAdd: vi.fn(), teamsMembersRemove: vi.fn(), teamsMembersToggleAdmin: vi.fn()}))
const session = vi.hoisted(() => ({epoch: 1}))
vi.mock('@/client/generated', () => sdk)
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))
vi.mock('@/helpers/auth', () => ({getAuthSessionEpoch: () => session.epoch, getToken: () => null, getTokenIdentity: () => null}))
vi.mock('@/helpers/apiUrl', () => ({getApiBaseUrl: () => '/api/v2/'}))

import {PICKER_PAGE_SIZE} from './pagination'
import {teamKeys, teamsPageQuery, teamSearchQuery, teamQuery, memberTeamIdsQuery, createTeamMutationOptions, updateTeamMutationOptions, deleteTeamMutationOptions, addTeamMemberMutationOptions, removeTeamMemberMutationOptions, leaveTeamMutationOptions, toggleTeamMemberAdminMutationOptions} from './teams'
import {compassKeys} from './compass'
import {projectKeys} from './projects'
import {userSearchKeys} from './userSearch'

function teamPage(items: Team[], page = 1, total = items.length) {
	return {
		items,
		page,
		per_page: 25,
		total,
		total_pages: Math.ceil(total / 25),
	}
}

let client: QueryClient
beforeEach(() => {
	vi.resetAllMocks()
	session.epoch = 1
	client = new QueryClient({defaultOptions: {queries: {retry: false}}})
})

describe('teams', () => {
	it('requests one page of the team list', async () => {
		sdk.teamsList.mockResolvedValue({data: {
			items: [{id: 26}],
			page: 2,
			per_page: 25,
			total: 26,
			total_pages: 2,
		}})
		expect(await client.fetchQuery(teamsPageQuery(2))).toEqual({
			items: [{id: 26}],
			page: 2,
			per_page: 25,
			total: 26,
			total_pages: 2,
		})
		expect(sdk.teamsList).toHaveBeenCalledTimes(1)
		expect(sdk.teamsList).toHaveBeenCalledWith({
			query: {page: 2},
			signal: expect.any(AbortSignal),
		})
	})

	it('searches only the first page of teams', async () => {
		sdk.teamsList.mockResolvedValue({data: {
			items: [{id: 1}],
			total_pages: 3,
		}})
		expect(await client.fetchQuery(teamSearchQuery('ops', true))).toEqual([{id: 1}])
		expect(sdk.teamsList).toHaveBeenCalledTimes(1)
		expect(sdk.teamsList).toHaveBeenCalledWith({
			query: {
				q: 'ops',
				include_public: true,
				page: 1,
				per_page: PICKER_PAGE_SIZE,
			},
			signal: expect.any(AbortSignal),
		})
	})

	it('invalidates every cached page after creating a team', async () => {
		client.setQueryData(teamKeys.list(1), teamPage([{id: 1}], 1, 26))
		client.setQueryData(teamKeys.list(2), teamPage([{id: 26}], 2, 26))
		sdk.teamsCreate.mockResolvedValue({data: {id: 27}})
		await client.getMutationCache().build(client, createTeamMutationOptions()).execute({name: 'new'})
		expect(client.getQueryState(teamKeys.list(1))?.isInvalidated).toBe(true)
		expect(client.getQueryState(teamKeys.list(2))?.isInvalidated).toBe(true)
	})

	it('updates mounted team caches without dropping read permissions', async () => {
		client.setQueryData(teamKeys.list(1), teamPage([{id: 1, name: 'old'}]))
		client.setQueryData(teamKeys.search('ol'), [{id: 1, name: 'old'}])
		client.setQueryData(teamKeys.detail(1), {id: 1, name: 'old', max_permission: 2, members: []})
		sdk.teamsUpdate.mockResolvedValue({data: {id: 1, name: 'new'}})
		await client.getMutationCache().build(client, updateTeamMutationOptions()).execute({id: 1, team: {name: 'new'}})
		expect(client.getQueryData(teamKeys.list(1))).toEqual(teamPage([{id: 1, name: 'new'}]))
		expect(client.getQueryData(teamKeys.search('ol'))).toEqual([{id: 1, name: 'new'}])
		expect(client.getQueryData(teamKeys.detail(1))).toMatchObject({name: 'new', max_permission: 2})
		expect(client.getQueryState(teamKeys.list(1))?.isInvalidated).toBe(true)
		expect(client.getQueryState(teamKeys.search('ol'))?.isInvalidated).toBe(true)
	})

	it('removes a deleted team from every cached page and drops its detail', async () => {
		client.setQueryData(teamKeys.list(1), teamPage([{id: 1}, {id: 2}], 1, 26))
		client.setQueryData(teamKeys.list(2), teamPage([{id: 26}], 2, 26))
		client.setQueryData(teamKeys.search('t'), [{id: 1}, {id: 2}])
		client.setQueryData(teamKeys.detail(1), {id: 1})
		sdk.teamsDelete.mockResolvedValue({})
		await client.getMutationCache().build(client, deleteTeamMutationOptions()).execute(1)
		expect(client.getQueryData(teamKeys.list(1))).toEqual(teamPage([{id: 2}], 1, 25))
		expect(client.getQueryData(teamKeys.list(2))).toEqual(teamPage([{id: 26}], 2, 25))
		expect(client.getQueryData(teamKeys.search('t'))).toEqual([{id: 2}])
		expect(client.getQueryData(teamKeys.detail(1))).toBeUndefined()
		expect(client.getQueryState(teamKeys.list(1))?.isInvalidated).toBe(true)
		expect(client.getQueryState(teamKeys.list(2))?.isInvalidated).toBe(true)
	})

	it('reconciles member relations by username, not the relation id', async () => {
		client.setQueryData(teamKeys.detail(1), {id: 1, members: [{id: 7, username: 'sam', admin: false}]})
		sdk.teamsMembersToggleAdmin.mockResolvedValue({data: {id: 99, username: 'sam', admin: true}})
		await client.getMutationCache().build(client, toggleTeamMemberAdminMutationOptions()).execute({teamId: 1, username: 'sam'})
		expect(client.getQueryData<TeamReadBody>(teamKeys.detail(1))?.members).toEqual([{id: 7, username: 'sam', admin: true}])
		sdk.teamsMembersRemove.mockResolvedValue({})
		await client.getMutationCache().build(client, removeTeamMemberMutationOptions()).execute({teamId: 1, username: 'sam'})
		expect(client.getQueryData<TeamReadBody>(teamKeys.detail(1))?.members).toEqual([])
	})

	it('drops the left team detail instead of refetching it', async () => {
		client.setQueryData(teamKeys.list(1), teamPage([{id: 1}]))
		client.setQueryData(teamKeys.detail(1), {id: 1, members: [{username: 'sam'}]})
		sdk.teamsMembersRemove.mockResolvedValue({})
		await client.getMutationCache().build(client, leaveTeamMutationOptions()).execute({teamId: 1, username: 'sam'})
		expect(sdk.teamsMembersRemove).toHaveBeenCalledWith({path: {team: 1, user: 'sam'}})
		expect(client.getQueryState(teamKeys.detail(1))).toBeUndefined()
		expect(client.getQueryState(teamKeys.list(1))?.isInvalidated).toBe(true)
		expect(sdk.teamsRead).not.toHaveBeenCalled()
	})

	it('invalidates the parent after adding a member without inventing a user', async () => {
		client.setQueryData(teamKeys.detail(1), {id: 1, members: []})
		sdk.teamsMembersAdd.mockResolvedValue({data: {id: 99, username: 'sam'}})
		await client.getMutationCache().build(client, addTeamMemberMutationOptions()).execute({teamId: 1, username: 'sam'})
		expect(client.getQueryData<TeamReadBody>(teamKeys.detail(1))?.members).toEqual([])
		expect(client.getQueryState(teamKeys.detail(1))?.isInvalidated).toBe(true)
	})

	it('keeps failed membership changes out of the cache', async () => {
		client.setQueryData(teamKeys.detail(1), {id: 1, members: [{username: 'sam', admin: false}]})
		sdk.teamsMembersToggleAdmin.mockRejectedValue(new Error('denied'))
		await expect(client.getMutationCache().build(client, toggleTeamMemberAdminMutationOptions()).execute({teamId: 1, username: 'sam'})).rejects.toThrow('denied')
		expect(client.getQueryData<TeamReadBody>(teamKeys.detail(1))?.members?.[0].admin).toBe(false)
		expect(success).not.toHaveBeenCalled()
	})

	it('fences cache writes and notifications after an identity change', async () => {
		client.setQueryData(teamKeys.detail(1), {id: 1, name: 'other identity'})
		sdk.teamsUpdate.mockImplementation(async () => { session.epoch++; return {data: {id: 1, name: 'old identity'}} })
		await expect(client.getMutationCache().build(client, updateTeamMutationOptions()).execute({id: 1, team: {name: 'old identity'}})).rejects.toThrow('Client request context changed')
		expect(client.getQueryData(teamKeys.detail(1))).toEqual({id: 1, name: 'other identity'})
		expect(success).not.toHaveBeenCalled()
	})
})

describe('teams: access of the current user after leaving or deleting a team', () => {
	// The sidebar keeps one mounted observer on the project list; nothing else would refetch it.
	function watchProjectList() {
		const queryFn = vi.fn(async () => ({projects: [], favoriteProject: null, savedFilterProjects: []}))
		client.setQueryData(projectKeys.list(), {projects: [{id: 5}], favoriteProject: null, savedFilterProjects: []})
		const observer = new QueryObserver(client, {queryKey: projectKeys.list(), queryFn, staleTime: Infinity})
		const unsubscribe = observer.subscribe(() => {})
		return {queryFn, unsubscribe}
	}

	it.each([
		['leaving', () => leaveTeamMutationOptions(), {teamId: 1, username: 'me'}],
		['deleting', () => deleteTeamMutationOptions(), 1],
	] as const)('refetches the project list and Compass spaces after %s', async (_name, options, input) => {
		sdk.teamsMembersRemove.mockResolvedValue({})
		sdk.teamsDelete.mockResolvedValue({})
		client.setQueryData(compassKeys.spaces, [{id: 11, team_id: 1}])
		client.setQueryData(compassKeys.space(11), {id: 11, team_id: 1})
		const list = watchProjectList()

		await client.getMutationCache().build(client, options() as never).execute(input as never)

		expect(list.queryFn).toHaveBeenCalledTimes(1)
		expect(client.getQueryState(compassKeys.spaces)?.isInvalidated).toBe(true)
		// Only the list: single space pages are left alone.
		expect(client.getQueryState(compassKeys.space(11))?.isInvalidated).toBe(false)
		list.unsubscribe()
	})

	it('marks user search stale after deleting a team', async () => {
		sdk.teamsDelete.mockResolvedValue({})
		client.setQueryData(userSearchKeys.global('sam'), [])
		await client.getMutationCache().build(client, deleteTeamMutationOptions()).execute(1)
		expect(client.getQueryState(userSearchKeys.global('sam'))?.isInvalidated).toBe(true)
	})

	it('leaves the project list alone when another member changes', async () => {
		sdk.teamsMembersRemove.mockResolvedValue({})
		const list = watchProjectList()
		await client.getMutationCache().build(client, removeTeamMemberMutationOptions()).execute({teamId: 1, username: 'sam'})
		expect(list.queryFn).not.toHaveBeenCalled()
		list.unsubscribe()
	})
})

describe('teams: views that show their own errors', () => {
	it('skips the global toast for the team pages and the team detail', () => {
		expect(teamsPageQuery(1).meta?.handlesError).toBe(true)
		expect(teamQuery(1).meta?.handlesError).toBe(true)
	})

	it('lists the ids of every team the user is in, across pages', async () => {
		sdk.teamsList
			.mockResolvedValueOnce({data: teamPage([{id: 1}, {id: 2}], 1, 26)})
			.mockResolvedValueOnce({data: teamPage([{id: 26}], 2, 26)})
		expect(await client.fetchQuery(memberTeamIdsQuery())).toEqual([1, 2, 26])
		expect(sdk.teamsList.mock.calls[0][0].query.include_public).toBeUndefined()

		sdk.teamsCreate.mockResolvedValue({data: {id: 3}})
		await client.getMutationCache().build(client, createTeamMutationOptions()).execute({name: 'New'})
		expect(client.getQueryState(memberTeamIdsQuery().queryKey)?.isInvalidated).toBe(true)
	})
})
