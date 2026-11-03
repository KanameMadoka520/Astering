import {writeFile} from 'node:fs/promises'
import type {Locator, Page} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {TaskFactory} from '../../factories/task'
import {createDefaultViews} from '../project/prepareProjects'
import {updateUserSettings} from '../../support/updateUserSettings'

test.use({timezoneId: 'America/Los_Angeles'})

const anchor = '2026-11-03'
const isCalendar = (url: string) => new URL(url).pathname === '/api/v2/tasks/calendar'
const labels = {
	en: {
		view: 'Calendar view',
		month: 'month',
		day: 'day',
		agenda: 'agenda',
		options: 'Display options',
		zoom: 'Time scale',
		create: 'New schedule',
		dialog: 'Schedule a task',
		title: 'What would you like to arrange?',
		start: 'Start time',
		end: 'End time',
		save: 'Create and open task',
		important: 'High priority only',
		hideDone: 'Hide completed',
	},
	'zh-CN': {
		view: '日历视图',
		month: 'month',
		day: 'day',
		agenda: 'agenda',
		options: '显示设置',
		zoom: '时间轴缩放',
		create: '新建安排',
		dialog: '安排一项任务',
		title: '想安排什么事情？',
		start: '开始时间',
		end: '结束时间',
		save: '创建并查看任务',
		important: '只看高优先级',
		hideDone: '隐藏已完成',
	},
}

async function ensureCalendarFiltersVisible(page: Page) {
	await expect(page.locator('.calendar-command-bar')).toBeVisible()
	if (!await page.evaluate(() => matchMedia('(max-width: 768px)').matches)) return
	const toggle = page.locator('.calendar-filter-toggle')
	await expect(toggle).toBeVisible()
	if (await toggle.getAttribute('aria-expanded') === 'false') {
		await toggle.click()
		await expect(toggle).toHaveAttribute('aria-expanded', 'true')
	}
}

async function expectOpaqueCalendarForm(dialog: Locator) {
	await expect(dialog).toHaveCSS('opacity', '1')
	await expect(dialog.locator('.modal-content')).toHaveCSS('opacity', '1')
	const form = dialog.locator('.calendar-create')
	await expect(form).toHaveCSS('opacity', '1')
	const paint = await form.evaluate(element => {
		// Let the browser resolve native CSS color syntax, including color(srgb ...).
		const canvas = document.createElement('canvas')
		canvas.width = 1
		canvas.height = 1
		const context = canvas.getContext('2d')!
		const rgba = (color: string) => {
			context.clearRect(0, 0, 1, 1)
			context.fillStyle = color
			context.fillRect(0, 0, 1, 1)
			return Array.from(context.getImageData(0, 0, 1, 1).data)
		}
		const background = rgba(getComputedStyle(element).backgroundColor)
		const foreground = rgba(getComputedStyle(element.querySelector('label')!).color)
		const luminance = (color: number[]) => {
			const [red, green, blue] = color.map(value => {
				const channel = value / 255
				return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
			})
			return .2126 * red + .7152 * green + .0722 * blue
		}
		const levels = [luminance(background), luminance(foreground)].sort((a, b) => a - b)
		return {background, foreground, contrast: (levels[1] + .05) / (levels[0] + .05)}
	})
	expect(paint.background[3], 'The creation form must paint an opaque surface').toBe(255)
	expect(paint.foreground[3], 'The creation label must paint opaque text').toBe(255)
	expect(paint.contrast, 'The creation label must remain readable against its own surface').toBeGreaterThanOrEqual(4.5)
}

async function measureCalendarText(event: Locator) {
	await event.scrollIntoViewIfNeeded()
	return event.evaluate(element => {
		return ['.calendar-event-title', '.calendar-event-time'].map(selector => {
			const text = element.querySelector<HTMLElement>(selector)
			if (!text) return {
				selector,
				missing: true as const,
			}
			const style = getComputedStyle(text)
			const box = text.getBoundingClientRect()
			const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
			let node: Node | null
			let glyph: DOMRect | undefined
			while ((node = walker.nextNode())) {
				const offset = node.textContent?.search(/\S/) ?? -1
				if (offset < 0) continue
				const range = document.createRange()
				range.setStart(node, offset)
				range.setEnd(node, offset + 1)
				glyph = range.getBoundingClientRect()
				break
			}
			let top = 0
			let bottom = innerHeight
			let left = 0
			let right = innerWidth
			const clipSources = []
			for (let ancestor: Element | null = text; ancestor; ancestor = ancestor.parentElement) {
				// The root scrollport is the viewport; its document rect also includes the page's scroll offset.
				if (ancestor === document.scrollingElement) continue
				const overflow = getComputedStyle(ancestor)
				if (overflow.display === 'inline' || overflow.display === 'contents') continue
				const bounds = ancestor.getBoundingClientRect()
				if (/(hidden|clip|auto|scroll)/.test(`${overflow.overflowY} ${overflow.overflowX}`)) {
					clipSources.push({
						tag: ancestor.localName,
						className: ancestor.className,
						top: bounds.top + ancestor.clientTop,
						bottom: bounds.top + ancestor.clientTop + ancestor.clientHeight,
					})
				}
				if (/(hidden|clip|auto|scroll)/.test(overflow.overflowY)) {
					top = Math.max(top, bounds.top + ancestor.clientTop)
					bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight)
				}
				if (/(hidden|clip|auto|scroll)/.test(overflow.overflowX)) {
					left = Math.max(left, bounds.left + ancestor.clientLeft)
					right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth)
				}
			}
			return {
				selector,
				missing: false as const,
				height: box.height,
				lineHeight: Number.parseFloat(style.lineHeight),
				fontSize: Number.parseFloat(style.fontSize),
				clipSources,
				glyph: glyph ? {
					top: glyph.top,
					bottom: glyph.bottom,
					left: glyph.left,
					right: glyph.right,
					height: glyph.height,
				} : null,
				clip: {
					top,
					bottom,
					left,
					right,
				},
			}
		})
	})
}

