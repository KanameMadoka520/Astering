import {afterEach, describe, expect, it, vi} from 'vitest'
import {scrollKanbanColumnIntoView} from './scrollKanbanColumnIntoView'

afterEach(() => document.body.replaceChildren())

function createBoard(direction = 'ltr') {
	const board = document.createElement('div')
	board.style.direction = direction
	const lane = document.createElement('div')
	lane.dataset.bucketId = '6'
	board.append(lane)
	document.body.append(board)
	board.getBoundingClientRect = () => ({left: 12, right: 378}) as DOMRect
	board.scrollTo = vi.fn()
	return {board, lane}
}

describe('scrollKanbanColumnIntoView', () => {
	it('aligns the destination even before its collapsed width has finished expanding', () => {
		const {board, lane} = createBoard()
		lane.getBoundingClientRect = () => ({left: 1652, right: 1696, width: 44}) as DOMRect
		expect(scrollKanbanColumnIntoView(board, 6)).toBe(lane)
		expect(board.scrollTo).toHaveBeenLastCalledWith({left: 1640, behavior: 'auto'})
		// Expansion changes its width, but must not change which lane is revealed.
		lane.getBoundingClientRect = () => ({left: 1652, right: 1972, width: 320}) as DOMRect
		scrollKanbanColumnIntoView(board, 6)
		expect(board.scrollTo).toHaveBeenLastCalledWith({left: 1640, behavior: 'auto'})
	})

	it('uses the right edge and existing scroll position for RTL', () => {
		const {board, lane} = createBoard('rtl')
		board.scrollLeft = -100
		lane.getBoundingClientRect = () => ({left: -300, right: 20}) as DOMRect
		scrollKanbanColumnIntoView(board, 6, {behavior: 'smooth'})
		expect(board.scrollTo).toHaveBeenCalledWith({left: -458, behavior: 'smooth'})
	})

	it('leaves an already visible desktop column in place unless explicitly selected', () => {
		const {board, lane} = createBoard()
		lane.getBoundingClientRect = () => ({left: 40, right: 360}) as DOMRect
		scrollKanbanColumnIntoView(board, 6, {onlyIfOutside: true})
		expect(board.scrollTo).not.toHaveBeenCalled()
		scrollKanbanColumnIntoView(board, 6)
		expect(board.scrollTo).toHaveBeenCalledWith({left: 28, behavior: 'auto'})
	})

	it('does not scroll a missing column or a detached cached board', () => {
		const {board} = createBoard()
		expect(scrollKanbanColumnIntoView(board, 7)).toBeNull()
		board.remove()
		expect(scrollKanbanColumnIntoView(board, 6)).toBeNull()
		expect(board.scrollTo).not.toHaveBeenCalled()
	})
})
