import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import sharp from 'sharp'

const source = resolve(process.cwd(), '..')
const read = (name: string) => readFileSync(resolve(source, name))
const svg = (name: string) => read(name).toString()
const geometry = (text: string) => [...text.matchAll(/\sd="([^"]+)"/g)].map(match => match[1])
const approvedPaths = [
	'M24 209 124 47H195L69 209Z',
	'm132 143 57-43 43 109h-53l-25-66Z',
	'M216 44 222 60 238 66 222 72 216 88 210 72 194 66 210 60Z',
]
const vectors = [
	'frontend/originalMedia/brand/astering-symbol.svg',
	'frontend/originalMedia/brand/astering-avatar.svg',
	...['logo', 'logo-dark', 'logo-mono', 'app-icon', 'favicon', 'wordmark', 'wordmark-dark']
		.map(name => `frontend/public/images/brand/${name}.svg`),
	...['src/assets', 'originalMedia/images'].flatMap(directory =>
		['logo', 'logo-full', 'logo-full-pride'].map(name => `frontend/${directory}/${name}.svg`)),
	'frontend/originalMedia/images/logo-full-white.svg',
	'frontend/public/images/icons/safari-pinned-tab.svg',
	'frontend/originalMedia/icons/safari-pinned-tab.svg',
]

describe('Astering production brand assets', () => {
	it('retains the approved two A planes and single star in every SVG without embedded images', () => {
		for (const file of vectors) {
			const text = svg(file)
			expect(geometry(text), file).toEqual(approvedPaths)
			expect(text, file).not.toMatch(/<(?:image|use|script|foreignObject)\b|data:image/)
		}
	})

	it('uses coordinated blue variants and preserves the single-color notification silhouette', () => {
		const light = svg('frontend/public/images/brand/logo.svg')
		const dark = svg('frontend/public/images/brand/logo-dark.svg')
		const avatar = svg('frontend/originalMedia/brand/astering-avatar.svg')
		const plate = svg('frontend/public/images/brand/app-icon.svg')
		expect(light).toContain('color="#191919"')
		expect(light).toContain('fill="#0284c7"')
		for (const text of [dark, avatar]) {
			expect(text).toContain('color="#38bdf8"')
			expect(text).toContain('fill="#e0f2fe"')
		}
		expect(plate).toContain('fill="#dbeafe"')
		expect(plate).toContain('fill="#0284c7"')
		for (const file of vectors) expect(svg(file), file).not.toMatch(/#fffa00/i)
		for (const name of ['logo-mono.svg', '../icons/safari-pinned-tab.svg']) {
			const text = svg(`frontend/public/images/brand/${name}`)
			expect(text).toContain('color="#000"')
			expect([...text.matchAll(/<path\b[^>]*fill="([^"]+)"/g)]
				.map(match => match[1])).toEqual(['currentColor', 'currentColor', 'currentColor'])
		}
	})

	it('renders the pale-blue icon plate and a visible star even in the 16px favicon', async () => {
		for (const size of [16, 32]) {
			const {data, info} = await sharp(read(`frontend/public/images/icons/favicon-${size}x${size}.png`))
				.ensureAlpha().raw().toBuffer({resolveWithObject: true})
			expect([info.width, info.height]).toEqual([size, size])
			const background = (info.width + 1) * info.channels
			expect([...data.subarray(background, background + 3)]).toEqual([219, 234, 254])
			let starPixels = 0
			for (let y = 0; y < size / 2; y++) {
				for (let x = Math.floor(size * .7); x < size; x++) {
					const at = (y * size + x) * info.channels
					if (data[at + 3] >= 128 && data[at] < 100 && data[at + 2] > data[at] + 80) starPixels++
				}
			}
			expect(starPixels, `${size}px star`).toBeGreaterThan(0)
		}
		expect(read('desktop/icon.png')).toEqual(read('desktop/build/icon.png'))
		expect(read('pkg/notifications/logo.png')).toEqual(read('frontend/public/images/brand/logo.png'))
	})

	it('versions every fixed runtime brand URL with the current palette revision', () => {
		for (const file of [
			'frontend/index.html',
			'frontend/vite.config.ts',
			'frontend/src/composables/useTimeTrackingFavicon.ts',
			'frontend/src/components/misc/NoAuthWrapper.vue',
		]) {
			const text = svg(file)
			expect(text, file).toContain('?v=aster54')
			expect(text, file).not.toContain('?v=aster53')
		}
	})
})