for (const scenario of [
	{width: 1440, language: 'en'},
	{width: 2048, language: 'en'},
	{width: 390, language: 'zh-CN'},
	{width: 320, language: 'en'},
] as const) {
	for (const zoom of [100, 25]) {
		test(`calendar readable short events ${scenario.width}px ${scenario.language} at ${zoom}%`, async ({
			authenticatedPage: page,
			apiContext,
			userToken,
			currentUser,
		}, testInfo) => {
			await page.setViewportSize({width: scenario.width, height: 900})
			await updateUserSettings(apiContext, userToken, {
				language: scenario.language,
				timezone: 'Asia/Shanghai',
				week_start: 1,
			})
			const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
			const local = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 3, hour - 8, minute)).toISOString()
			const data = [
				{title: '短时间点 Start marker', start_date: local(2)},
				{title: '一分钟安排 Brief meeting', start_date: local(5), end_date: local(5, 1)},
				{title: '截止节点 Deadline marker', due_date: local(8)},
				{title: '并行安排 Alpha overlap', start_date: local(11), end_date: local(11, 5)},
				{title: '并行安排 Bravo overlap', start_date: local(11, 1), end_date: local(11, 6)},
				{title: '并行安排 Charlie overlap', start_date: local(11, 2), end_date: local(11, 7)},
				{title: '结束节点 End marker', end_date: local(15)},
			]
			await TaskFactory.create(data.length, {
				project_id: project.id,
				created_by_id: currentUser.id,
				title: (index: number) => data[index - 1].title,
				start_date: (index: number) => data[index - 1].start_date ?? null,
				end_date: (index: number) => data[index - 1].end_date ?? null,
				due_date: (index: number) => data[index - 1].due_date ?? null,
			})
			await page.goto(`/calendar?view=week&date=${anchor}&project=${project.id}&zoom=${zoom}`)
			await expect(page.locator('.calendar-time-column')).toHaveCount(7)
			await page.evaluate(() => document.fonts.ready.then(() => undefined))
			const measurements = []
			for (const id of [1, 2, 3, 7]) {
				const event = page.locator(`.calendar-time-body .calendar-event[data-task-id="${id}"]`)
				await expect(event).toHaveCount(1)
				measurements.push({taskId: id, text: await measureCalendarText(event)})
			}
			const report = JSON.stringify({
				...scenario,
				zoom,
				measurements,
			}, null, 2)
			await writeFile(testInfo.outputPath('calendar-text-metrics.json'), report)
			await testInfo.attach('calendar-text-metrics.json', {
				body: report,
				contentType: 'application/json',
			})
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-short-${scenario.width}-${zoom}.png`)})
			for (const event of measurements) {
				for (const metric of event.text) {
					const context = `task ${event.taskId} ${metric.selector} at ${scenario.width}px/${zoom}%`
					expect.soft(metric.missing, `${context}: text must be rendered`).toBe(false)
					if (metric.missing) continue
					expect.soft(metric.height + 1, `${context}: flex shrinking must not crush the text line`)
						.toBeGreaterThanOrEqual(metric.lineHeight!)
					expect.soft(metric.glyph, `${context}: a real text glyph must exist`).not.toBeNull()
					if (!metric.glyph) continue
					expect.soft(metric.glyph.height, `${context}: glyph must have measurable height`).toBeGreaterThan(0)
					expect.soft(metric.glyph.top + 1, `${context}: glyph top must not be clipped`)
						.toBeGreaterThanOrEqual(metric.clip!.top)
					expect.soft(metric.glyph.bottom - 1, `${context}: glyph bottom must not be clipped`)
						.toBeLessThanOrEqual(metric.clip!.bottom)
					expect.soft(metric.glyph.left + 1, `${context}: first glyph must remain horizontally readable`)
						.toBeGreaterThanOrEqual(metric.clip!.left)
					expect.soft(metric.glyph.right - 1, `${context}: first glyph must remain horizontally readable`)
						.toBeLessThanOrEqual(metric.clip!.right)
				}
			}
			const overlap = page.locator(`.calendar-time-overflow[data-overflow-date="${anchor}"]`)
			const overflowGroups = await overlap.count()
			expect(overflowGroups).toBeLessThanOrEqual(1)
			const visibleOverlaps = await page.locator(
				'.calendar-time-body [data-task-id="4"], .calendar-time-body [data-task-id="5"], .calendar-time-body [data-task-id="6"]',
			).count()
			const hiddenOverlaps = overflowGroups ? Number(await overlap.getAttribute('data-overflow-count')) : 0
			expect(hiddenOverlaps + visibleOverlaps).toBe(3)
			if (overflowGroups) {
				expect(hiddenOverlaps).toBeGreaterThan(0)
				await overlap.click()
			} else {
				await page.locator(`.calendar-time-date:has(time[datetime="${anchor}"])`).click()
			}
			const selected = page.locator(`#calendar-selected-day [data-agenda-date="${anchor}"]`)
			await expect(selected.locator('.calendar-event')).toHaveCount(data.length)
			for (const row of data) await expect(selected).toContainText(row.title)
			await selected.scrollIntoViewIfNeeded()
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-overlap-${scenario.width}-${zoom}.png`)})
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		})
	}
}

for (const scenario of [
	{width: 1440, language: 'en'},
	{width: 320, language: 'en'},
	{width: 390, language: 'zh-CN'},
] as const) {
	test(`calendar ${scenario.width}px ${scenario.language} keeps time, filters, task modal and creation consistent`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
		currentUser,
	}, testInfo) => {
		const text = labels[scenario.language]
		await page.setViewportSize({width: scenario.width, height: 844})
		await updateUserSettings(apiContext, userToken, {
			language: scenario.language,
			timezone: 'Asia/Shanghai',
			week_start: 1,
		})
		const [project] = await ProjectFactory.create(1, {
			owner_id: currentUser.id,
			title: 'Calendar fixture',
		})
		await createDefaultViews(project.id)
		const data = [
			{
				title: 'Across local midnight',
				start_date: '2026-11-02T15:30:00Z',
				end_date: '2026-11-02T16:30:00Z',
				due_date: '2026-11-02T17:00:00Z',
				priority: 3,
			},
			{
				title: 'Morning meeting',
				start_date: '2026-11-03T01:00:00Z',
				end_date: '2026-11-03T02:00:00Z',
			},
			{
				title: 'Overlapping meeting',
				start_date: '2026-11-03T01:30:00Z',
				end_date: '2026-11-03T02:30:00Z',
			},
			{
				title: 'Deadline without invented duration',
				due_date: '2026-11-03T03:00:00Z',
			},
			{
				title: 'Already completed',
				start_date: '2026-11-03T04:00:00Z',
				end_date: '2026-11-03T05:00:00Z',
				done: true,
			},
			{
				title: 'Unscheduled task stays out',
			},
		]
		await TaskFactory.create(data.length, {
			project_id: project.id,
			created_by_id: currentUser.id,
			title: (index: number) => data[index - 1].title,
			start_date: (index: number) => data[index - 1].start_date ?? null,
			end_date: (index: number) => data[index - 1].end_date ?? null,
			due_date: (index: number) => data[index - 1].due_date ?? null,
			done: (index: number) => data[index - 1].done ?? false,
			priority: (index: number) => data[index - 1].priority ?? 0,
		})
		const requests: URL[] = []
		page.on('request', request => {
			if (isCalendar(request.url())) requests.push(new URL(request.url()))
		})
		await page.goto(`/calendar?view=week&date=${anchor}&project=${project.id}`)
		await expect(page.locator('.calendar-time-column')).toHaveCount(7)
		await expect(page.locator('.calendar-time-column[data-timeline-date="2026-11-02"] [data-task-id="1"]')).toHaveCount(1)
		await expect(page.locator('.calendar-time-column[data-timeline-date="2026-11-03"] [data-task-id="1"]')).toHaveCount(2)
		await expect(page.locator('.calendar-time-body [data-task-id="4"][data-event-kind="due"]')).toHaveCount(1)
		await expect(page.locator('.calendar-time-body [data-task-id="4"][data-event-kind="range"]')).toHaveCount(0)
		await expect(page.locator('.calendar-time-body [data-task-id="5"]')).toHaveCount(0)
		await expect(page.locator('.calendar-time-body')).not.toContainText('Unscheduled task stays out')
		expect(requests.every(url => url.searchParams.get('timezone') === 'Asia/Shanghai')).toBe(true)
		expect(requests[0].searchParams.get('from')).toBe('2026-11-02')
		expect(requests[0].searchParams.get('to')).toBe('2026-11-09')

		const overlapping = await page.locator('.calendar-time-body [data-task-id="2"], .calendar-time-body [data-task-id="3"]')
			.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
		expect(overlapping).toHaveLength(2)
		expect(overlapping.every(width => width > 0)).toBe(true)
		await ensureCalendarFiltersVisible(page)
		await page.getByRole('button', {name: text.options, exact: true}).click()
		const timeline = page.locator('.calendar-time-scroll')
		await timeline.evaluate(element => { element.scrollTop = 640 })
		const beforeZoomRequests = requests.length
		await page.getByRole('slider', {name: text.zoom, exact: true}).focus()
		await page.keyboard.press('End')
		await expect(page).toHaveURL(/zoom=250/)
		await page.keyboard.press('Escape')
		await expect(page.getByRole('slider', {name: text.zoom, exact: true})).not.toBeVisible()
		await expect.poll(() => timeline.evaluate(element => element.scrollTop / 160)).toBeCloseTo(10, 1)
		expect(requests.length).toBe(beforeZoomRequests)
		const meeting = page.locator('.calendar-time-body [data-task-id="2"][data-event-kind="range"]')
		await meeting.scrollIntoViewIfNeeded()
		// Locator clicks may scroll past a sticky header before pointerdown. Compare the
		// actual activation position, rather than that earlier auto-scroll preparation.
		await meeting.evaluate(element => element.addEventListener('pointerdown', () => {
			const scroller = element.closest('.calendar-time-scroll')!
			Reflect.set(window, '__calendarActivationScroll', {
				top: scroller.scrollTop,
				left: scroller.scrollLeft,
			})
		}, {once: true}))
		await page.evaluate(() => Reflect.set(window, '__calendarDocument', true))
		await meeting.click()
		const scrollBeforeModal = await page.evaluate(() => Reflect.get(window, '__calendarActivationScroll'))
		expect(scrollBeforeModal).toEqual({
			top: expect.any(Number),
			left: expect.any(Number),
		})
		await expect(page.locator('.task-view')).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page.locator('.task-view')).not.toBeVisible()
		await expect(page).toHaveURL(/date=2026-11-03/)
		await expect(page).toHaveURL(/zoom=250/)
		expect(await page.evaluate(() => Reflect.get(window, '__calendarDocument'))).toBe(true)
		await expect.poll(() => timeline.evaluate(element => ({
			top: element.scrollTop,
			left: element.scrollLeft,
		}))).toEqual(scrollBeforeModal)
		await meeting.click()
		await expect(page.locator('.task-view')).toBeVisible()
		await page.reload()
		await expect(page.locator('.task-view')).toBeVisible()
		await expect(page.locator('.calendar-date-input')).toHaveValue(anchor)
		await expect(page.locator('.calendar-mode-picker select')).toHaveValue('week')
		await page.keyboard.press('Escape')
		await expect(page.locator('.task-view')).not.toBeVisible()
		await expect(page).toHaveURL(/date=2026-11-03/)
		await expect(page).toHaveURL(/zoom=250/)
		await ensureCalendarFiltersVisible(page)
		await page.getByRole('button', {name: text.options, exact: true}).click()
		await expect(page.getByRole('slider', {name: text.zoom, exact: true})).toHaveValue('250')
		await page.keyboard.press('Escape')
		await expect(page.getByRole('slider', {name: text.zoom, exact: true})).not.toBeVisible()

		await page.getByRole('combobox', {name: text.view, exact: true}).selectOption(text.month)
		await expect(page.locator('.calendar-month-cell')).toHaveCount(42)
		await page.locator('[data-calendar-date="2026-11-03"]').click()
		await expect(page.locator('.calendar-agenda-day[data-agenda-date="2026-11-03"]')).toContainText('Morning meeting')
		await expect(page.locator('.calendar-occupancy')).toBeVisible()
		await ensureCalendarFiltersVisible(page)
		await page.getByLabel(text.important, {exact: true}).check()
		await expect(page.locator('.calendar-agenda')).not.toContainText('Morning meeting')
		await expect(page.locator('.calendar-agenda')).toContainText('Across local midnight')
		await page.getByLabel(text.important, {exact: true}).uncheck()
		await page.getByLabel(text.hideDone, {exact: true}).uncheck()
		await expect(page.locator('.calendar-agenda')).toContainText('Already completed')
		await page.reload()
		await ensureCalendarFiltersVisible(page)
		await expect(page.getByLabel(text.hideDone, {exact: true})).not.toBeChecked()
		await expect(page.getByRole('combobox', {name: text.view, exact: true})).toHaveValue('month')
		await expect(page.locator('.calendar-agenda')).toContainText('Already completed')
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-month-${scenario.width}-${scenario.language}.png`)})

		await page.locator(scenario.width <= 768 ? '.calendar-mobile-actions' : '.calendar-heading-actions')
			.getByRole('button', {name: text.create, exact: true}).click()
		const dialog = page.getByRole('dialog', {name: text.dialog, exact: true})
		await dialog.getByPlaceholder(text.title, {exact: true}).fill('Created in the account time zone')
		await dialog.getByRole('combobox').first().selectOption(String(project.id))
		await dialog.getByLabel(text.start, {exact: true}).fill('2026-11-03T09:00')
		await dialog.getByLabel(text.end, {exact: true}).fill('2026-11-03T10:00')
		const created = page.waitForResponse(response => response.request().method() === 'POST'
			&& new URL(response.url()).pathname === `/api/v2/projects/${project.id}/tasks`)
		await dialog.getByRole('button', {name: text.save, exact: true}).click()
		const response = await created
		expect(response.ok()).toBe(true)
		const stored = await response.json()
		const read = await apiContext.get(`/api/v2/tasks/${stored.id}`, {
			headers: {Authorization: `Bearer ${userToken}`},
		})
		expect(read.ok()).toBe(true)
		const saved = await read.json()
		expect(Date.parse(saved.start_date)).toBe(Date.parse('2026-11-03T01:00:00Z'))
		expect(Date.parse(saved.end_date)).toBe(Date.parse('2026-11-03T02:00:00Z'))
		await expect(page.locator('.task-view')).toBeVisible()
		await expect(page.locator('dialog.task-detail-view-modal[open]')).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page).toHaveURL(/\/calendar\?/)
		await expect(page.locator('dialog.task-detail-view-modal[open]')).toHaveCount(0)
		await page.reload()
		await expect(page.locator('.calendar-agenda')).toContainText('Created in the account time zone')
	})
}

