import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, QueryObserver, type QueryKey} from '@tanstack/vue-query'

import {agentReceipt, agentRefreshMutationOptions, planAgentRefresh} from './tcyConversations'
import {compassKeys} from './compass'
import {taskKeys} from './tasks'
import {parseCompassReceipt} from './compassReceipts'

const {scope} = vi.hoisted(() => ({scope: {epoch: 1}}))
vi.mock('@/client/requestContext', async importOriginal => ({
	...await importOriginal<typeof import('@/client/requestContext')>(),
	captureClientRequestContext: () => ({epoch: scope.epoch}),
	isClientRequestContextCurrent: (request: {epoch: number}) => request.epoch === scope.epoch,
	assertClientRequestContext: (request: {epoch: number}) => {
		if (request.epoch !== scope.epoch) throw new DOMException('Identity changed', 'AbortError')
	},
}))

vi.mock('@/client/generated', () => ({tasksRead: vi.fn()}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))

const clients: QueryClient[] = []
const stops: (() => void)[] = []

beforeEach(() => {scope.epoch = 1})

afterEach(() => {
	stops.splice(0).forEach(stop => stop())
	clients.splice(0).forEach(client => client.clear())
})

function clientFixture() {
	const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}})
	clients.push(client)
	return client
}

function observe(client: QueryClient, key: QueryKey, initial: unknown, updated: unknown) {
	const read = vi.fn().mockResolvedValue(updated)
	client.setQueryData(key, initial)
	const observer = new QueryObserver(client, {queryKey: key, queryFn: read, staleTime: Infinity})
	stops.push(observer.subscribe(() => {}))
	return read
}

async function apply(client: QueryClient, tool: string, args: object, result: unknown, success = true) {
	const receipt = agentReceipt('turn:0', {
		tool,
		arguments: JSON.stringify(args),
		result: JSON.stringify(result),
		success,
	})!
	await client.getMutationCache().build(client, agentRefreshMutationOptions()).execute(planAgentRefresh(receipt ? [receipt] : []))
}

describe('Compass tool receipt refresh', () => {
	it('refetches the actual Compass entry and leaves unrelated task caches intact', async () => {
		const client = clientFixture()
		const entry = {id: 41, space_id: 7, revision: 1, title: 'Original'}
		const changed = {...entry, revision: 2, title: 'Changed'}
		const read = observe(client, compassKeys.entry(41), entry, changed)
		const taskList = [...taskKeys.lists, {project_id: 1}]
		client.setQueryData(taskList, {items: []})
		await apply(client, 'update_compass_entry', {id: 41, revision: 1, title: 'Changed'}, changed)
		expect(read).toHaveBeenCalledOnce()
		expect(client.getQueryData(compassKeys.entry(41))).toEqual(changed)
		expect(client.getQueryState(taskList)?.isInvalidated).toBe(false)
	})
})


