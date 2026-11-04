export const coverPresets = [
	{id: 'aurora', colors: ['#0f766e', '#67e8f9'], pattern: 'waves'},
	{id: 'sunset', colors: ['#be185d', '#fdba74'], pattern: 'waves'},
	{id: 'night', colors: ['#312e81', '#a78bfa'], pattern: 'dots'},
	{id: 'forest', colors: ['#14532d', '#a3e635'], pattern: 'circles'},
	{id: 'ocean', colors: ['#075985', '#38bdf8'], pattern: 'grid'},
	{id: 'sand', colors: ['#92400e', '#fde68a'], pattern: 'circles'},
] as const
export type CoverPreset = typeof coverPresets[number]
// Small, deterministic original artwork; stored once as a regular reusable drive image.
export async function createCoverPreset(preset: CoverPreset): Promise<File> {
	const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 600
	const ctx = canvas.getContext('2d')!
	const gradient = ctx.createLinearGradient(0, 0, 1200, 600)
	gradient.addColorStop(0, preset.colors[0]); gradient.addColorStop(1, preset.colors[1])
	ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1200, 600)
	ctx.fillStyle = '#ffffff22'; ctx.strokeStyle = '#ffffff22'; ctx.lineWidth = 2
	if (preset.pattern === 'waves') {
		for (let y = 0; y < 4; y++) {ctx.beginPath(); ctx.moveTo(0, 200 + y * 100); ctx.bezierCurveTo(400, y * 80, 800, 550, 1200, 250 + y * 80); ctx.lineTo(1200, 600); ctx.lineTo(0, 600); ctx.fill()}
	} else if (preset.pattern === 'circles') {
		for (let i = 0; i < 4; i++) {ctx.beginPath(); ctx.arc(150 + i * 350, 150 + i % 2 * 300, 180, 0, Math.PI * 2); ctx.fill()}
	} else {
		for (let x = 30; x < 1200; x += 60) for (let y = 30; y < 600; y += 60) {
			if (preset.pattern === 'dots') {ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill()} else {ctx.strokeRect(x, y, 60, 60)}
		}
	}
	const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Cover encoding failed')), 'image/png'))
	return new File([blob], `astering-cover-${preset.id}.png`, {type: 'image/png'})
}
