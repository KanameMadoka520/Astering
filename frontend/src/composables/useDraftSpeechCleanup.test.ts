import {
	afterEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {
	effectScope,
	type EffectScope,
} from 'vue'
import {useDraftSpeechCleanup} from './useDraftSpeechCleanup'

const RAW = 'A raw transcript that is already available to the user.'
const CLEANED = 'A readable version of the transcript.'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (cause: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return {
		promise,
		resolve,
		reject,
	}
}

type CleanupResult = {text?: string}
type Request = {
	text: string,
	signal: AbortSignal,
	response: ReturnType<typeof deferred<CleanupResult>>,
}

const scopes: EffectScope[] = []

function setup() {
	const requests: Request[] = []
	let revision = 0
	let draft = RAW
	let chat = 'first-chat'
	let identity = 'first-account'
	const onFailure = vi.fn()
	const onTiming = vi.fn()
	const apply = vi.fn((text: string) => {
		draft = text
		revision++
	})
	const request = vi.fn((text: string, signal: AbortSignal) => {
		const response = deferred<CleanupResult>()
		requests.push({
			text,
			signal,
			response,
		})
		return response.promise
	})
	const scope = effectScope()
	scopes.push(scope)
	const cleanup = scope.run(() => useDraftSpeechCleanup({
		request,
		revision: () => revision,
		onFailure,
	}))!
	return {
		cleanup,
		scope,
		requests,
		onFailure,
		onTiming,
		apply,
		draft: () => draft,
		edit: (text: string) => {
			draft = text
			revision++
		},
		changeChat: () => { chat = 'next-chat' },
		changeIdentity: () => { identity = 'next-account' },
		run: () => {
			const ownerChat = chat
			const ownerIdentity = identity
			return cleanup.run({
				text: draft,
				current: () => chat === ownerChat && identity === ownerIdentity,
				apply,
				onTiming,
			})
		},
	}
}

afterEach(() => {
	scopes.splice(0).forEach(scope => scope.stop())
	vi.restoreAllMocks()
})

describe('nonblocking speech cleanup', () => {
	it('keeps raw text available while pending and applies an unchanged draft only after completion', async () => {
		const h = setup()
		const work = h.run()
		expect(h.cleanup.pending.value).toBe(true)
		expect(h.draft()).toBe(RAW)
		expect(h.requests[0].text).toBe(RAW)
		expect(h.apply).not.toHaveBeenCalled()
		expect(h.onTiming).not.toHaveBeenCalled()
		h.requests[0].response.resolve({text: CLEANED})
		await work
		expect(h.apply).toHaveBeenCalledExactlyOnceWith(CLEANED)
		expect(h.draft()).toBe(CLEANED)
		expect(h.cleanup.pending.value).toBe(false)
		expect(h.cleanup.proposal.value).toBe('')
		expect(h.onTiming).toHaveBeenCalledExactlyOnceWith(expect.any(Number))
		expect(h.onFailure).not.toHaveBeenCalled()
	})

	it('offers a proposal instead of overwriting an edited draft', async () => {
		const h = setup()
		const work = h.run()
		h.edit('The user has corrected this text.')
		h.requests[0].response.resolve({text: CLEANED})
		await work
		expect(h.draft()).toBe('The user has corrected this text.')
		expect(h.apply).not.toHaveBeenCalled()
		expect(h.cleanup.proposal.value).toBe(CLEANED)
		expect(h.cleanup.pending.value).toBe(false)
		expect(h.onFailure).not.toHaveBeenCalled()
	})

	it('keeps a newer edit even when the user eventually types the same raw text again', async () => {
		const h = setup()
		const work = h.run()
		h.edit('An intermediate edit')
		h.edit(RAW)
		h.requests[0].response.resolve({text: CLEANED})
		await work
		expect(h.draft()).toBe(RAW)
		expect(h.apply).not.toHaveBeenCalled()
		expect(h.cleanup.proposal.value).toBe(CLEANED)
	})

	for (const owner of ['chat', 'identity'] as const) {
		it(`discards a result owned by a previous ${owner} without exposing a proposal`, async () => {
			const h = setup()
			const work = h.run()
			if (owner === 'chat') h.changeChat()
			else h.changeIdentity()
			h.edit('The next owner keeps this draft.')
			h.requests[0].response.resolve({text: CLEANED})
			await work
			expect(h.draft()).toBe('The next owner keeps this draft.')
			expect(h.apply).not.toHaveBeenCalled()
			expect(h.cleanup.proposal.value).toBe('')
			expect(h.cleanup.pending.value).toBe(false)
			expect(h.onFailure).not.toHaveBeenCalled()
			expect(h.onTiming).not.toHaveBeenCalled()
		})
	}

	it('does not report a late request failure to the next account', async () => {
		const h = setup()
		const work = h.run()
		h.changeIdentity()
		h.requests[0].response.reject(new Error('An old account request failed'))
		await work
		expect(h.onFailure).not.toHaveBeenCalled()
		expect(h.onTiming).not.toHaveBeenCalled()
		expect(h.cleanup.pending.value).toBe(false)
		expect(h.cleanup.proposal.value).toBe('')
	})

	for (const result of ['resolve', 'reject'] as const) {
		it(`cancels immediately and ignores a late ${result}`, async () => {
			const h = setup()
			const work = h.run()
			h.cleanup.cancel()
			expect(h.requests[0].signal.aborted).toBe(true)
			expect(h.cleanup.pending.value).toBe(false)
			if (result === 'resolve') h.requests[0].response.resolve({text: CLEANED})
			else h.requests[0].response.reject(new DOMException('Cancelled', 'AbortError'))
			await work
			expect(h.draft()).toBe(RAW)
			expect(h.apply).not.toHaveBeenCalled()
			expect(h.onFailure).not.toHaveBeenCalled()
			expect(h.onTiming).not.toHaveBeenCalled()
			expect(h.cleanup.proposal.value).toBe('')
		})
	}

	for (const result of ['resolve', 'reject'] as const) {
		it(`does not let an old request's ${result} or finally clear a newer pending request`, async () => {
			const h = setup()
			const first = h.run()
			h.edit('A second raw transcript')
			const second = h.run()
			expect(h.requests[0].signal.aborted).toBe(true)
			expect(h.requests[1].signal.aborted).toBe(false)
			if (result === 'resolve') h.requests[0].response.resolve({text: 'An obsolete cleanup'})
			else h.requests[0].response.reject(new Error('An obsolete failure'))
			await first
			expect(h.cleanup.pending.value).toBe(true)
			expect(h.apply).not.toHaveBeenCalled()
			expect(h.cleanup.proposal.value).toBe('')
			expect(h.onFailure).not.toHaveBeenCalled()
			expect(h.onTiming).not.toHaveBeenCalled()
			h.requests[1].response.resolve({text: 'The second transcript is now cleaned.'})
			await second
			expect(h.cleanup.pending.value).toBe(false)
			expect(h.apply).toHaveBeenCalledExactlyOnceWith('The second transcript is now cleaned.')
			expect(h.onTiming).toHaveBeenCalledTimes(1)
		})
	}

	it('releases pending state after a failure, retains raw text and allows a successful retry', async () => {
		const h = setup()
		const first = h.run()
		h.requests[0].response.reject(new Error('The cleanup provider is unavailable'))
		await first
		expect(h.cleanup.pending.value).toBe(false)
		expect(h.onFailure).toHaveBeenCalledTimes(1)
		expect(h.onTiming).toHaveBeenCalledTimes(1)
		expect(h.draft()).toBe(RAW)
		expect(h.apply).not.toHaveBeenCalled()
		const second = h.run()
		h.requests[1].response.resolve({text: CLEANED})
		await second
		expect(h.apply).toHaveBeenCalledExactlyOnceWith(CLEANED)
		expect(h.onFailure).toHaveBeenCalledTimes(1)
		expect(h.cleanup.pending.value).toBe(false)
	})

	it.each([
		undefined,
		'',
		' \n\t ',
	])('treats empty result %j as a failure while keeping the original text', async text => {
		const h = setup()
		const work = h.run()
		h.requests[0].response.resolve({text})
		await work
		expect(h.draft()).toBe(RAW)
		expect(h.apply).not.toHaveBeenCalled()
		expect(h.onFailure).toHaveBeenCalledTimes(1)
		expect(h.onTiming).toHaveBeenCalledTimes(1)
		expect(h.cleanup.pending.value).toBe(false)
		expect(h.cleanup.proposal.value).toBe('')
	})

	it('clears a previous proposal when starting another cleanup or cancelling', async () => {
		const h = setup()
		const first = h.run()
		h.edit('An edited draft')
		h.requests[0].response.resolve({text: CLEANED})
		await first
		expect(h.cleanup.proposal.value).toBe(CLEANED)
		const second = h.run()
		expect(h.cleanup.proposal.value).toBe('')
		h.cleanup.cancel()
		h.requests[1].response.resolve({text: 'Another stale result'})
		await second
		expect(h.cleanup.proposal.value).toBe('')
		expect(h.draft()).toBe('An edited draft')
	})

	it('aborts on scope disposal and ignores the provider reply after the view unmounts', async () => {
		const h = setup()
		const work = h.run()
		h.scope.stop()
		expect(h.requests[0].signal.aborted).toBe(true)
		expect(h.cleanup.pending.value).toBe(false)
		h.requests[0].response.resolve({text: CLEANED})
		await work
		expect(h.apply).not.toHaveBeenCalled()
		expect(h.onFailure).not.toHaveBeenCalled()
		expect(h.onTiming).not.toHaveBeenCalled()
		expect(h.draft()).toBe(RAW)
	})
})