test('calendar upward drag creates the whole selected quarter-hour range once', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
	currentUser,
}) => {
	await page.setViewportSize({width: 1440, height: 900})
	await updateUserSettings(apiContext, userToken, {timezone: 'Asia/Shanghai', week_start: 1})
	const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
	await createDefaultViews(project.id)
	await page.goto(`/calendar?view=day&date=${anchor}&project=${project.id}`)
	const lower = page.locator(`.calendar-time-slot[data-slot-date="${anchor}"][data-slot-minute="900"]`)
	const upper = page.locator(`.calendar-time-slot[data-slot-date="${anchor}"][data-slot-minute="840"]`)
	await lower.scrollIntoViewIfNeeded()
	await upper.scrollIntoViewIfNeeded()
	const from = await lower.boundingBox()
	const to = await upper.boundingBox()
	expect(from).not.toBeNull()
	expect(to).not.toBeNull()
	await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2 + .5)
	await page.mouse.down()
	await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 4 + .5, {steps: 6})
	await page.mouse.up()
	const dialog = page.getByRole('dialog', {name: labels.en.dialog, exact: true})
	await expect(dialog.getByLabel(labels.en.start, {exact: true})).toHaveValue(`${anchor}T14:15`)
	await expect(dialog.getByLabel(labels.en.end, {exact: true})).toHaveValue(`${anchor}T15:45`)
	await expect(page.getByRole('dialog', {name: labels.en.dialog, exact: true})).toHaveCount(1)
	await dialog.getByPlaceholder(labels.en.title, {exact: true}).fill('Saved upward selection')
	const writes: string[] = []
	page.on('request', request => {
		if (request.method() === 'POST'
			&& new URL(request.url()).pathname === `/api/v2/projects/${project.id}/tasks`) writes.push(request.url())
	})
	const created = page.waitForResponse(response => response.request().method() === 'POST'
		&& new URL(response.url()).pathname === `/api/v2/projects/${project.id}/tasks`)
	await dialog.getByRole('button', {name: labels.en.save, exact: true}).click()
	const response = await created
	expect(response.ok()).toBe(true)
	const stored = await response.json()
	const read = await apiContext.get(`/api/v2/tasks/${stored.id}`, {
		headers: {Authorization: `Bearer ${userToken}`},
	})
	expect(read.ok()).toBe(true)
	const saved = await read.json()
	expect(Date.parse(saved.start_date)).toBe(Date.parse('2026-11-03T06:15:00Z'))
	expect(Date.parse(saved.end_date)).toBe(Date.parse('2026-11-03T07:45:00Z'))
	expect(writes).toHaveLength(1)
})

