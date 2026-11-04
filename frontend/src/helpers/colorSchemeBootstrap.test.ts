import {afterEach, describe, expect, it, vi} from 'vitest'
import html from '../../index.html?raw'

const bootstrap = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
	.find(([, source]) => source.includes('vikunja-color-scheme'))?.[1]

function boot() {
	if (!bootstrap) throw new Error('The first-paint color scheme script is missing')
	new Function(bootstrap)()
}

afterEach(() => {
	vi.restoreAllMocks()
	localStorage.removeItem('vikunja-color-scheme')
	document.documentElement.classList.remove('dark', 'light', 'theme-starlight')
})

describe('color scheme first paint', () => {
	it.each(['light', 'dark', 'starlight'])('paints the cached %s appearance before the app loads', scheme => {
		localStorage.setItem('vikunja-color-scheme', scheme)
		boot()
		expect(document.documentElement.classList.contains(scheme === 'starlight' ? 'dark' : scheme)).toBe(true)
		expect(document.documentElement.classList.contains('theme-starlight')).toBe(scheme === 'starlight')
	})

	it('ignores unknown cache values', () => {
		localStorage.setItem('vikunja-color-scheme', 'auto')
		boot()
		expect(document.documentElement.classList.contains('dark')).toBe(false)
		expect(document.documentElement.classList.contains('theme-starlight')).toBe(false)
	})

	it('can start when browser storage is unavailable', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable') })
		expect(boot).not.toThrow()
	})
})
