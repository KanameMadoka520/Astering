import {describe, expect, it} from 'vitest'

import {ApiError} from '@/client/problem'
import {classifyCompassFailure} from './errors'

function problem(status: number, code?: number) {
	return new ApiError({status, code, detail: 'Image 12 is not available in this space.'})
}

describe('classifyCompassFailure', () => {
	it('reads an unusable image as an image problem, even though it answers 409', () => {
		expect(classifyCompassFailure(problem(409, 20104))).toBe('image')
		expect(classifyCompassFailure(problem(400, 20105))).toBe('image')
		expect(classifyCompassFailure(problem(400, 20106))).toBe('image')
	})

	it('still reads a newer revision as a conflict', () => {
		expect(classifyCompassFailure(problem(409, 20101))).toBe('conflict')
		expect(classifyCompassFailure(problem(409))).toBe('conflict')
	})

	it('keeps the other outcomes', () => {
		expect(classifyCompassFailure(problem(404, 20102))).toBe('missing')
		expect(classifyCompassFailure(problem(403))).toBe('forbidden')
		expect(classifyCompassFailure(new TypeError('Failed to fetch'))).toBe('network')
		expect(classifyCompassFailure(new DOMException('changed', 'AbortError'))).toBe('aborted')
	})
})