for (const scenario of [
	{width: 1440, language: 'en', allDay: 'All day'},
	{width: 390, language: 'zh-CN', allDay: '全天'},
] as const) {
	test(`calendar all-day dates ${scenario.width}px ${scenario.language} stay civil across timezone changes`, async ({
		authenticatedPage: page,
		apiContext,
		userToken,
		currentUser,
	}, testInfo) => {
		const text = labels[scenario.language]
		const headers = {Authorization: `Bearer ${userToken}`}
		await page.setViewportSize({width: scenario.width, height: 900})
		await updateUserSettings(apiContext, userToken, {
			language: scenario.language,
			timezone: 'Asia/Shanghai',
			week_start: 1,
		})
		const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
		await createDefaultViews(project.id)
		await page.goto(`/calendar?view=week&date=${anchor}&project=${project.id}`)
		await page.getByRole('button', {
			name: `${text.create} · ${anchor} · ${scenario.allDay}`,
			exact: true,
		}).click()
		const dialog = page.getByRole('dialog', {name: text.dialog, exact: true})
		await expect(dialog.getByRole('switch', {name: scenario.allDay, exact: true})).toBeChecked()
		await dialog.getByPlaceholder(text.title, {exact: true}).fill('Civil three-day fixture')
		await dialog.locator('input[type="date"]').first().fill(anchor)
		await dialog.locator('input[type="date"]').last().fill('2026-11-05')
		const created = page.waitForResponse(response => response.request().method() === 'POST'
			&& new URL(response.url()).pathname === `/api/v2/projects/${project.id}/tasks`)
		await dialog.getByRole('button', {name: text.save, exact: true}).click()
		const response = await created
		expect(response.ok()).toBe(true)
		const stored = await response.json()
		const read = await apiContext.get(`/api/v2/tasks/${stored.id}`, {headers})
		expect(read.ok()).toBe(true)
		const saved = await read.json()
		expect(saved.all_day).toBe(true)
		expect(saved.all_day_start).toBe(anchor)
		expect(saved.all_day_end).toBe('2026-11-06')
		expect(saved.start_date == null || Date.parse(saved.start_date) < 0).toBe(true)
		expect(saved.end_date == null || Date.parse(saved.end_date) < 0).toBe(true)
		await expect(page.locator('.task-view')).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(page.locator('.task-view')).not.toBeVisible()
		await expect(page.locator(`.calendar-all-day-strip [data-task-id="${stored.id}"]`)).toHaveCount(3)
		await expect(page.locator(`.calendar-time-body [data-task-id="${stored.id}"]`)).toHaveCount(0)
		const timed = await apiContext.post(`/api/v2/projects/${project.id}/tasks`, {
			headers,
			data: {
				title: 'Timed midnight remains timed',
				start_date: '2026-11-02T16:00:00Z',
				end_date: '2026-11-02T17:00:00Z',
			},
		})
		expect(timed.ok()).toBe(true)
		const timedTask = await timed.json()
		await page.reload()
		await expect(page.locator(`.calendar-time-body [data-task-id="${timedTask.id}"][data-event-kind="range"]`)).toHaveCount(1)
		await expect(page.locator(`.calendar-all-day-strip [data-task-id="${timedTask.id}"]`)).toHaveCount(0)
		await updateUserSettings(apiContext, userToken, {timezone: 'Pacific/Apia'})
		await page.reload()
		await expect(page.locator(`.calendar-all-day-strip [data-task-id="${stored.id}"]`)).toHaveCount(3)
		const ranged = await apiContext.get(`/api/v2/tasks/calendar?from=2026-11-03&to=2026-11-06&timezone=Pacific%2FApia&project_id=${project.id}`, {headers})
		expect(ranged.ok()).toBe(true)
		const item = (await ranged.json()).items.find((task: {id: number}) => task.id === stored.id)
		expect(item).toMatchObject({
			all_day: true,
			all_day_start: anchor,
			all_day_end: '2026-11-06',
		})
		await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-all-day-${scenario.width}-${scenario.language}.png`)})
	})
}

for (const scenario of [
	{width: 1440, language: 'en'},
	{width: 390, language: 'zh-CN'},
	{width: 320, language: 'en'},
] as const) {
	test.describe(`calendar all-day editing input ${scenario.width}px ${scenario.language}`, () => {
		test.use({hasTouch: scenario.width <= 640})
		test(`calendar all-day editor ${scenario.width}px ${scenario.language} saves civil edits, timed conversion and clearing`, async ({
			authenticatedPage: page,
			apiContext,
			userToken,
			currentUser,
		}, testInfo) => {
			const text = scenario.language === 'zh-CN' ? {
				edit: '编辑日程',
				create: '设为全天',
				start: '开始日期',
				lastDay: '最后一天（含当天）',
				end: '结束日期',
				toTimed: '改为指定时间',
				save: '保存',
				clear: '清除日程',
			} : {
				edit: 'Edit schedule',
				create: 'Schedule all day',
				start: 'Start date',
				lastDay: 'Last day (inclusive)',
				end: 'End Date',
				toTimed: 'Switch to timed schedule',
				save: 'Save',
				clear: 'Clear schedule',
			}
			const headers = {Authorization: `Bearer ${userToken}`}
			const deadline = '2026-11-10T04:00:00Z'
			await page.setViewportSize({width: scenario.width, height: 900})
			await updateUserSettings(apiContext, userToken, {
				language: scenario.language,
				timezone: 'Asia/Shanghai',
				week_start: 1,
			})
			const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
			await createDefaultViews(project.id)
			const tasks = []
			for (const title of ['Editable civil fixture', 'Clear civil fixture']) {
				const created = await apiContext.post(`/api/v2/projects/${project.id}/tasks`, {
					headers,
					data: {
						title,
						all_day: true,
						all_day_start: anchor,
						all_day_end: '2026-11-06',
						due_date: deadline,
					},
				})
				expect(created.ok()).toBe(true)
				tasks.push(await created.json())
			}
			const [task, clearTask] = tasks
			const section = page.locator('.task-view .task-all-day')
			async function saveEditor(id: number, button: Locator, expected: Record<string, unknown>) {
				const completed = page.waitForResponse(response => response.request().method() === 'PATCH'
					&& new URL(response.url()).pathname === `/api/v2/tasks/${id}`)
				await button.click()
				const response = await completed
				expect(response.ok()).toBe(true)
				// Request body streams can be absent from Chromium's postDataJSON. Check
				// the real PATCH acknowledgement and an independent persisted GET instead.
				expect(await response.json()).toMatchObject(expected)
				await expect(section.locator('form')).toHaveCount(0)
				const read = await apiContext.get(`/api/v2/tasks/${id}`, {headers})
				expect(read.ok()).toBe(true)
				const saved = await read.json()
				expect(saved).toMatchObject(expected)
				expect(Date.parse(saved.due_date)).toBe(Date.parse(deadline))
				return saved
			}
			await page.goto(`/calendar?view=month&date=${anchor}&project=${project.id}`)
			await expect(page.locator('.calendar-month-cell')).toHaveCount(42)
			await expect(page.locator('.calendar-month-view')).toContainText(task.title)
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-edit-month-${scenario.width}.png`)})
			await page.locator(`[data-calendar-date="${anchor}"]`).click()
			const selected = page.locator('#calendar-selected-day')
			await expect(selected.locator(`[data-task-id="${task.id}"][data-event-kind="all_day"]`)).toHaveCount(1)
			await selected.scrollIntoViewIfNeeded()
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-edit-selected-${scenario.width}.png`)})
			await selected.locator(`[data-task-id="${task.id}"][data-event-kind="all_day"]`).click()
			await expect(page.locator('dialog.task-detail-view-modal[open]')).toBeVisible()
			await expect(section.locator('.task-all-day__range')).toHaveText(`${anchor} — 2026-11-05`)
			await section.getByRole('button', {name: text.edit, exact: true}).click()
			await section.getByLabel(text.start, {exact: true}).fill('2026-11-04')
			await section.getByLabel(text.lastDay, {exact: true}).fill('2026-11-06')
			await section.locator('form').scrollIntoViewIfNeeded()
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-edit-civil-form-${scenario.width}.png`)})
			const civil = await saveEditor(task.id, section.getByRole('button', {name: text.save, exact: true}), {
				all_day: true,
				all_day_start: '2026-11-04',
				all_day_end: '2026-11-07',
			})
			expect(civil).toMatchObject({
				all_day: true,
				all_day_start: '2026-11-04',
				all_day_end: '2026-11-07',
			})
			await expect(section.locator('.task-all-day__range')).toHaveText('2026-11-04 — 2026-11-06')
			await page.keyboard.press('Escape')
			await expect(page.locator('.task-view')).not.toBeVisible()
			await expect(selected.locator(`[data-task-id="${task.id}"][data-event-kind="all_day"]`)).toHaveCount(0)
			await page.locator('[data-calendar-date="2026-11-04"]').click()
			await expect(selected.locator(`[data-task-id="${task.id}"][data-event-kind="all_day"]`)).toHaveCount(1)
			await selected.locator(`[data-task-id="${task.id}"][data-event-kind="all_day"]`).click()
			await section.getByRole('button', {name: text.edit, exact: true}).click()
			await section.getByRole('button', {name: text.toTimed, exact: true}).click()
			const timedStart = section.getByLabel(scenario.language === 'zh-CN' ? text.start : 'Start Date', {exact: true})
			await expect(timedStart).toHaveValue('')
			await expect(section.getByLabel(text.end, {exact: true})).toHaveValue('')
			await timedStart.fill('2026-11-04T09:15')
			await section.getByLabel(text.end, {exact: true}).fill('2026-11-04T10:45')
			await section.locator('form').scrollIntoViewIfNeeded()
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-edit-timed-form-${scenario.width}.png`)})
			const timed = await saveEditor(task.id, section.getByRole('button', {name: text.save, exact: true}), {
				all_day: false,
				all_day_start: '',
				all_day_end: '',
			})
			expect(timed).toMatchObject({all_day: false, all_day_start: '', all_day_end: ''})
			expect(Date.parse(timed.start_date)).toBe(Date.parse('2026-11-04T01:15:00Z'))
			expect(Date.parse(timed.end_date)).toBe(Date.parse('2026-11-04T02:45:00Z'))
			await page.reload()
			await expect(section.getByRole('button', {name: text.create, exact: true})).toBeVisible()
			await expect(section.locator('.task-all-day__range')).toHaveCount(0)
			const reloaded = await apiContext.get(`/api/v2/tasks/${task.id}`, {headers})
			expect(reloaded.ok()).toBe(true)
			const reloadedTask = await reloaded.json()
			expect(reloadedTask).toMatchObject({all_day: false, all_day_start: '', all_day_end: ''})
			expect(Date.parse(reloadedTask.start_date)).toBe(Date.parse('2026-11-04T01:15:00Z'))
			expect(Date.parse(reloadedTask.end_date)).toBe(Date.parse('2026-11-04T02:45:00Z'))
			await page.goto(`/calendar?view=day&date=2026-11-04&project=${project.id}`)
			await expect(page.locator(`.calendar-time-body [data-task-id="${task.id}"][data-event-kind="range"]`)).toHaveCount(1)
			await expect(page.locator(`.calendar-all-day-strip [data-task-id="${task.id}"]`)).toHaveCount(0)
			await page.locator(`.calendar-time-body [data-task-id="${task.id}"]`).scrollIntoViewIfNeeded()
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-edit-timed-day-${scenario.width}.png`)})
			await page.locator(`.calendar-all-day-strip [data-task-id="${clearTask.id}"]`).click()
			await section.getByRole('button', {name: text.edit, exact: true}).click()
			const cleared = await saveEditor(clearTask.id, section.getByRole('button', {name: text.clear, exact: true}), {
				all_day: false,
				all_day_start: '',
				all_day_end: '',
				start_date: '0001-01-01T00:00:00Z',
				end_date: '0001-01-01T00:00:00Z',
			})
			expect(cleared).toMatchObject({all_day: false, all_day_start: '', all_day_end: ''})
			expect(cleared.start_date == null || Date.parse(cleared.start_date) < 0).toBe(true)
			expect(cleared.end_date == null || Date.parse(cleared.end_date) < 0).toBe(true)
			await page.reload()
			await expect(section.getByRole('button', {name: text.create, exact: true})).toBeVisible()
			await expect(section.locator('.task-all-day__range')).toHaveCount(0)
			const clearedRead = await apiContext.get(`/api/v2/tasks/${clearTask.id}`, {headers})
			expect(clearedRead.ok()).toBe(true)
			const clearedTask = await clearedRead.json()
			expect(clearedTask).toMatchObject({all_day: false, all_day_start: '', all_day_end: ''})
			expect(clearedTask.start_date == null || Date.parse(clearedTask.start_date) < 0).toBe(true)
			expect(clearedTask.end_date == null || Date.parse(clearedTask.end_date) < 0).toBe(true)
			expect(Date.parse(clearedTask.due_date)).toBe(Date.parse(deadline))
			await page.goto(`/calendar?view=day&date=2026-11-04&project=${project.id}`)
			await expect(page.locator(`.calendar-time-body [data-task-id="${task.id}"][data-event-kind="range"]`)).toHaveCount(1)
			await expect(page.locator(`.calendar-all-day-strip [data-task-id="${clearTask.id}"]`)).toHaveCount(0)
			await expect(page.locator(`.calendar-time-body [data-task-id="${clearTask.id}"]`)).toHaveCount(0)
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		})
	})
}

