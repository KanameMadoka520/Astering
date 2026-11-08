import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {QueryClient, QueryObserver, type QueryKey} from '@tanstack/vue-query'
import {agentReceipt, agentRefreshMutationOptions, planAgentRefresh} from './tcyConversations'
import {parseNoteReceipt} from './noteReceipts'
import {normalizeNote, noteKeys} from './notes'
import {taskKeys} from './tasks'

const {scope} = vi.hoisted(() => ({scope: {epoch: 1}}))
vi.mock('@/client/requestContext', async original => ({
	...await original<typeof import('@/client/requestContext')>(),
	captureClientRequestContext: () => ({epoch: scope.epoch}),
	isClientRequestContextCurrent: (owner: {epoch: number}) => owner.epoch === scope.epoch,
	assertClientRequestContext: (owner: {epoch: number}) => {
		if (owner.epoch !== scope.epoch) throw new DOMException('Identity changed', 'AbortError')
	},
}))
vi.mock('@/client/generated', () => ({tasksRead: vi.fn()}))
vi.mock('@/message', () => ({error: vi.fn(), success: vi.fn()}))

const clients: QueryClient[] = []
const stops: (() => void)[] = []
const original = normalizeNote({id: 3, title: 'Before', content: 'Saved article', revision: 2})
const changed = {...original, title: 'After', content: 'Server article', revision: 3, content_bytes: 14}
const metadata = (note = changed) => { const {content: _content, ...summary} = note; return summary }
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
async function apply(client: QueryClient, tool: string, args: object, result: object, success = true) {
	const receipt = agentReceipt('turn:0', {tool, arguments: JSON.stringify(args), result: JSON.stringify(result), success})
	await client.getMutationCache().build(client, agentRefreshMutationOptions()).execute(planAgentRefresh(receipt ? [receipt] : []))
}
beforeEach(() => {scope.epoch = 1})
afterEach(() => {
	stops.splice(0).forEach(stop => stop())
	clients.splice(0).forEach(client => client.clear())
})

describe('native Notes receipt validation', () => {
	it.each([
		['create_note', {}, {note_id: 3, success: true, note: metadata()}, {id: 3, revision: 3, deleted: false}],
		['update_note', {id: 3, expected_revision: 2}, {note_id: 3, success: true, note: metadata()}, {id: 3, revision: 3, deleted: false}],
		['update_note', {id: 3, expected_revision: 3}, {note_id: 3, success: true, note: metadata()}, {id: 3, revision: 3, deleted: false}],
		['delete_note', {id: 3, expected_revision: 3}, {note_id: 3, success: true, deleted: true, revision: 3}, {id: 3, revision: 3, deleted: true}],
	] as const)('accepts a complete scope-consistent %s receipt', (tool, args, result, expected) => {
		expect(parseNoteReceipt(tool, args, result)).toEqual(expected)
	})
	it.each([
		['update_note', {id: 4, expected_revision: 2}, {note_id: 3, success: true, note: metadata()}],
		['update_note', {id: 3, expected_revision: 4}, {note_id: 3, success: true, note: metadata()}],
		['update_note', {id: 3}, {note_id: 3, success: true, note: metadata()}],
		['create_note', {}, {note_id: 4, success: true, note: metadata()}],
		['create_note', {}, {note_id: 3, success: false, note: metadata()}],
		['create_note', {}, {note_id: 3, success: true, note: {id: 3, revision: 1}}],
		['delete_note', {id: 3, expected_revision: 2}, {note_id: 3, success: true, deleted: true, revision: 3}],
	] as const)('rejects an inconsistent %s receipt without falling through to task refresh', async (tool, args, result) => {
		expect(parseNoteReceipt(tool, args, result)).toBeUndefined()
		const client = clientFixture()
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		await apply(client, tool, args, result)
		expect(invalidate).not.toHaveBeenCalled()
	})
})