describe('Compass receipt scope and query lifecycle', () => {
	it.each([
		['create_compass_space', {team_id: 2}, {id: 7, team_id: 2, revision: 1}, {space: 7}],
		['update_compass_space', {id: 7, revision: 2}, {id: 7, revision: 3}, {space: 7}],
		['create_compass_entry', {space_id: 7}, {id: 41, space_id: 7, revision: 1}, {space: 7, entry: 41}],
		['restore_compass_revision', {id: 41, revision: 1, expected_revision: 4}, {id: 41, space_id: 7, revision: 5}, {space: 7, entry: 41}],
	] as const)('recognizes the exact %s server entity', (tool, args, result, change) => {
		expect(parseCompassReceipt(tool, args, result)).toEqual(change)
	})

	it.each([
		['create_compass_space', {team_id: 2}, {id: 7, team_id: 3, revision: 1}],
		['update_compass_space', {id: 7, revision: 2}, {id: 8, revision: 3}],
		['create_compass_entry', {space_id: 7}, {id: 41, space_id: 8, revision: 1}],
		['update_compass_entry', {id: 41, revision: 2}, {id: 42, space_id: 7, revision: 3}],
		['update_compass_entry', {id: 41, revision: 2}, {id: 41, space_id: 7, revision: 2}],
		['restore_compass_revision', {id: 41, revision: 1, expected_revision: 4}, {id: 41, space_id: 7, revision: 3}],
		['update_compass_entry', {id: 41, revision: 1}, {id: 41, revision: 2}],
	] as const)('rejects inconsistent %s receipts without refreshing any task', async (tool, args, result) => {
		const client = clientFixture()
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		await apply(client, tool, args, result)
		expect(invalidate).not.toHaveBeenCalled()
	})

	it.each([
		['get_compass_entry', true],
		['update_compass_entry', false],
		['future_compass_write', true],
	] as const)('does not treat %s as an unknown task write', async (tool, success) => {
		const client = clientFixture()
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		await apply(client, tool, {id: 41, revision: 1}, {id: 41, space_id: 7, revision: 2}, success)
		expect(invalidate).not.toHaveBeenCalled()
	})

	it('refreshes only affected space catalogues, never immutable historical snapshots', async () => {
		const client = clientFixture()
		const keys = [
			compassKeys.spaces,
			compassKeys.space(7),
			compassKeys.entryLists(7),
			compassKeys.topics(7),
			compassKeys.entry(41),
			compassKeys.revisionList(41, 1),
		]
		const reads = keys.map(key => observe(client, key, [], []))
		const unrelated = [compassKeys.space(8), compassKeys.entryLists(8), compassKeys.entry(42), compassKeys.revision(41, 1)]
		const unrelatedReads = unrelated.map(key => observe(client, key, [], []))
		await apply(client, 'update_compass_entry', {id: 41, revision: 1}, {id: 41, space_id: 7, revision: 2})
		reads.forEach(read => expect(read).toHaveBeenCalledOnce())
		unrelatedReads.forEach(read => expect(read).not.toHaveBeenCalled())
	})

	it('does not move a cached entry into a different space from an inconsistent receipt', async () => {
		const client = clientFixture()
		client.setQueryData(compassKeys.entry(41), {id: 41, space_id: 8, revision: 1})
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		await apply(client, 'update_compass_entry', {id: 41, revision: 1}, {id: 41, space_id: 7, revision: 2})
		expect(invalidate).not.toHaveBeenCalled()
	})

	it('deduplicates repeated write receipts before refetching active catalogues', async () => {
		const client = clientFixture()
		const spaces = observe(client, compassKeys.spaces, [], [])
		const list = observe(client, compassKeys.entryLists(7), [], [])
		const receipts = [41, 42, 41].map((id, index) => agentReceipt(String(index), {
			tool: 'update_compass_entry',
			arguments: JSON.stringify({id, revision: 1}),
			result: JSON.stringify({id, space_id: 7, revision: 2}),
			success: true,
		})!)
		await client.getMutationCache().build(client, agentRefreshMutationOptions()).execute(planAgentRefresh(receipts))
		expect(spaces).toHaveBeenCalledOnce()
		expect(list).toHaveBeenCalledOnce()
	})

	it('cancels an initial stale GET before fetching the confirmed server write', async () => {
		const client = clientFixture()
		let finishOld!: (entry: object) => void
		const changed = {id: 41, space_id: 7, revision: 2, title: 'Committed'}
		const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => {finishOld = resolve}))
			.mockResolvedValue(changed)
		const observer = new QueryObserver(client, {queryKey: compassKeys.entry(41), queryFn: read})
		stops.push(observer.subscribe(() => {}))
		await apply(client, 'update_compass_entry', {id: 41, revision: 1}, changed)
		expect(read).toHaveBeenCalledTimes(2)
		finishOld({id: 41, space_id: 7, revision: 1, title: 'Old read'})
		await Promise.resolve()
		expect(client.getQueryData(compassKeys.entry(41))).toEqual(changed)
	})

	it('does not invalidate a new identity after cancellation yields to an account switch', async () => {
		const client = clientFixture()
		vi.spyOn(client, 'cancelQueries')
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		// One space write has two keys; resolve all cancellation promises together.
		const cancels: (() => void)[] = []
		vi.mocked(client.cancelQueries).mockImplementation(() => new Promise(resolve => {cancels.push(resolve)}))
		const pending = apply(client, 'update_compass_space', {id: 7, revision: 1}, {id: 7, revision: 2})
		await vi.waitFor(() => expect(cancels).toHaveLength(2))
		scope.epoch++
		cancels.forEach(resolve => resolve())
		await expect(pending).rejects.toMatchObject({name: 'AbortError'})
		expect(invalidate).not.toHaveBeenCalled()
	})
})