test.describe('calendar advanced creation on a Chinese phone', () => {
	test.use({hasTouch: true})
	test('calendar mobile creation persists daily repeat, exact reminder and escaped notes with one submission', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
		currentUser,
	}, testInfo) => {
		const date = '2040-06-01'
		const title = '手机日历完整创建验收'
		const notes = '地点：<studio> & 合作空间\n备注：带上 <方案> & 纸笔'
		const expectedDescription = '<p>地点：&lt;studio&gt; &amp; 合作空间</p><p>备注：带上 &lt;方案&gt; &amp; 纸笔</p>'
		const headers = {Authorization: `Bearer ${userToken}`}
		await page.setViewportSize({width: 390, height: 844})
		await updateUserSettings(apiContext, userToken, {
			language: 'zh-CN',
			timezone: 'Asia/Shanghai',
			week_start: 1,
			frontend_settings: {time_format: '24h'},
		})
		const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
		await createDefaultViews(project.id)
		const writes: string[] = []
		page.on('request', request => {
			if (request.method() === 'POST'
				&& new URL(request.url()).pathname === `/api/v2/projects/${project.id}/tasks`) {
				writes.push(request.url())
			}
		})
		await page.goto(`/calendar?view=day&date=${date}&project=${project.id}`)
		await expect(page.locator('.calendar-time-column')).toHaveCount(1)
		await page.getByRole('navigation', {name: '日历快捷操作', exact: true})
			.getByRole('button', {name: labels['zh-CN'].create, exact: true}).click()
		const dialog = page.getByRole('dialog', {name: labels['zh-CN'].dialog, exact: true})
		await expect(dialog).toContainText('Asia/Shanghai')
		await expect(dialog.getByLabel('准确提醒日期和时间', {exact: true})).not.toBeVisible()
		await expect(dialog.getByRole('button', {name: '每天', exact: true})).not.toBeVisible()
		await dialog.getByPlaceholder(labels['zh-CN'].title, {exact: true}).fill(title)
		await dialog.getByLabel(labels['zh-CN'].start, {exact: true}).fill(`${date}T09:00`)
		await dialog.getByLabel(labels['zh-CN'].end, {exact: true}).fill(`${date}T10:00`)
		await dialog.getByText('截止时间与优先级', {exact: true}).click()
		await dialog.getByLabel('截止时间', {exact: true}).fill(`${date}T12:00`)
		await dialog.getByRole('combobox', {name: '优先级', exact: true}).selectOption('3')
		await dialog.locator('summary').filter({hasText: /^\s*地点与备注\s*$/}).click()
		await dialog.getByRole('textbox', {name: '地点与备注', exact: true}).fill(notes)
		await dialog.locator('summary').filter({hasText: /^\s*提醒\s*$/}).click()
		await dialog.getByLabel('准确提醒日期和时间', {exact: true}).fill(`${date}T08:45`)
		await dialog.locator('summary').filter({hasText: /^\s*重复\s*$/}).click()
		await dialog.getByRole('button', {name: '每天', exact: true}).click()
		await expect(dialog.locator('.repeat-after-input input[type="number"]')).toHaveValue('1')
		await expect(dialog.locator('.repeat-after-input').getByRole('combobox', {name: '时间单位', exact: true}))
			.toHaveValue('days')
		await expect(dialog.getByRole('button', {name: '取消重复', exact: true})).toBeVisible()
		expect(writes, 'Changing repeat and other advanced fields must not submit the task').toHaveLength(0)
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
		await expectOpaqueCalendarForm(dialog)
		await page.screenshot({animations: 'disabled', path: testInfo.outputPath('calendar-mobile-advanced-form.png')})
		const created = page.waitForResponse(response => response.request().method() === 'POST'
			&& new URL(response.url()).pathname === `/api/v2/projects/${project.id}/tasks`)
		await dialog.getByRole('button', {name: labels['zh-CN'].save, exact: true}).click()
		const response = await created
		expect(response.ok()).toBe(true)
		expect(writes).toHaveLength(1)
		const stored = await response.json()
		expect(stored).toMatchObject({
			title,
			project_id: project.id,
			description: expectedDescription,
			priority: 3,
			repeat_after: 86400,
			repeat_mode: 0,
		})
		const acknowledgedReminders = stored.reminders as Array<{
			reminder: string
			relative_to: string
			relative_period: number
		}>
		expect(acknowledgedReminders).toHaveLength(1)
		expect(acknowledgedReminders[0]).toMatchObject({relative_to: '', relative_period: 0})
		expect(Date.parse(acknowledgedReminders[0].reminder)).toBe(Date.parse('2040-06-01T00:45:00Z'))
		await expect(page.locator('.task-view')).toBeVisible()
		for (const phase of ['created', 'reloaded']) {
			if (phase === 'reloaded') await page.reload()
			await expect(page.locator('.task-view')).toContainText(title)
			await expect(page.locator('.task-view').getByRole('combobox', {name: '优先级', exact: true})).toHaveValue('3')
			await expect(page.locator('.task-view .repeat-after-input input[type="number"]')).toHaveValue('1')
			await expect(page.locator('.task-view .reminders .reminder-input')).toHaveCount(1)
			const description = page.locator('.task-view .details.content.description')
			await expect(description).toContainText('地点：<studio> & 合作空间')
			await expect(description).toContainText('备注：带上 <方案> & 纸笔')
			await expect(description.locator('studio, script, img')).toHaveCount(0)
			const read = await apiContext.get(`/api/v2/tasks/${stored.id}`, {headers})
			expect(read.ok()).toBe(true)
			const saved = await read.json()
			expect(saved).toMatchObject({
				title,
				priority: 3,
				repeat_after: 86400,
				repeat_mode: 0,
			})
			expect(Date.parse(saved.start_date)).toBe(Date.parse('2040-06-01T01:00:00Z'))
			expect(Date.parse(saved.end_date)).toBe(Date.parse('2040-06-01T02:00:00Z'))
			expect(Date.parse(saved.due_date)).toBe(Date.parse('2040-06-01T04:00:00Z'))
			expect(saved.reminders).toHaveLength(1)
			expect(saved.reminders[0]).toMatchObject({relative_to: '', relative_period: 0})
			expect(Date.parse(saved.reminders[0].reminder)).toBe(Date.parse('2040-06-01T00:45:00Z'))
			expect(saved.description).toContain('&lt;studio&gt;')
			expect(saved.description).toContain('&lt;方案&gt;')
			expect(saved.description).toContain('&amp;')
			expect(saved.description).not.toContain('<studio>')
			expect(writes).toHaveLength(1)
		}
		await page.locator('.task-view .details.content.description').scrollIntoViewIfNeeded()
		await page.screenshot({animations: 'disabled', path: testInfo.outputPath('calendar-mobile-created-notes.png')})
	})
})

