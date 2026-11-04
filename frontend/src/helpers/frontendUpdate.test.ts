import {describe, expect, it} from 'vitest'
import {needsFrontendRefresh} from './frontendUpdate'

describe('frontend update notification', () => {
	it.each([
		['v2.7.1-tcymc.2', 'v2.7.1-tcymc.2'],
		['v2.7.1-tcymc.2', ' 2.7.1-tcymc.2 '],
		['v2.7.1-tcymc.2', 'v2.7.1-tcymc.1'],
		['v2.7.1-tcymc.10', 'v2.7.1-tcymc.9'],
		['v2.8.0-tcymc.1', 'v2.7.1-tcymc.99'],
		['v2.7.1-tcymc.2', ''],
		['v2.7.1-tcymc.2', '   '],
		['v2.7.1-aster.50', 'v2.7.1-aster.50'],
		['v2.7.1-aster.50', 'v2.7.1-tcymc.49'],
		['v2.7.1-aster.50', 'v2.7.1-tcymc.50'],
		['v2.7.1-aster.50', 'v2.7.1-aster.49'],
	])('does not ask %s to refresh to %s', (current, waiting) => {
		expect(needsFrontendRefresh(current, waiting)).toBe(false)
	})
	it.each([
		['v2.7.1-tcymc.2', 'v2.7.1-tcymc.3'],
		['v2.7.1-tcymc.9', 'v2.7.1-tcymc.10'],
		['v2.7.1-tcymc.99', 'v2.8.0-tcymc.1'],
		['dev', 'v2.7.1-tcymc.3'],
		['v2.7.1-tcymc.49', 'v2.7.1-aster.50'],
		['v2.7.1-aster.50', 'v2.7.1-aster.51'],
		['v2.7.1-aster.99', 'v2.8.0-aster.1'],
	])('offers a confirmed changed build from %s to %s', (current, waiting) => {
		expect(needsFrontendRefresh(current, waiting)).toBe(true)
	})
})
