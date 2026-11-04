// Rebuild the Astering star assets offline from the approved PNG masters.
import sharp from 'sharp'
import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises'
import {fileURLToPath, URL} from 'node:url'
import {Buffer} from 'node:buffer'
import console from 'node:console'
import path from 'node:path'
import {keepLargestAlphaComponent} from './brand-alpha.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const brand = path.join(root, 'originalMedia/brand')
const avatar = path.join(brand, 'astering-avatar.png')
const output = path.join(root, 'public/images/brand')
const icons = path.join(root, 'public/images/icons')
const plate = '#fff5d9'
await mkdir(output, {recursive: true})
await mkdir(icons, {recursive: true})
const master = await sharp(await readFile(path.join(brand, 'astering-star.png')))
	.ensureAlpha()
	.raw()
	.toBuffer({resolveWithObject: true})
const normalized = keepLargestAlphaComponent(master.data, master.info.width, master.info.height)
const mark = await sharp(normalized.data, {raw: master.info}).png().toBuffer()
const mono = await readFile(path.join(brand, 'astering-star-mono.svg'), 'utf8')
const render = (input, size) => sharp(Buffer.isBuffer(input) ? input : Buffer.from(input))
	.resize(size, size, {fit: 'contain', background: {r: 0, g: 0, b: 0, alpha: 0}})
const png = size => render(mark, size).png({palette: true, colours: 128, dither: 0}).toBuffer()
await render(mark, 512).png({palette: true, colours: 256, dither: 0}).toFile(path.join(output, 'logo.png'))
await render(mark, 256).webp({quality: 90, alphaQuality: 100}).toFile(path.join(output, 'logo.webp'))
await sharp(avatar).resize(512).png({palette: true, colours: 256, dither: 0}).toFile(path.join(output, 'avatar.png'))
await sharp(avatar).resize(960).webp({quality: 86}).toFile(path.join(output, 'avatar.webp'))
// The offline screen uses the same new portrait, bundled so its old mascot cannot reappear.
await sharp(avatar).resize(1280).webp({quality: 80}).toFile(path.join(root, 'src/assets/astering-nightscape.webp'))
// SVG wordmarks embed only a compact icon, never the 1280px master or avatar.
const compact = await png(160)
const image = `<image x="0" y="0" width="64" height="64" href="data:image/png;base64,${compact.toString('base64')}"/>`
const full = (color = 'currentColor', pride = false) => `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 300 64" width="300" height="64"><title>Astering</title>${image}<text x="74" y="46" fill="${color}" font-family="Quicksand,system-ui,sans-serif" font-size="39" font-weight="700" letter-spacing="-1.5">Astering</text>${pride ? '<defs><linearGradient id="astering-pride"><stop stop-color="#e40303"/><stop offset=".2" stop-color="#ff8c00"/><stop offset=".4" stop-color="#ffed00"/><stop offset=".6" stop-color="#008026"/><stop offset=".8" stop-color="#24408e"/><stop offset="1" stop-color="#732982"/></linearGradient></defs><rect x="76" y="55" width="184" height="3" rx="1.5" fill="url(#astering-pride)"/>' : ''}</svg>\n`
const standalone = `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 64 64" width="64" height="64"><title>Astering</title>${image}</svg>\n`
for (const dir of ['src/assets', 'originalMedia/images']) {
	await writeFile(path.join(root, dir, 'logo-full.svg'), full())
	await writeFile(path.join(root, dir, 'logo-full-pride.svg'), full('currentColor', true))
	await writeFile(path.join(root, dir, 'logo.svg'), standalone)
}
await writeFile(path.join(root, 'originalMedia/images/logo-full-white.svg'), full('#fff'))
await writeFile(path.join(output, 'logo.svg'), standalone)
await writeFile(path.join(output, 'wordmark.svg'), full('#17243b'))
await writeFile(path.join(output, 'wordmark-dark.svg'), full('#eef5ff'))
await writeFile(path.join(output, 'favicon.svg'), standalone)
await writeFile(path.join(output, 'logo-mono.svg'), mono)
const iconSizes = {
	'favicon-16x16.png': 16,
	'favicon-32x32.png': 32,
	'android-chrome-192x192.png': 192,
	'android-chrome-512x512.png': 512,
	'apple-touch-icon-60x60.png': 60,
	'apple-touch-icon-76x76.png': 76,
	'apple-touch-icon-120x120.png': 120,
	'apple-touch-icon-152x152.png': 152,
	'apple-touch-icon-180x180.png': 180,
	'apple-touch-icon.png': 180,
	'msapplication-icon-144x144.png': 144,
	'mstile-150x150.png': 150,
}
for (const [name, size] of Object.entries(iconSizes)) {
	// Home-screen tiles have an opaque starlight plate; tiny favicons stay transparent.
	const result = name.startsWith('favicon')
		? render(mark, size)
		: sharp({create: {width: size, height: size, channels: 4, background: plate}})
			.composite([{input: await render(mark, Math.round(size * 0.84)).png().toBuffer(), gravity: 'center'}])
	await result.png({palette: true, colours: 256, dither: 0}).toFile(path.join(icons, name))
}
// Keep the whole star inside the maskable icon's central safe circle.
await sharp({create: {width: 1024, height: 1024, channels: 4, background: plate}})
	.composite([{input: await render(mark, 680).png().toBuffer(), gravity: 'center'}])
	.png({palette: true, colours: 256, dither: 0})
	.toFile(path.join(icons, 'icon-maskable.png'))
await sharp(await png(32))
	.composite([{input: Buffer.from('<svg width="32" height="32"><circle cx="7" cy="25" r="6" fill="#ef4444" stroke="white" stroke-width="2"/></svg>')}])
	.png()
	.toFile(path.join(icons, 'favicon-tracking-32x32.png'))
await writeFile(path.join(icons, 'safari-pinned-tab.svg'), mono)
await render(mono.replace('<svg ', '<svg fill="white" '), 96).png().toFile(path.join(icons, 'badge-monochrome.png'))
// ICO PNG entries cover tab, legacy browser and OS sizes without shipping a large master.
const sizes = [16, 32, 48]
const payloads = await Promise.all(sizes.map(png))
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
payloads.forEach((data, i) => {
	const at = 6 + i * 16
	header[at] = sizes[i]
	header[at + 1] = sizes[i]
	header.writeUInt16LE(1, at + 4)
	header.writeUInt16LE(32, at + 6)
	header.writeUInt32LE(data.length, at + 8)
	header.writeUInt32LE(offset, at + 12)
	offset += data.length
})
await writeFile(path.join(root, 'public/favicon.ico'), Buffer.concat([header, ...payloads]))
for (const name of [...Object.keys(iconSizes), 'icon-maskable.png', 'favicon-tracking-32x32.png', 'safari-pinned-tab.svg', 'badge-monochrome.png']) {
	await copyFile(path.join(icons, name), path.join(root, 'originalMedia/icons', name))
}
console.log(`Astering star assets generated; removed ${normalized.removedPixels} disconnected alpha pixels from exports only.`)