test('calendar DST week starting on the New York fall-back day labels each column with its real local time', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
	currentUser,
}, testInfo) => {
	await page.setViewportSize({width: 1440, height: 900})
	await updateUserSettings(apiContext, userToken, {
		language: 'en',
		timezone: 'America/New_York',
		week_start: 0,
		frontend_settings: {time_format: '24h'},
	})
	const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
	const loaded = page.waitForResponse(response => isCalendar(response.url())
		&& new URL(response.url()).searchParams.get('timezone') === 'America/New_York')
	await page.goto(`/calendar?view=week&date=2026-11-01&project=${project.id}&zoom=100`)
	const response = await loaded
	expect(response.ok()).toBe(true)
	const calendar = await response.json()
	expect(calendar.timezone).toBe('America/New_York')
	expect(calendar.days.slice(0, 2)).toEqual([
		{
			date: '2026-11-01',
			start_at: '2026-11-01T04:00:00Z',
			end_at: '2026-11-02T05:00:00Z',
		},
		{
			date: '2026-11-02',
			start_at: '2026-11-02T05:00:00Z',
			end_at: '2026-11-03T05:00:00Z',
		},
	])
	const fall = page.locator('.calendar-time-column[data-timeline-date="2026-11-01"]')
	const normal = page.locator('.calendar-time-column[data-timeline-date="2026-11-02"]')
	await expect(fall.locator('.calendar-time-slot')).toHaveCount(25)
	await expect(normal.locator('.calendar-time-slot')).toHaveCount(24)
	await expect(fall.locator('[data-slot-minute="60"] .calendar-variable-tick')).toHaveText('01:00 GMT-4')
	await expect(fall.locator('[data-slot-minute="120"] .calendar-variable-tick')).toHaveText('01:00 GMT-5')
	await expect(normal.locator('[data-slot-minute="60"] .calendar-variable-tick')).toHaveText('01:00')
	await expect(normal.locator('[data-slot-minute="120"] .calendar-variable-tick')).toHaveText('02:00')
	await expect(page.locator('.calendar-ruler-tick')).toHaveCount(0)
	await page.locator('.calendar-time-scroll').evaluate(element => { element.scrollTop = 0 })
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	await page.screenshot({animations: 'disabled', path: testInfo.outputPath('calendar-dst-new-york-local-columns.png')})
})

test('calendar half-hour DST day End focuses the last real Lord Howe slot and creates only to midnight', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
	currentUser,
}, testInfo) => {
	await page.setViewportSize({width: 1440, height: 900})
	await updateUserSettings(apiContext, userToken, {
		language: 'en',
		timezone: 'Australia/Lord_Howe',
		week_start: 1,
		frontend_settings: {time_format: '24h'},
	})
	const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
	await createDefaultViews(project.id)
	const loaded = page.waitForResponse(response => isCalendar(response.url())
		&& new URL(response.url()).searchParams.get('timezone') === 'Australia/Lord_Howe')
	await page.goto(`/calendar?view=day&date=2026-10-04&project=${project.id}&zoom=100`)
	const response = await loaded
	expect(response.ok()).toBe(true)
	const calendar = await response.json()
	expect(calendar.timezone).toBe('Australia/Lord_Howe')
	expect(calendar.days).toHaveLength(1)
	const [day] = calendar.days
	expect(day.date).toBe('2026-10-04')
	expect(Date.parse(day.end_at) - Date.parse(day.start_at)).toBe(23.5 * 60 * 60_000)
	const column = page.locator('.calendar-time-column[data-timeline-date="2026-10-04"]')
	await expect(column.locator('.calendar-time-slot')).toHaveCount(24)
	const first = column.locator('[data-slot-minute="0"]')
	const last = column.locator('[data-slot-minute="1380"]')
	await column.locator('[data-slot-minute="540"]').focus()
	await page.keyboard.press('End')
	await expect(last).toBeFocused()
	const firstHeight = await first.evaluate(element => element.getBoundingClientRect().height)
	const lastHeight = await last.evaluate(element => element.getBoundingClientRect().height)
	expect(firstHeight).toBeGreaterThan(0)
	expect(lastHeight).toBeCloseTo(firstHeight / 2, 3)
	await expect(last.locator('.calendar-variable-tick')).toHaveText('23:30 GMT+11')
	await page.screenshot({animations: 'disabled', path: testInfo.outputPath('calendar-dst-lord-howe-last-slot.png')})
	await page.keyboard.press('Enter')
	const dialog = page.getByRole('dialog', {name: labels.en.dialog, exact: true})
	await expect(dialog.getByLabel(labels.en.start, {exact: true})).toHaveValue('2026-10-04T23:30')
	await expect(dialog.getByLabel(labels.en.end, {exact: true})).toHaveValue('2026-10-05T00:00')
	await expect(dialog).toContainText('Australia/Lord_Howe')
	await expectOpaqueCalendarForm(dialog)
	await page.screenshot({animations: 'disabled', path: testInfo.outputPath('calendar-dst-lord-howe-midnight-form.png')})
})

test('calendar failed range load retries real data without loading undated tasks', async ({
	authenticatedPage: page,
	currentUser,
}) => {
	const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
	await TaskFactory.create(1, {
		project_id: project.id,
		created_by_id: currentUser.id,
		title: 'Real calendar retry',
		due_date: '2026-11-03T09:00:00Z',
	})
	let attempts = 0
	await page.route(url => url.pathname === '/api/v2/tasks/calendar', async route => {
		attempts++
		if (attempts <= 4) {
			await route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({detail: 'Calendar fixture unavailable'}),
			})
			return
		}
		await route.continue()
	})
	await page.goto(`/calendar?view=agenda&date=${anchor}`)
	await expect(page.getByRole('alert')).toContainText('This date range could not be loaded')
	attempts = 4
	await page.getByRole('button', {name: 'Retry', exact: true}).click()
	await expect(page.locator('.calendar-agenda')).toContainText('Real calendar retry')
	await expect(page.getByRole('alert')).toHaveCount(0)
})

test('dense calendar keeps zoom local, overlap groups independent and records browser work', async ({
	authenticatedPage: page,
	apiContext,
	userToken,
	currentUser,
}, testInfo) => {
	test.setTimeout(120_000)
	await page.setViewportSize({width: 1440, height: 900})
	await updateUserSettings(apiContext, userToken, {timezone: 'UTC', week_start: 1})
	const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
	const start = (index: number) => Date.UTC(2026, 10, 2 + Math.floor((index - 1) / 80), 6, (index - 1) % 80 * 10)
	await TaskFactory.create(500, {
		project_id: project.id,
		created_by_id: currentUser.id,
		title: (index: number) => `Dense fixture ${index}`,
		start_date: (index: number) => new Date(start(index)).toISOString(),
		end_date: (index: number) => new Date(start(index) + 30 * 60_000).toISOString(),
	})
	const requests: string[] = []
	page.on('request', request => {
		if (isCalendar(request.url())) requests.push(request.url())
	})
	await page.addInitScript(() => {
		const work = {count: 0, duration: 0, max: 0}
		Reflect.set(window, '__calendarWork', work)
		new PerformanceObserver(list => {
			for (const entry of list.getEntries()) {
				work.count++
				work.duration += entry.duration
				work.max = Math.max(work.max, entry.duration)
			}
		}).observe({type: 'longtask', buffered: true})
	})
	await page.goto('/calendar?view=week&date=2026-11-02')
	const representedTasks = () => page.locator('.calendar-time-body').evaluate(element => {
		return element.querySelectorAll('.calendar-event').length
			+ [...element.querySelectorAll<HTMLElement>('[data-overflow-count]')]
				.reduce((total, group) => total + Number(group.dataset.overflowCount), 0)
	})
	await expect.poll(representedTasks).toBe(500)
	expect(await page.locator('.calendar-time-body .calendar-event, .calendar-time-overflow').count()).toBeLessThan(500)
	await page.getByText('Display options', {exact: true}).click()
	const timeline = page.locator('.calendar-time-scroll')
	await timeline.evaluate(element => { element.scrollTop = 640 })
	const before = requests.length
	await page.getByRole('slider', {name: 'Time scale', exact: true}).focus()
	await page.keyboard.press('End')
	await expect(page).toHaveURL(/zoom=250/)
	await page.keyboard.press('Escape')
	await expect(page.getByRole('slider', {name: 'Time scale', exact: true})).not.toBeVisible()
	await expect.poll(() => timeline.evaluate(element => element.scrollTop / 160)).toBeCloseTo(10, 1)
	expect(requests.length).toBe(before)
	const zoomRequests = requests.length - before
	await expect.poll(representedTasks).toBe(500)
	const overflow = page.locator('.calendar-time-overflow[data-overflow-date="2026-11-02"]')
	await expect(overflow).toHaveCount(1)
	const hiddenDayEvents = Number(await overflow.getAttribute('data-overflow-count'))
	const visibleDayEvents = await page.locator(
		'.calendar-time-column[data-timeline-date="2026-11-02"] .calendar-event',
	).count()
	expect(hiddenDayEvents).toBeGreaterThan(0)
	expect(hiddenDayEvents + visibleDayEvents).toBe(80)
	await overflow.click()
	const selected = page.locator('#calendar-selected-day [data-agenda-date="2026-11-02"]')
	await expect(selected.locator('.calendar-event')).toHaveCount(80)
	await expect(selected.locator('.calendar-event-title')).toHaveText(
		Array.from({length: 80}, (_, index) => `Dense fixture ${index + 1}`),
	)
	expect(requests.length, 'Expanding loaded crowded events must not reload the calendar').toBe(before)
	const timelineCards = await page.locator('.calendar-time-body .calendar-event').count()
	const timelineGroups = await page.locator('.calendar-time-overflow').count()
	await page.getByRole('combobox', {name: 'Calendar view', exact: true}).selectOption('month')
	await expect(page.locator('.calendar-month-cell')).toHaveCount(42)
	await page.getByRole('combobox', {name: 'Calendar view', exact: true}).selectOption('agenda')
	await expect(page.locator('.calendar-agenda .calendar-event')).toHaveCount(500)
	const work = await page.evaluate(() => Reflect.get(window, '__calendarWork'))
	const report = JSON.stringify({
		fixtureTasks: 500,
		calendarRequests: requests.length,
		zoomRequests,
		timelineCards,
		timelineGroups,
		longTasks: work,
	})
	await writeFile(testInfo.outputPath('calendar-browser-work.json'), report)
	await testInfo.attach('calendar-browser-work.json', {
		body: report,
		contentType: 'application/json',
	})
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
	await page.screenshot({animations: 'disabled', path: testInfo.outputPath('calendar-dense-agenda.png')})
})

