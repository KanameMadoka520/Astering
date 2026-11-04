import {describe, expect, it} from 'vitest'
import {
	changePanelGeometry,
	clampPanelGeometry,
	defaultPanelGeometry,
	type PanelGeometry,
	type PanelViewport,
	type ResizeEdge,
} from './useFloatingAronaGeometry'

const desktop: PanelViewport = {
	width: 1440,
	height: 900,
	left: 0,
	top: 0,
}

describe('floating Arona geometry', () => {
	it('keeps all edges on screen after dragging, shrinking, browser zoom and visual viewport offsets', () => {
		const chosen: PanelGeometry = {
			x: 1100,
			y: 500,
			width: 660,
			height: 720,
		}
		for (const view of [
			desktop,
			{width: 820, height: 600, left: 0, top: 0},
			{width: 320, height: 240, left: 24, top: 90},
		]) {
			const rect = clampPanelGeometry(chosen, view)
			expect(rect.x).toBeGreaterThanOrEqual(view.left + 12)
			expect(rect.y).toBeGreaterThanOrEqual(Math.max(64, view.top + 12))
			expect(rect.x + rect.width).toBeLessThanOrEqual(view.left + view.width - 12)
			expect(rect.y + rect.height).toBeLessThanOrEqual(view.top + view.height - 12)
		}
	})

	it('resizes from the dragged edge while retaining the opposite edge and readable minimums', () => {
		const start: PanelGeometry = {
			x: 300,
			y: 160,
			width: 600,
			height: 500,
		}
		const left = changePanelGeometry(start, 'w', 1000, 0, desktop)
		expect(left.width).toBe(360)
		expect(left.x + left.width).toBe(start.x + start.width)
		const top = changePanelGeometry(start, 'n', 0, 1000, desktop)
		expect(top.height).toBe(320)
		expect(top.y + top.height).toBe(start.y + start.height)
		for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeEdge[]) {
			const rect = changePanelGeometry(start, edge, -10000, 10000, desktop)
			expect(rect.width).toBeGreaterThanOrEqual(360)
			expect(rect.height).toBeGreaterThanOrEqual(320)
			expect(rect.x).toBeGreaterThanOrEqual(12)
			expect(rect.y).toBeGreaterThanOrEqual(64)
			expect(rect.x + rect.width).toBeLessThanOrEqual(1428)
			expect(rect.y + rect.height).toBeLessThanOrEqual(888)
		}
	})

	it('starts at a readable bottom-right size and retains room for the launcher', () => {
		const rect = defaultPanelGeometry(desktop)
		expect(rect.width).toBe(460)
		expect(rect.height).toBe(720)
		expect(rect.x + rect.width).toBe(1424)
		expect(rect.y + rect.height).toBe(824)
		const moved = changePanelGeometry(rect, 'move', -200, -20, desktop)
		expect(moved.width).toBe(rect.width)
		expect(moved.height).toBe(rect.height)
		expect(moved.x).toBe(rect.x - 200)
		expect(moved.y).toBe(rect.y - 20)
	})
})