describe('Notes receipt query integration', () => {
	it('reads the committed full article and list without blanking content or touching raw transcript/tasks', async () => {
		const client = clientFixture()
		const read = observe(client, noteKeys.detail(3), original, changed)
		const listRead = observe(client, noteKeys.list({}, 1), {items: [metadata(original)]}, {items: [metadata()]})
		const rawRead = observe(client, noteKeys.segmentPage(3, -1), {items: []}, {items: []})
		client.setQueryData([...taskKeys.lists, {project_id: 3}], {items: []})
		await apply(client, 'update_note', {id: 3, expected_revision: 2}, {note_id: 3, success: true, note: metadata()})
		expect(read).toHaveBeenCalledOnce()
		expect(listRead).toHaveBeenCalledOnce()
		expect(rawRead).not.toHaveBeenCalled()
		expect(client.getQueryData(noteKeys.detail(3))).toEqual(changed)
		expect(client.getQueryState([...taskKeys.lists, {project_id: 3}])?.isInvalidated).toBe(false)
	})
	it('uses the shared deletion tombstone and drops only the deleted transcript', async () => {
		const client = clientFixture()
		client.setQueryData(noteKeys.detail(3), changed)
		client.setQueryData(noteKeys.list({}, 1), {items: [metadata()], page: 1, total: 1, total_pages: 1, per_page: 20})
		client.setQueryData(noteKeys.segmentPage(3, -1), {items: [{id: 1}]})
		client.setQueryData(noteKeys.segmentPage(4, -1), {items: [{id: 9}]})
		await apply(client, 'delete_note', {id: 3, expected_revision: 3}, {note_id: 3, success: true, deleted: true, revision: 3})
		expect(client.getQueryData(noteKeys.detail(3))).toBeNull()
		expect(client.getQueryData(noteKeys.segmentPage(3, -1))).toBeUndefined()
		expect(client.getQueryData(noteKeys.segmentPage(4, -1))).toEqual({items: [{id: 9}]})
	})
	it('ignores an older receipt and external or failed lookalikes', async () => {
		const client = clientFixture()
		client.setQueryData(noteKeys.detail(3), {...changed, revision: 5})
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		await apply(client, 'update_note', {id: 3, expected_revision: 2}, {note_id: 3, success: true, note: metadata()})
		await apply(client, 'call_mcp_tool', {id: 3, tool: 'update_note'}, {note_id: 3, success: true, note: metadata()})
		await apply(client, 'update_note', {id: 3, expected_revision: 2}, {note_id: 3, success: true, note: metadata()}, false)
		await apply(client, 'future_note_operation', {id: 3}, {success: true})
		expect(invalidate).not.toHaveBeenCalled()
	})
	it('cancels an initial stale read before receiving the server revision', async () => {
		const client = clientFixture()
		let finish!: (value: object) => void
		const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => {finish = resolve})).mockResolvedValue(changed)
		const observer = new QueryObserver(client, {queryKey: noteKeys.detail(3), queryFn: read})
		stops.push(observer.subscribe(() => {}))
		await apply(client, 'update_note', {id: 3, expected_revision: 2}, {note_id: 3, success: true, note: metadata()})
		expect(read).toHaveBeenCalledTimes(2)
		finish(original)
		await Promise.resolve()
		expect(client.getQueryData(noteKeys.detail(3))).toEqual(changed)
	})
	it('cannot tombstone or invalidate another identity after cancellation yields', async () => {
		const client = clientFixture()
		client.setQueryData(noteKeys.detail(3), changed)
		const invalidate = vi.spyOn(client, 'invalidateQueries')
		const cancels: (() => void)[] = []
		vi.spyOn(client, 'cancelQueries').mockImplementation(() => new Promise(resolve => {cancels.push(resolve)}))
		const pending = apply(client, 'delete_note', {id: 3, expected_revision: 3}, {note_id: 3, success: true, deleted: true, revision: 3})
		await vi.waitFor(() => expect(cancels).toHaveLength(3))
		scope.epoch++
		cancels.forEach(resolve => resolve())
		await expect(pending).rejects.toMatchObject({name: 'AbortError'})
		expect(invalidate).not.toHaveBeenCalled()
		expect(client.getQueryData(noteKeys.detail(3))).toEqual(changed)
	})
})