for (const scenario of [
	{width: 1440, language: 'en'},
	{width: 390, language: 'zh-CN'},
	{width: 320, language: 'en'},
] as const) {
	test.describe(`calendar interaction input ${scenario.width}px ${scenario.language}`, () => {
		test.use({hasTouch: scenario.width <= 640})
		test(`calendar selected day ${scenario.width}px ${scenario.language} keeps the month stable and crosses months by keyboard`, async ({
			authenticatedPage: page,
			apiContext,
			userToken,
			currentUser,
		}, testInfo) => {
			await page.setViewportSize({width: scenario.width, height: 900})
			await updateUserSettings(apiContext, userToken, {
				language: scenario.language,
				timezone: 'Asia/Shanghai',
				week_start: 1,
			})
			const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
			const rows = [
				{title: 'Early November fixture', due_date: '2026-11-04T01:00:00Z'},
				{title: 'Selected November fixture', due_date: '2026-11-20T01:00:00Z'},
				{title: 'Selected December fixture', due_date: '2026-12-20T01:00:00Z'},
			]
			await TaskFactory.create(rows.length, {
				project_id: project.id,
				created_by_id: currentUser.id,
				title: (index: number) => rows[index - 1].title,
				due_date: (index: number) => rows[index - 1].due_date,
			})
			const requests: URL[] = []
			page.on('request', request => {
				if (isCalendar(request.url())) requests.push(new URL(request.url()))
			})
			await page.goto(`/calendar?view=month&date=${anchor}&project=${project.id}`)
			await expect(page.locator('.calendar-month-cell')).toHaveCount(42)
			await expect(page.locator('.calendar-month-view')).toContainText('Early November fixture')
			const beforeSelection = requests.length
			await page.locator('[data-calendar-date="2026-11-20"]').click()
			await expect(page).toHaveURL(/selected=2026-11-20/)
			expect(new URL(page.url()).searchParams.get('date')).toBe(anchor)
			await expect(page.locator('.calendar-date-input')).toHaveValue('2026-11-20')
			const selected = page.locator('#calendar-selected-day')
			await expect(selected.locator('[data-agenda-date="2026-11-20"]')).toContainText('Selected November fixture')
			await expect(selected).not.toContainText('Early November fixture')
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
			expect(requests.length, 'Selecting a loaded date must not reload the month').toBe(beforeSelection)
			await page.reload()
			await expect(page.locator('.calendar-date-input')).toHaveValue('2026-11-20')
			await expect(selected).toContainText('Selected November fixture')
			expect(new URL(page.url()).searchParams.get('date')).toBe(anchor)
			await page.locator('[data-calendar-date="2026-11-20"]').focus()
			await page.keyboard.press('PageDown')
			await expect(page.locator('.calendar-date-input')).toHaveValue('2026-12-20')
			await expect(page.locator('[data-calendar-date="2026-12-20"]')).toBeFocused()
			await expect(selected.locator('[data-agenda-date="2026-12-20"]')).toContainText('Selected December fixture')
			await expect(selected).not.toContainText('Selected November fixture')
			expect(requests[requests.length - 1].searchParams.get('from')).toBe('2026-11-30')
			expect(requests[requests.length - 1].searchParams.get('to')).toBe('2027-01-11')
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-selected-${scenario.width}-${scenario.language}.png`)})
		})

		test(`calendar blank time ${scenario.width}px ${scenario.language} creates the clicked quarter hour in the account timezone`, async ({
			authenticatedPage: page,
			apiContext,
			userToken,
			currentUser,
		}, testInfo) => {
			const text = labels[scenario.language]
			await page.setViewportSize({width: scenario.width, height: 900})
			await updateUserSettings(apiContext, userToken, {
				language: scenario.language,
				timezone: 'Asia/Shanghai',
				week_start: 1,
			})
			const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id})
			await createDefaultViews(project.id)
			await page.goto(`/calendar?view=day&date=${anchor}&project=${project.id}&zoom=100`)
			const slot = page.locator(`.calendar-time-slot[data-slot-date="${anchor}"][data-slot-minute="600"]`)
			await slot.scrollIntoViewIfNeeded()
			const bounds = await slot.boundingBox()
			expect(bounds).not.toBeNull()
			if (scenario.width <= 640) {
				// Resolve the touch target after Playwright has made it actionable; an old
				// viewport coordinate can hit the fixed mobile actions while the page scrolls.
				await slot.tap({position: {
					x: bounds!.width / 2,
					y: bounds!.height / 4 + .5,
				}})
			} else {
				await slot.click({position: {
					x: bounds!.width / 2,
					y: bounds!.height / 4 + .5,
				}})
			}
			const dialog = page.getByRole('dialog', {name: text.dialog, exact: true})
			await expect(dialog.getByLabel(text.start, {exact: true})).toHaveValue(`${anchor}T10:15`)
			await expect(dialog.getByLabel(text.end, {exact: true})).toHaveValue(`${anchor}T10:45`)
			await dialog.getByPlaceholder(text.title, {exact: true}).fill('Created from a blank quarter hour')
			await expectOpaqueCalendarForm(dialog)
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-create-form-${scenario.width}-${scenario.language}.png`)})
			const created = page.waitForResponse(response => response.request().method() === 'POST'
				&& new URL(response.url()).pathname === `/api/v2/projects/${project.id}/tasks`)
			await dialog.getByRole('button', {name: text.save, exact: true}).click()
			const response = await created
			expect(response.ok()).toBe(true)
			const stored = await response.json()
			const read = await apiContext.get(`/api/v2/tasks/${stored.id}`, {
				headers: {Authorization: `Bearer ${userToken}`},
			})
			expect(read.ok()).toBe(true)
			const saved = await read.json()
			expect(Date.parse(saved.start_date)).toBe(Date.parse('2026-11-03T02:15:00Z'))
			expect(Date.parse(saved.end_date)).toBe(Date.parse('2026-11-03T02:45:00Z'))
			await expect(page.locator('.task-view')).toBeVisible()
			await page.keyboard.press('Escape')
			await expect(page.locator('.task-view')).not.toBeVisible()
			await page.reload()
			await expect(page.locator('.calendar-time-body .calendar-event')).toContainText('Created from a blank quarter hour')
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			await page.screenshot({animations: 'disabled', path: testInfo.outputPath(`calendar-blank-create-${scenario.width}-${scenario.language}.png`)})
		})
	})
}

