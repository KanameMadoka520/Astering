// Align by the lane's start edge, even when a draggable child has not painted its expanded width yet.
export function scrollKanbanColumnIntoView(board: HTMLElement, id: number, {
	behavior = 'auto',
	onlyIfOutside = false,
}: {behavior?: ScrollBehavior, onlyIfOutside?: boolean} = {}) {
	if (!board.isConnected) return null
	const lane = board.querySelector<HTMLElement>(`[data-bucket-id="${id}"]`)
	if (!lane) return null
	const rtl = getComputedStyle(board).direction === 'rtl'
	const bounds = board.getBoundingClientRect()
	const rect = lane.getBoundingClientRect()
	if (onlyIfOutside && rect.left >= bounds.left && rect.right <= bounds.right) return lane
	board.scrollTo({
		left: board.scrollLeft + (rtl ? rect.right - bounds.right : rect.left - bounds.left),
		behavior,
	})
	return lane
}