for (const scenario of [
	{width: 2048, height: 1070, language: 'zh-CN', mobile: false, maximumTop: 200},
	{width: 1440, height: 900, language: 'en', mobile: false, maximumTop: 220},
	{width: 1280, height: 720, language: 'zh-CN', mobile: false, maximumTop: 260},
	{width: 820, height: 900, language: 'en', mobile: false, maximumTop: undefined},
	{width: 768, height: 900, language: 'zh-CN', mobile: true, maximumTop: undefined},
	{width: 390, height: 844, language: 'zh-CN', mobile: true, maximumTop: 280},
	{width: 320, height: 740, language: 'en', mobile: true, maximumTop: 280},
] as const) {
	test.describe(`calendar toolbar geometry input ${scenario.width}px`, () => {
		test.use({hasTouch: scenario.mobile})
		test(`toolbarGeometry ${scenario.width}px ${scenario.language} reserves the first screen for schedules`, async ({
			authenticatedPage: page,
			apiContext,
			userToken,
			currentUser,
		}, testInfo) => {
			const text = labels[scenario.language]
			const title = scenario.language === 'zh-CN'
				? '跨团队长期研发与个人安排——用于验证日历工具栏在长项目名称下仍然紧凑且可以正常筛选'
				: 'Long-running research and personal planning across multiple teams with a deliberately long project name'
			await page.setViewportSize({width: scenario.width, height: scenario.height})
			await updateUserSettings(apiContext, userToken, {
				language: scenario.language,
				timezone: 'Asia/Shanghai',
				week_start: 1,
				frontend_settings: {time_format: '24h'},
			})
			const [project] = await ProjectFactory.create(1, {owner_id: currentUser.id, title})
			await createDefaultViews(project.id)
			await TaskFactory.create(2, {
				project_id: project.id,
				created_by_id: currentUser.id,
				title: (index: number) => `Toolbar first-screen fixture ${index}`,
				start_date: '2026-11-03T01:00:00Z',
				end_date: '2026-11-03T02:00:00Z',
				priority: (index: number) => index === 1 ? 4 : 1,
			})
			// Keep installation hints and the real app shell present in these viewport measurements.
			await page.goto(`/calendar?date=${anchor}`)
			const view = page.getByRole('combobox', {name: text.view, exact: true})
			await expect(view).toHaveValue(scenario.mobile ? 'agenda' : 'week')
			const content = page.locator(scenario.mobile ? '.calendar-date-panel' : '.calendar-time-scroll')
			await expect(content).toBeVisible()
			await expect(page.locator(scenario.mobile
				? '.calendar-agenda-events [data-task-id="1"]'
				: '.calendar-time-body [data-task-id="1"]')
				.first()).toBeVisible()
			const bounds = await content.boundingBox()
			expect(bounds).not.toBeNull()
			const viewport = await page.evaluate(() => ({
				width: innerWidth,
				height: innerHeight,
				scrollWidth: document.documentElement.scrollWidth,
				scrollY,
			}))
			await testInfo.attach('toolbar-geometry.json', {
				body: JSON.stringify({scenario, content: bounds, viewport}, null, 2),
				contentType: 'application/json',
			})
			await page.screenshot({
				animations: 'disabled',
				path: testInfo.outputPath(`calendar-toolbar-${scenario.width}-${scenario.language}.png`),
			})
			expect(viewport.scrollY, 'The first screen must not rely on prior page scrolling').toBe(0)
			expect(viewport.scrollWidth, 'Long project names must not widen the viewport').toBeLessThanOrEqual(viewport.width)
			if (scenario.maximumTop !== undefined) {
				expect(bounds!.y, 'The calendar toolbar must leave room for actual schedules')
					.toBeLessThanOrEqual(scenario.maximumTop)
			}
			const projectFilter = page.locator('.calendar-project-filter')
			await expect(projectFilter).toHaveCount(1)
			if (!scenario.mobile) {
				await projectFilter.selectOption(String(project.id))
				await expect(projectFilter).toHaveValue(String(project.id))
				const selectedBounds = await projectFilter.boundingBox()
				expect(selectedBounds).not.toBeNull()
				expect(selectedBounds!.x + selectedBounds!.width).toBeLessThanOrEqual(scenario.width)
				const before = await content.evaluate(element => element.getBoundingClientRect().top)
				await page.getByText(text.options, {exact: true}).click()
				await expect(page.getByRole('slider', {name: text.zoom, exact: true})).toBeVisible()
				await expect.poll(() => content.evaluate(element => element.getBoundingClientRect().top))
					.toBeCloseTo(before, 1)
				await page.screenshot({
					animations: 'disabled',
					path: testInfo.outputPath(`calendar-toolbar-options-${scenario.width}-${scenario.language}.png`),
				})
				await page.keyboard.press('Escape')
				await expect(page.getByRole('slider', {name: text.zoom, exact: true})).not.toBeVisible()
				await expect.poll(() => content.evaluate(element => element.getBoundingClientRect().top))
					.toBeCloseTo(before, 1)
				return
			}

			const card = page.locator('.calendar-agenda-events [data-task-id="1"]').first()
			const cardBounds = await card.boundingBox()
			const actionsBounds = await page.locator('.calendar-mobile-actions').boundingBox()
			expect(cardBounds).not.toBeNull()
			expect(actionsBounds).not.toBeNull()
			expect(cardBounds!.y).toBeGreaterThanOrEqual(0)
			expect(cardBounds!.y + cardBounds!.height, 'The first schedule must fit above the fixed quick actions')
				.toBeLessThanOrEqual(Math.min(scenario.height, actionsBounds!.y))
			await expect(page.locator('.calendar-presentation')).not.toBeVisible()
			await expect(projectFilter).not.toBeVisible()
			const filters = page.locator('.calendar-filter-toggle')
			await expect(filters).toHaveAttribute('aria-expanded', 'false')
			const targets = await page.locator('.calendar-command-bar button:visible, .calendar-mobile-actions button:visible')
				.evaluateAll(elements => elements.map(element => ({
					width: element.getBoundingClientRect().width,
					height: element.getBoundingClientRect().height,
				})))
			expect(targets.length).toBeGreaterThan(2)
			for (const target of targets) {
				expect(target.width, 'Mobile calendar buttons need a 44px touch target').toBeGreaterThanOrEqual(44)
				expect(target.height, 'Mobile calendar buttons need a 44px touch target').toBeGreaterThanOrEqual(44)
			}
			if (scenario.width === 390) {
				await view.selectOption('day')
				await ensureCalendarFiltersVisible(page)
				await page.getByRole('button', {name: text.options, exact: true}).click()
				const sheet = page.getByRole('dialog', {name: text.options, exact: true})
				await expect(sheet).toBeVisible()
				await sheet.getByRole('slider', {name: text.zoom, exact: true}).focus()
				await page.keyboard.press('Home')
				await expect(page).toHaveURL(/zoom=25/)
				await page.screenshot({
					animations: 'disabled',
					path: testInfo.outputPath('calendar-toolbar-mobile-display-sheet.png'),
				})
				await page.keyboard.press('Escape')
				await expect(sheet).not.toBeVisible()
				await expect(page.getByRole('slider', {name: text.zoom, exact: true})).not.toBeVisible()
				await expect(view).toHaveValue('day')
				await expect(page.locator('.calendar-date-input')).toHaveValue(anchor)
				await page.getByRole('button', {name: text.options, exact: true}).click()
				await expect(sheet.getByRole('slider', {name: text.zoom, exact: true})).toHaveValue('25')
				await page.keyboard.press('Escape')
				await expect(sheet).not.toBeVisible()
				await filters.click()
				await expect(filters).toHaveAttribute('aria-expanded', 'false')
			}
			await view.selectOption('month')
			await view.selectOption('agenda')
			await filters.click()
			await expect(filters).toHaveAttribute('aria-expanded', 'true')
			await projectFilter.selectOption(String(project.id))
			await page.getByRole('checkbox', {name: text.important, exact: true}).check()
			await page.getByRole('checkbox', {name: text.hideDone, exact: true}).uncheck()
			await filters.click()
			await expect(filters).toHaveAttribute('aria-expanded', 'false')
			await expect(projectFilter).not.toBeVisible()
			await expect(page.locator('.calendar-filter-count')).toHaveText('3')
			for (const phase of ['changed', 'reloaded']) {
				if (phase === 'reloaded') await page.reload()
				await expect(view).toHaveValue('agenda')
				await expect(page.locator('.calendar-date-input')).toHaveValue(anchor)
				await expect(page.locator('.calendar-filter-count')).toHaveText('3')
				await expect(projectFilter).toHaveCount(1)
				const query = new URL(page.url()).searchParams
				if (scenario.width === 390) expect(query.get('zoom')).toBe('25')
				expect(query.get('date')).toBe(anchor)
				expect(query.get('view')).toBe('agenda')
				expect(query.get('project')).toBe(String(project.id))
				expect(query.get('important')).toBe('1')
				expect(query.get('done')).toBe('all')
				await expect(page.locator('.calendar-agenda-events [data-task-id="1"]')).toHaveCount(1)
				await expect(page.locator('.calendar-agenda-events [data-task-id="2"]')).toHaveCount(0)
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
			await page.screenshot({
				animations: 'disabled',
				path: testInfo.outputPath(`calendar-toolbar-filtered-${scenario.width}-${scenario.language}.png`),
			})
		})
	})
}
