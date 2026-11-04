import {readFile} from 'node:fs/promises'
import type {APIRequestContext, Locator, Page, Response} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {login} from '../../support/authenticateUser'
import {updateUserSettings} from '../../support/updateUserSettings'
import {TeamFactory} from '../../factories/team'
import {TeamMemberFactory} from '../../factories/team_member'
import {UserFactory} from '../../factories/user'
import {
	compassStatusFor,
	createCompassEntry,
	createCompassSpace,
	listCompassEntries,
	listCompassSpaces,
	readCompassEntry,
	readCompassSpace,
	updateCompassEntry,
} from './compassApi'

const PIN_HINT = 'Pin an entry to keep it here as a guiding light.'
const INVITE_LEAD = 'Nothing written yet. Start with whichever question speaks to you.'
const TRASH_NOTE = 'Entries in the trash are kept until someone deletes them permanently. They are not included in exports.'

// The path below /api/v2, or null for any other URL.
function apiPath(url: string): string | null {
	const {pathname} = new URL(url)
	const index = pathname.indexOf('/api/v2/')
	return index < 0 ? null : pathname.slice(index + '/api/v2'.length)
}

function isApiCall(response: Response, method: string, path: string): boolean {
	return response.request().method() === method && apiPath(response.url()) === path
}

// The library keeps its whole state in the query; the hash only scrolls it back into view.
function libraryQuery(page: Page): Record<string, string> {
	return Object.fromEntries(new URL(page.url()).searchParams)
}

function library(page: Page): Locator {
	return page.getByRole('region', {name: 'Library', exact: true})
}

function summary(page: Page): Locator {
	return library(page).locator('.compass-library__summary')
}

function rowTitles(page: Page): Locator {
	return library(page).locator('.compass-library__list > li .compass-entry-row__title')
}

function row(page: Page, entryId: number): Locator {
	return library(page).locator('li.compass-entry-row').filter({has: page.locator(`#compass-entry-row-${entryId}`)})
}

function activeFilters(page: Page): Locator {
	return library(page).getByRole('list', {name: 'Active filters'}).getByRole('listitem')
}

// Who can see the space, plus "Read only" for viewers who cannot write.
function eyebrow(page: Page): Locator {
	return page.locator('.compass-hero__eyebrow')
}

function spaceActions(page: Page): Locator {
	return page.getByRole('group', {name: 'Space actions'})
}

// Waits for the first real answer, so "nothing is shown" checks run against loaded rows.
async function openSpace(page: Page, spaceId: number, query = '') {
	await page.goto(`/compass/spaces/${spaceId}${query}`)
	await expect(library(page).locator('.compass-library__results')).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page) {
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
}

// Created in this order, so the default "recently updated" order is the reverse.
async function seedLibrary(request: APIRequestContext, token: string) {
	const space = await createCompassSpace(request, token, {
		title: 'Night garden',
		motto: 'Write it down while it is still true.',
	})
	const promise = await createCompassEntry(request, token, space.id, {
		kind: 'principle',
		title: 'Keep promises small',
		category: 'Work',
		tags: ['craft'],
		content: '<p>Say less, and then do all of it.</p>',
	})
	const pier = await createCompassEntry(request, token, space.id, {
		kind: 'memory',
		title: 'A lantern on the pier',
		subtitle: 'The summer we moved to the coast',
		category: 'Travel',
		tags: ['sea'],
	})
	const shopping = await createCompassEntry(request, token, space.id, {
		kind: 'note',
		title: 'Shopping list',
		content: '<p>Buy a lantern for the balcony.</p>',
	})
	const workshop = await createCompassEntry(request, token, space.id, {
		kind: 'vision',
		title: 'Workshop by the sea',
		category: 'Work',
		tags: ['sea', 'craft'],
	})
	return {space, promise, pier, shopping, workshop}
}

test.describe('Compass library', () => {
	test('the welcome page creates one private space and leads into it', async ({authenticatedPage: page, apiContext, userToken, currentUser}) => {
		await page.goto('/compass')

		const welcome = page.getByRole('region', {name: 'Compass', exact: true})
		await expect(welcome.getByRole('heading', {level: 1, name: 'Compass'})).toBeVisible()
		await expect(welcome.getByRole('heading', {level: 2, name: 'Five kinds of writing'})).toBeVisible()
		const kinds = welcome.locator('.compass-welcome__kinds > li')
		await expect(kinds).toHaveCount(5)
		await expect(kinds.first()).toContainText('Principle')
		await expect(kinds.first()).toContainText('What you hold to, whatever happens.')
		await expect(welcome).toContainText('A personal space is private: other accounts can\'t open it in Astering, admins included.')
		await expect(welcome).toContainText('without end-to-end encryption, so whoever operates the server could access it. Compass content is not sent to Arona automatically.')
		await expect(welcome).toContainText('This creates a private space named “Compass”')
		await expect(welcome.getByRole('link', {name: 'Customize or share with a team…'})).toHaveAttribute('href', /\/compass\/new$/)
		// Nothing exists until the user asks for it.
		expect(await listCompassSpaces(apiContext, userToken)).toEqual([])

		const created = page.waitForResponse(response => isApiCall(response, 'POST', '/compass/spaces'))
		await welcome.getByRole('button', {name: 'Create my private Compass'}).click()
		expect((await created).ok()).toBe(true)
		await expect(page).toHaveURL(/\/compass\/spaces\/\d+$/)
		const spaceId = Number(new URL(page.url()).pathname.split('/').pop())

		const spaces = await listCompassSpaces(apiContext, userToken)
		expect(spaces).toHaveLength(1)
		expect(spaces[0]).toMatchObject({
			id: spaceId,
			title: 'Compass',
			theme: 'aurora',
			team_id: 0,
			owner_id: currentUser.id,
			entry_count: 0,
		})

		await expect(page.getByRole('heading', {level: 1, name: 'Compass'})).toBeVisible()
		await expect(eyebrow(page)).toHaveText('Private')
		await expect(page.locator('.compass-hero__meta')).toContainText('No entries yet')
		await expect(spaceActions(page).getByRole('link', {name: 'Space settings'}))
			.toHaveAttribute('href', new RegExp(`/compass/spaces/${spaceId}/settings$`))
		await expect(spaceActions(page).getByRole('link', {name: 'Write', exact: true}))
			.toHaveAttribute('href', new RegExp(`/compass/spaces/${spaceId}/write$`))
		await expect(page.getByRole('link', {name: 'Write a preface'}))
			.toHaveAttribute('href', new RegExp(`/compass/spaces/${spaceId}/settings$`))
		// An empty space has nothing to pin yet, so it does not ask for guiding lights.
		await expect(page.getByText(PIN_HINT)).toHaveCount(0)

		// The empty library asks questions; each answer starts a blank entry of that kind.
		await expect(library(page).getByText(INVITE_LEAD)).toBeVisible()
		const invitations = {
			principle: 'Write a principle',
			vision: 'Write a vision',
			action: 'Write a plan of action',
			memory: 'Write a memory',
			note: 'Write a note',
		}
		for (const [kind, label] of Object.entries(invitations)) {
			await expect(library(page).getByRole('link', {name: label, exact: true}))
				.toHaveAttribute('href', new RegExp(`/compass/spaces/${spaceId}/write\\?kind=${kind}$`))
		}

		await page.reload()
		await expect(page.getByRole('heading', {level: 1, name: 'Compass'})).toBeVisible()
		await expect(library(page).getByText(INVITE_LEAD)).toBeVisible()

		// Coming back opens the space instead of offering to create another one.
		await page.goto('/compass')
		await expect(page).toHaveURL(new RegExp(`/compass/spaces/${spaceId}$`))
		await expect(page.getByRole('button', {name: 'Create my private Compass'})).toHaveCount(0)
		expect(await listCompassSpaces(apiContext, userToken)).toHaveLength(1)
	})

	test('/compass reopens the last space, otherwise the first private one', async ({authenticatedPage: page, apiContext, userToken, currentUser}) => {
		await TeamFactory.create(1, {
			id: 1,
			name: 'Night Watch',
			created_by_id: currentUser.id,
		})
		await TeamMemberFactory.create(1, {
			team_id: 1,
			user_id: currentUser.id,
			admin: true,
		})
		const personal = await createCompassSpace(apiContext, userToken, {title: 'Private harbour'})
		const shared = await createCompassSpace(apiContext, userToken, {
			title: 'Watch log',
			team_id: 1,
		})
		// The newer team space leads the list, so landing on the private one is a real choice.
		const listed = await listCompassSpaces(apiContext, userToken)
		expect(listed.map(space => space.id)).toEqual([shared.id, personal.id])

		await page.goto('/compass')
		await expect(page).toHaveURL(new RegExp(`/compass/spaces/${personal.id}$`))
		await expect(page.getByRole('heading', {level: 1, name: 'Private harbour'})).toBeVisible()

		await spaceActions(page).getByRole('button', {name: 'Switch space'}).click()
		const menu = page.locator('.compass-switcher__menu')
		await expect(menu.locator('[aria-current="page"]')).toHaveCount(1)
		await expect(menu.locator('[aria-current="page"]')).toContainText('Private harbour')
		await expect(menu.getByRole('link', {name: 'New space…'})).toHaveAttribute('href', /\/compass\/new$/)
		await menu.getByRole('link', {name: /^Watch log/}).click()

		await expect(page).toHaveURL(new RegExp(`/compass/spaces/${shared.id}$`))
		await expect(page.getByRole('heading', {level: 1, name: 'Watch log'})).toBeVisible()
		await expect(eyebrow(page)).toHaveText('Shared with Night Watch')

		await page.goto('/compass')
		await expect(page).toHaveURL(new RegExp(`/compass/spaces/${shared.id}$`))
		await expect(page.getByRole('heading', {level: 1, name: 'Watch log'})).toBeVisible()
	})

	test('search, kind and sort live in the URL and survive a reload', async ({authenticatedPage: page, apiContext, userToken}) => {
		const {space, promise, pier, shopping, workshop} = await seedLibrary(apiContext, userToken)
		await openSpace(page, space.id)

		await expect(summary(page)).toHaveText('4 entries')
		await expect(rowTitles(page)).toHaveText([workshop.title, shopping.title, pier.title, promise.title])
		// Entries exist but none is pinned: writers are told how to get guiding lights.
		await expect(page.getByText(PIN_HINT)).toBeVisible()
		await expect(page.getByRole('heading', {name: 'Guiding lights'})).toHaveCount(0)

		const search = library(page).getByRole('searchbox', {name: 'Search entries'})
		await search.fill('lantern')
		await expect.poll(() => libraryQuery(page)).toEqual({q: 'lantern'})
		expect(new URL(page.url()).hash).toBe('#compass-library')
		await expect(summary(page)).toHaveText('2 entries match “lantern”')
		// One matches in its title, the other only in its body text.
		await expect(rowTitles(page)).toHaveText([shopping.title, pier.title])
		await expect(library(page).locator('mark.compass-highlight')).toHaveText(['lantern', 'lantern'])

		const kinds = library(page).getByRole('group', {name: 'Kind'})
		await expect(kinds.getByRole('button', {name: 'All', exact: true})).toHaveAttribute('aria-pressed', 'true')
		// The kind goes to the server together with the search; the page does not just hide rows it has.
		const filtered = page.waitForResponse(response => {
			const url = new URL(response.url())
			return isApiCall(response, 'GET', `/compass/spaces/${space.id}/entries`) &&
				url.searchParams.get('kind') === 'memory' &&
				url.searchParams.get('q') === 'lantern'
		})
		await kinds.getByRole('button', {name: 'Memories', exact: true}).click()
		expect((await filtered).ok()).toBe(true)
		await expect.poll(() => libraryQuery(page)).toEqual({
			q: 'lantern',
			kind: 'memory',
		})
		await expect(summary(page)).toHaveText('1 entry matches “lantern”')
		await expect(rowTitles(page)).toHaveText([pier.title])
		expect((await listCompassEntries(apiContext, userToken, space.id, {
			q: 'lantern',
			kind: 'memory',
		})).items.map(entry => entry.id)).toEqual([pier.id])

		await page.reload()
		await expect(search).toHaveValue('lantern')
		await expect(kinds.getByRole('button', {name: 'Memories', exact: true})).toHaveAttribute('aria-pressed', 'true')
		await expect(kinds.getByRole('button', {name: 'All', exact: true})).toHaveAttribute('aria-pressed', 'false')
		await expect(summary(page)).toHaveText('1 entry matches “lantern”')
		await expect(rowTitles(page)).toHaveText([pier.title])
		await expect(activeFilters(page)).toHaveText(['Search: “lantern”'])

		// Escape clears only the search; the kind stays.
		await search.press('Escape')
		await expect.poll(() => libraryQuery(page)).toEqual({kind: 'memory'})
		await expect(search).toHaveValue('')
		await expect(summary(page)).toHaveText('1 entry')

		await kinds.getByRole('button', {name: 'All', exact: true}).click()
		await expect.poll(() => libraryQuery(page)).toEqual({})
		await expect(summary(page)).toHaveText('4 entries')

		const sort = library(page).getByRole('combobox', {name: 'Sort', exact: true})
		await sort.selectOption('title')
		await expect.poll(() => libraryQuery(page)).toEqual({sort: 'title'})
		const byTitle = [pier.title, promise.title, shopping.title, workshop.title]
		await expect(rowTitles(page)).toHaveText(byTitle)
		await page.reload()
		await expect(sort).toHaveValue('title')
		await expect(rowTitles(page)).toHaveText(byTitle)

		// Enter searches at once; clearing the filters keeps the chosen order.
		await search.fill('no such words anywhere')
		await search.press('Enter')
		await expect.poll(() => libraryQuery(page)).toEqual({
			q: 'no such words anywhere',
			sort: 'title',
		})
		await expect(library(page).getByText('No entries match.')).toBeVisible()
		await library(page).getByRole('button', {name: 'Clear filters'}).click()
		await expect.poll(() => libraryQuery(page)).toEqual({sort: 'title'})
		await expect(search).toHaveValue('')
		await expect(rowTitles(page)).toHaveText(byTitle)
	})

	test('categories and tags narrow the library and the chips undo it', async ({authenticatedPage: page, apiContext, userToken}) => {
		const {space, promise, pier, shopping, workshop} = await seedLibrary(apiContext, userToken)
		await openSpace(page, space.id)

		const topics = library(page).getByRole('complementary', {name: 'Categories and tags'})
		await expect(topics.getByRole('heading', {level: 3, name: 'Categories'})).toBeVisible()
		await expect(topics.getByRole('heading', {level: 3, name: 'Tags'})).toBeVisible()
		const work = topics.getByRole('button', {name: /^Work\s*2 entries$/})
		const sea = topics.getByRole('button', {name: /^#sea\s*2 entries$/})
		await expect(topics.getByRole('button', {name: /^Travel\s*1 entry$/})).toBeVisible()
		await expect(work).toHaveAttribute('aria-pressed', 'false')

		await work.click()
		await expect.poll(() => libraryQuery(page)).toEqual({category: 'Work'})
		await expect(work).toHaveAttribute('aria-pressed', 'true')
		await expect(rowTitles(page)).toHaveText([workshop.title, promise.title])
		await expect(activeFilters(page)).toHaveText(['Category: Work'])

		await sea.click()
		await expect.poll(() => libraryQuery(page)).toEqual({
			category: 'Work',
			tag: 'sea',
		})
		await expect(rowTitles(page)).toHaveText([workshop.title])
		await expect(activeFilters(page)).toHaveText(['Category: Work', 'Tag: #sea'])
		expect((await listCompassEntries(apiContext, userToken, space.id, {
			category: 'Work',
			tag: 'sea',
		})).items.map(entry => entry.id)).toEqual([workshop.id])

		await page.reload()
		await expect(activeFilters(page)).toHaveText(['Category: Work', 'Tag: #sea'])
		await expect(work).toHaveAttribute('aria-pressed', 'true')
		await expect(sea).toHaveAttribute('aria-pressed', 'true')
		await expect(rowTitles(page)).toHaveText([workshop.title])

		await library(page).getByRole('button', {name: 'Remove filter: Category: Work', exact: true}).click()
		await expect.poll(() => libraryQuery(page)).toEqual({tag: 'sea'})
		await expect(work).toHaveAttribute('aria-pressed', 'false')
		await expect(rowTitles(page)).toHaveText([workshop.title, pier.title])
		await expect(activeFilters(page)).toHaveText(['Tag: #sea'])

		await library(page).getByRole('button', {name: 'Clear all', exact: true}).click()
		await expect.poll(() => libraryQuery(page)).toEqual({})
		await expect(library(page).getByRole('list', {name: 'Active filters'})).toHaveCount(0)
		await expect(rowTitles(page)).toHaveText([workshop.title, shopping.title, pier.title, promise.title])
	})

	test('an out-of-range page falls back to the last one', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Night garden'})
		const first = await createCompassEntry(apiContext, userToken, space.id, {title: 'First thought'})
		const second = await createCompassEntry(apiContext, userToken, space.id, {title: 'Second thought'})

		await page.goto(`/compass/spaces/${space.id}?page=4`)
		await expect.poll(() => libraryQuery(page)).toEqual({})
		await expect(rowTitles(page)).toHaveText([second.title, first.title])
		await expect(summary(page)).toHaveText('2 entries')
		await expect(library(page).locator('.compass-library__pagination')).toHaveCount(0)
	})

	test('while a new filter loads, the previous rows stay and are marked busy', async ({authenticatedPage: page, apiContext, userToken}) => {
		const {space, promise, pier, shopping, workshop} = await seedLibrary(apiContext, userToken)
		await openSpace(page, space.id)
		const results = library(page).locator('.compass-library__results')
		const everything = [workshop.title, shopping.title, pier.title, promise.title]
		await expect(rowTitles(page)).toHaveText(everything)

		let release: () => void = () => undefined
		const held = new Promise<void>(resolve => {
			release = resolve
		})
		await page.route(url => apiPath(url.href) === `/compass/spaces/${space.id}/entries` &&
			url.searchParams.get('kind') === 'vision', async route => {
			await held
			await route.continue().catch(() => {})
		})

		await library(page).getByRole('group', {name: 'Kind'}).getByRole('button', {name: 'Visions', exact: true}).click()
		await expect(results).toHaveAttribute('aria-busy', 'true')
		await expect(results).toHaveClass(/\bis-stale\b/)
		await expect(rowTitles(page)).toHaveText(everything)
		// The old count is not announced as if it belonged to the new filter.
		await expect(summary(page)).toHaveText('4 entries')
		await expect(library(page).getByRole('status').filter({hasText: 'Loading the selected category'})).toBeVisible()
		await expect(page.getByRole('status').filter({hasText: 'Still loading from the server'})).toBeVisible()

		release()
		await expect(rowTitles(page)).toHaveText([workshop.title])
		await expect(results).not.toHaveAttribute('aria-busy', 'true')
		await expect(results).not.toHaveClass(/\bis-stale\b/)
		await expect(summary(page)).toHaveText('1 entry')
		await page.unrouteAll({behavior: 'ignoreErrors'})
	})

	for (const width of [1440, 320]) {
		test(`weak network offline category navigation ${width}px retains content and resumes once online`, async ({authenticatedPage: page, apiContext, userToken}) => {
			await page.setViewportSize({width, height: 850})
			const {space, promise, workshop} = await seedLibrary(apiContext, userToken)
			await openSpace(page, space.id)
			const kinds = library(page).getByRole('group', {name: 'Kind'})
			await kinds.getByRole('button', {name: 'Principles', exact: true}).click()
			await expect(rowTitles(page)).toHaveText([promise.title])
			try {
				await page.context().setOffline(true)
				await kinds.getByRole('button', {name: 'Visions', exact: true}).click()
				await expect(kinds.getByRole('button', {name: 'Visions', exact: true})).toHaveAttribute('aria-pressed', 'true')
				await expect(library(page).getByRole('status').filter({hasText: 'Waiting for a connection'})).toBeVisible()
				await expect(rowTitles(page)).toHaveText([promise.title])
				await expect(page.locator('.compass-hero')).toBeVisible()
				await expectNoHorizontalOverflow(page)
			} finally {
				await page.context().setOffline(false)
			}
			await expect(rowTitles(page)).toHaveText([workshop.title])
			await expect(library(page).locator('.compass-library__results')).toHaveAttribute('aria-busy', 'false')
		})
	}

	test('a failed library read shows an inline error, and Retry recovers', async ({authenticatedPage: page, apiContext, userToken}) => {
		const {space, promise, pier, shopping, workshop} = await seedLibrary(apiContext, userToken)
		await page.route(url => apiPath(url.href) === `/compass/spaces/${space.id}/entries`, route => route.fulfill({
			status: 500,
			json: {message: 'Simulated failure'},
		}))

		await page.goto(`/compass/spaces/${space.id}`)
		// The space itself loaded; only the library failed, and it says so in place.
		await expect(page.getByRole('heading', {level: 1, name: space.title})).toBeVisible()
		const failure = library(page).getByRole('alert')
		await expect(failure).toBeVisible({timeout: 15_000})
		await expect(rowTitles(page)).toHaveCount(0)

		await page.unrouteAll({behavior: 'ignoreErrors'})
		await failure.getByRole('button', {name: 'Retry', exact: true}).click()
		await expect(rowTitles(page)).toHaveText([workshop.title, shopping.title, pier.title, promise.title])
		await expect(library(page).getByRole('alert')).toHaveCount(0)
		await expect(summary(page)).toHaveText('4 entries')
	})

	test('weak network keeps visited categories instant while account refresh runs in the background', async ({authenticatedPage: page, apiContext, userToken}) => {
		const {space, promise, shopping} = await seedLibrary(apiContext, userToken)
		await openSpace(page, space.id)
		const kinds = library(page).getByRole('group', {name: 'Kind'})
		await kinds.getByRole('button', {name: 'Principles', exact: true}).click()
		await expect(rowTitles(page)).toHaveText([promise.title])
		await kinds.getByRole('button', {name: 'Notes', exact: true}).click()
		await expect(rowTitles(page)).toHaveText([shopping.title])

		// No interception: Chromium's real network is throttled, and the existing query cache stays intact.
		const cdp = await page.context().newCDPSession(page)
		const calls: string[] = []
		page.on('request', request => {
			const path = apiPath(request.url())
			if (path && request.method() === 'GET') calls.push(path)
		})
		let userReturned = false
		page.on('response', response => {
			if (isApiCall(response, 'GET', '/user')) userReturned = true
		})
		try {
			await cdp.send('Network.enable')
			await cdp.send('Network.emulateNetworkConditions', {
				offline: false, latency: 1500, downloadThroughput: 100 * 1024, uploadThroughput: 50 * 1024,
			})
			await page.clock.setFixedTime(new Date(Date.now() + 65_000))
			const start = await page.evaluate(() => performance.now())
			await kinds.getByRole('button', {name: 'Principles', exact: true}).click()
			await expect(kinds.getByRole('button', {name: 'Principles', exact: true})).toHaveAttribute('aria-pressed', 'true', {timeout: 1000})
			await expect(rowTitles(page)).toHaveText([promise.title], {timeout: 1000})
			const elapsed = await page.evaluate(() => performance.now()) - start
			expect(elapsed).toBeLessThan(1200)
			expect(userReturned).toBe(false)
			// The category is now stale and refreshes in place; it does not wait for /user before requesting.
			await expect.poll(() => calls.includes(`/compass/spaces/${space.id}/entries`)).toBe(true)
			expect(userReturned).toBe(false)
			await expect.poll(() => userReturned, {timeout: 10_000}).toBe(true)
			expect(calls.filter(path => path === `/compass/spaces/${space.id}`)).toHaveLength(0)
			expect(calls.filter(path => path === `/compass/spaces/${space.id}/topics`)).toHaveLength(0)
			await test.info().attach('weak-network-category-timing', {
				body: JSON.stringify({latencyMs: 1500, categoryFeedbackMs: Math.round(elapsed), calls}, null, 2), contentType: 'application/json',
			})
		} finally {
			await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1})
			await cdp.detach()
		}
	})

	test('weak network cached refresh errors preserve rows and offer an inline retry', async ({authenticatedPage: page, apiContext, userToken}) => {
		const {space, promise, shopping} = await seedLibrary(apiContext, userToken)
		await openSpace(page, space.id)
		const kinds = library(page).getByRole('group', {name: 'Kind'})
		await kinds.getByRole('button', {name: 'Principles', exact: true}).click()
		await expect(rowTitles(page)).toHaveText([promise.title])
		await kinds.getByRole('button', {name: 'Notes', exact: true}).click()
		await expect(rowTitles(page)).toHaveText([shopping.title])
		await page.clock.setFixedTime(new Date(Date.now() + 65_000))
		await page.route(url => apiPath(url.href) === `/compass/spaces/${space.id}/entries` && url.searchParams.get('kind') === 'principle', route => route.fulfill({status: 503, json: {message: 'Temporary outage'}}))
		await kinds.getByRole('button', {name: 'Principles', exact: true}).click()
		const failure = library(page).getByRole('alert')
		await expect(failure).toContainText('Could not update these results', {timeout: 15_000})
		await expect(rowTitles(page)).toHaveText([promise.title])
		await page.unrouteAll({behavior: 'ignoreErrors'})
		await failure.getByRole('button', {name: 'Retry', exact: true}).click()
		await expect(failure).toHaveCount(0)
		await expect(rowTitles(page)).toHaveText([promise.title])
	})

	test('pinned entries lead the space as guiding lights', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Night garden'})
		const north = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'principle',
			title: 'North star',
			subtitle: 'A subtitle the epigraph outranks',
			quote: 'Choose what you would still choose tomorrow.',
			pinned: true,
		})
		const horizon = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'vision',
			title: 'Open horizon',
			subtitle: 'A workshop with the door left open',
			pinned: true,
		})
		const walk = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'action',
			title: 'Walk first',
			content: '<p>Walk for an hour before any big decision.</p>',
			pinned: true,
		})
		// The newest entry, but not pinned: it must still come after the pinned ones.
		const loose = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'note',
			title: 'Loose thought',
		})
		await openSpace(page, space.id)

		await expect(page.locator('.compass-hero__meta')).toContainText('4 entries')
		await expect(page.locator('.compass-hero__meta')).toContainText('3 guiding lights')

		const lights = page.getByRole('region', {name: 'Guiding lights'})
		await expect(lights.getByRole('listitem')).toHaveCount(3)
		await expect(lights.getByRole('link', {name: /^See all/})).toHaveCount(0)
		// Each light speaks with its epigraph first, else its subtitle, else the opening of its text.
		const lines = {
			[north.id]: 'Choose what you would still choose tomorrow.',
			[horizon.id]: 'A workshop with the door left open',
			[walk.id]: 'Walk for an hour before any big decision.',
		}
		for (const entry of [north, horizon, walk]) {
			const light = lights.locator(`a[href$="/compass/entries/${entry.id}"]`)
			await expect(light.locator('.compass-lights__line')).toHaveText(lines[entry.id])
			await expect(light.locator('.compass-lights__name')).toHaveText(entry.title)
		}
		await expect(lights).not.toContainText(loose.title)
		await expect(page.getByText(PIN_HINT)).toHaveCount(0)

		await expect(rowTitles(page)).toHaveText([walk.title, horizon.title, north.title, loose.title])
		await expect(row(page, north.id)).toContainText('Guiding light')
		await expect(row(page, loose.id)).not.toContainText('Guiding light')

		await lights.locator(`a[href$="/compass/entries/${north.id}"]`).click()
		await expect(page).toHaveURL(new RegExp(`/compass/entries/${north.id}$`))
	})

	test('more than six guiding lights link to the full pinned list', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Night garden'})
		for (let i = 1; i <= 7; i++) {
			await createCompassEntry(apiContext, userToken, space.id, {
				title: `Light ${i}`,
				quote: `Line number ${i}`,
				pinned: true,
			})
		}
		await createCompassEntry(apiContext, userToken, space.id, {title: 'Unpinned note'})
		await openSpace(page, space.id)

		const lights = page.getByRole('region', {name: 'Guiding lights'})
		await expect(lights.getByRole('listitem')).toHaveCount(6)
		await lights.getByRole('link', {name: 'See all 7 guiding lights'}).click()

		await expect.poll(() => libraryQuery(page)).toEqual({pinned: '1'})
		expect(new URL(page.url()).hash).toBe('#compass-library')
		await expect(activeFilters(page)).toHaveText(['Guiding lights only'])
		await expect(summary(page)).toHaveText('7 entries')
		await expect(rowTitles(page)).toHaveCount(7)
		await expect(library(page).getByText('Unpinned note')).toHaveCount(0)

		await page.reload()
		await expect(activeFilters(page)).toHaveText(['Guiding lights only'])
		await expect(summary(page)).toHaveText('7 entries')

		await library(page).getByRole('button', {name: 'Remove filter: Guiding lights only', exact: true}).click()
		await expect.poll(() => libraryQuery(page)).toEqual({})
		await expect(summary(page)).toHaveText('8 entries')
		await expect(library(page).getByText('Unpinned note')).toBeVisible()
	})

	test('a long preface opens in full and folds back', async ({authenticatedPage: page, apiContext, userToken}) => {
		const introduction = Array.from({length: 24}, (_, index) => `<p>Paragraph ${index + 1} of the preface, meant to be read slowly.</p>`)
			.join('')
		const space = await createCompassSpace(apiContext, userToken, {
			title: 'Night garden',
			introduction,
		})
		await openSpace(page, space.id)

		const preface = page.getByRole('region', {name: 'Preface'})
		await expect(preface).toContainText('Paragraph 1 of the preface')
		const expand = preface.getByRole('button', {name: 'Read the whole preface'})
		await expect(expand).toHaveAttribute('aria-expanded', 'false')
		const frame = page.locator(`[id="${await expand.getAttribute('aria-controls')}"]`)
		await expect(frame).toContainText('Paragraph 24 of the preface')
		const height = async () => (await frame.boundingBox())!.height
		const folded = await height()

		await expand.click()
		const collapse = preface.getByRole('button', {name: 'Collapse'})
		await expect(collapse).toHaveAttribute('aria-expanded', 'true')
		await expect.poll(height).toBeGreaterThan(folded * 1.5)
		const unfolded = await height()

		await collapse.click()
		await expect(preface.getByRole('button', {name: 'Read the whole preface'})).toHaveAttribute('aria-expanded', 'false')
		await expect.poll(height).toBeLessThan(unfolded / 1.5)
		// There is a preface already, so the owner is not asked to write one.
		await expect(page.getByRole('link', {name: 'Write a preface'})).toHaveCount(0)
	})

	test('the archive and trash restore entries, and only a confirmed delete removes one forever', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Night garden'})
		const shelved = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'memory',
			title: 'Put away for winter',
		})
		const resolution = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'principle',
			title: 'Old resolution',
		})
		const scrap = await createCompassEntry(apiContext, userToken, space.id, {title: 'Draft to drop'})
		await updateCompassEntry(apiContext, userToken, shelved.id, {state: 'archived'})
		await updateCompassEntry(apiContext, userToken, resolution.id, {state: 'trashed'})
		await updateCompassEntry(apiContext, userToken, scrap.id, {state: 'trashed'})

		// Nothing is active, yet the space is not empty: it points to the archive instead of inviting writing.
		await openSpace(page, space.id)
		await expect(library(page).getByText('Everything in this space is archived for now.')).toBeVisible()
		await expect(library(page).getByText(INVITE_LEAD)).toHaveCount(0)
		await library(page).getByRole('button', {name: 'Show the archive'}).click()
		await expect.poll(() => libraryQuery(page)).toEqual({state: 'archived'})
		await expect(summary(page)).toHaveText('1 archived entry')
		await expect(row(page, shelved.id)).toContainText('Archived')
		await expect(row(page, shelved.id).getByRole('button', {name: 'Restore “Put away for winter”'})).toBeVisible()
		// Only entries in the trash can be deleted for good.
		await expect(row(page, shelved.id).getByRole('button', {name: /^Delete permanently/})).toHaveCount(0)

		const show = library(page).getByRole('combobox', {name: 'Show', exact: true})
		await show.selectOption('trashed')
		await expect.poll(() => libraryQuery(page)).toEqual({state: 'trashed'})
		await expect(summary(page)).toHaveText('2 entries in the trash')
		await expect(library(page).getByText(TRASH_NOTE)).toBeVisible()
		await expect(row(page, resolution.id)).toContainText('In the trash')

		const restored = page.waitForResponse(response => isApiCall(response, 'PUT', `/compass/entries/${resolution.id}`))
		await library(page).getByRole('button', {name: 'Restore “Old resolution”', exact: true}).click()
		expect((await restored).ok()).toBe(true)
		await expect(row(page, resolution.id)).toHaveCount(0)
		await expect(summary(page)).toHaveText('1 entry in the trash')
		expect((await readCompassEntry(apiContext, userToken, resolution.id)).state).toBe('active')

		const deleteButton = library(page).getByRole('button', {name: 'Delete permanently: Draft to drop', exact: true})
		const dialog = page.getByRole('dialog', {name: 'Delete permanently', exact: true})
		const understand = dialog.getByRole('checkbox', {name: 'I understand this cannot be undone'})
		const forever = dialog.getByRole('button', {name: 'Delete forever', exact: true})

		// Cancelling keeps the entry, and the next opening asks again.
		await deleteButton.click()
		await expect(dialog).toContainText('Draft to drop')
		await expect(forever).toHaveAttribute('aria-disabled', 'true')
		await understand.check()
		await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()
		await expect(dialog).toBeHidden()
		expect((await readCompassEntry(apiContext, userToken, scrap.id)).state).toBe('trashed')

		await deleteButton.click()
		await expect(understand).not.toBeChecked()
		await expect(forever).toHaveAttribute('aria-disabled', 'true')
		await understand.check()
		await expect(forever).not.toHaveAttribute('aria-disabled', 'true')
		const {revision} = await readCompassEntry(apiContext, userToken, scrap.id)
		const deleted = page.waitForResponse(response => isApiCall(response, 'DELETE', `/compass/entries/${scrap.id}`))
		await forever.click()
		const deleteResponse = await deleted
		expect(deleteResponse.ok()).toBe(true)
		expect(new URL(deleteResponse.url()).searchParams.get('revision')).toBe(String(revision))
		await expect(dialog).toBeHidden()
		await expect(library(page).getByText('The trash is empty.')).toBeVisible()
		expect(await compassStatusFor(apiContext, userToken, `/compass/entries/${scrap.id}`)).toBe(404)

		await page.reload()
		await expect(show).toHaveValue('trashed')
		await expect(library(page).getByText('The trash is empty.')).toBeVisible()

		await show.selectOption('active')
		await expect.poll(() => libraryQuery(page)).toEqual({})
		await expect(rowTitles(page)).toHaveText([resolution.title])
		const remaining = await listCompassEntries(apiContext, userToken, space.id, {state: 'all'})
		expect(remaining.items.map(entry => entry.id).sort((a, b) => a - b))
			.toEqual([shelved.id, resolution.id].sort((a, b) => a - b))
		expect((await listCompassEntries(apiContext, userToken, space.id, {state: 'trashed'})).total).toBe(0)
	})

	test('export saves the library and archive as Markdown, and a cancelled export saves nothing', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken, {
			title: 'Night garden',
			motto: 'Write it down while it is still true.',
		})
		await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'principle',
			title: 'Keep promises small',
			content: '<p>Say less, and then do all of it.</p>',
		})
		const shelved = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'memory',
			title: 'Put away for winter',
		})
		const torn = await createCompassEntry(apiContext, userToken, space.id, {title: 'Torn page'})
		await updateCompassEntry(apiContext, userToken, shelved.id, {state: 'archived'})
		await updateCompassEntry(apiContext, userToken, torn.id, {state: 'trashed'})
		const downloads: string[] = []
		page.on('download', download => downloads.push(download.suggestedFilename()))
		await openSpace(page, space.id)

		// Full entries are read one by one; holding them keeps the first run going until it is cancelled.
		let release: () => void = () => undefined
		const held = new Promise<void>(resolve => {
			release = resolve
		})
		await page.route(url => /\/api\/v2\/compass\/entries\/\d+$/.test(url.pathname), async route => {
			await held
			await route.continue().catch(() => {})
		})

		await spaceActions(page).getByRole('button', {name: 'Export', exact: true}).click()
		const dialog = page.getByRole('dialog', {name: 'Export this space'})
		const status = dialog.locator('.compass-export__status')
		const footer = dialog.locator('.card-footer')
		await dialog.getByRole('button', {name: 'Start export', exact: true}).click()
		// Two entries, not three: the trash is not exported.
		await expect(status).toHaveText('Reading 0 of 2…')
		await footer.getByRole('button', {name: 'Cancel', exact: true}).click()
		await expect(status).toHaveText('Export cancelled. Nothing was saved.')
		await expect(footer.getByRole('button', {name: 'Close', exact: true})).toBeVisible()
		await page.unrouteAll({behavior: 'ignoreErrors'})
		release()

		const downloaded = page.waitForEvent('download')
		await dialog.getByRole('button', {name: 'Export again', exact: true}).click()
		const download = await downloaded
		expect(download.suggestedFilename()).toBe('Night garden.md')
		await expect(status).toHaveText('Saved “Night garden.md” with 2 entries.')
		await expect(dialog.getByRole('alert')).toHaveCount(0)

		const markdown = await readFile((await download.path())!, 'utf8')
		expect(markdown).toMatch(/^# Night garden\n/)
		expect(markdown).toContain('> Write it down while it is still true.')
		expect(markdown).toContain('## Keep promises small')
		expect(markdown).toContain('Say less, and then do all of it.')
		expect(markdown).toContain('## Put away for winter')
		expect(markdown).not.toContain('Torn page')
		expect(downloads).toEqual(['Night garden.md'])
	})

	test('a team member writes in a shared space but leaves settings and permanent deletes to admins', async ({authenticatedPage: page, apiContext, userToken, currentUser}) => {
		const [owner] = await UserFactory.create(1, {id: 2}, false)
		await TeamFactory.create(1, {
			id: 1,
			name: 'Night Watch',
			created_by_id: owner.id,
		})
		await TeamMemberFactory.create(1, {
			team_id: 1,
			user_id: owner.id,
			admin: true,
		})
		await TeamMemberFactory.create(1, {
			team_id: 1,
			user_id: currentUser.id,
			admin: false,
		}, false)
		const {token: ownerToken} = await login(null, apiContext, owner)
		const space = await createCompassSpace(apiContext, ownerToken, {
			title: 'Shared harbour',
			team_id: 1,
		})
		const rules = await createCompassEntry(apiContext, ownerToken, space.id, {
			kind: 'principle',
			title: 'Harbour rules',
		})
		const chart = await createCompassEntry(apiContext, ownerToken, space.id, {
			kind: 'memory',
			title: 'Old chart',
		})
		await updateCompassEntry(apiContext, ownerToken, chart.id, {state: 'trashed'})
		expect((await readCompassSpace(apiContext, userToken, space.id)).max_permission).toBe(1)

		await openSpace(page, space.id)
		await expect(page.getByRole('heading', {level: 1, name: 'Shared harbour'})).toBeVisible()
		// A member writes, so the space is not marked read-only.
		await expect(eyebrow(page)).toHaveText('Shared with Night Watch')
		await expect(spaceActions(page).getByRole('link', {name: 'Write', exact: true}))
			.toHaveAttribute('href', new RegExp(`/compass/spaces/${space.id}/write$`))
		await expect(spaceActions(page).getByRole('button', {name: 'Export', exact: true})).toBeVisible()
		await expect(spaceActions(page).getByRole('link', {name: 'Space settings'})).toHaveCount(0)
		await expect(page.getByRole('link', {name: 'Write a preface'})).toHaveCount(0)
		await expect(rowTitles(page)).toHaveText([rules.title])

		await library(page).getByRole('combobox', {name: 'Show', exact: true}).selectOption('trashed')
		await expect(summary(page)).toHaveText('1 entry in the trash')
		const restore = row(page, chart.id).getByRole('button', {name: 'Restore “Old chart”', exact: true})
		await expect(restore).toBeVisible()
		await expect(row(page, chart.id).getByRole('button', {name: /^Delete permanently/})).toHaveCount(0)

		await restore.click()
		await expect(library(page).getByText('The trash is empty.')).toBeVisible()
		expect((await readCompassEntry(apiContext, ownerToken, chart.id)).state).toBe('active')
	})

	test('another account cannot open a personal space', async ({authenticatedPage: page, apiContext, userToken}) => {
		const [owner] = await UserFactory.create(1, {id: 2}, false)
		const {token: ownerToken} = await login(null, apiContext, owner)
		const space = await createCompassSpace(apiContext, ownerToken, {
			title: 'Owner only',
			motto: 'Not for other eyes.',
		})
		const vow = await createCompassEntry(apiContext, ownerToken, space.id, {
			title: 'Private vow',
			pinned: true,
		})

		for (const path of [
			`/compass/spaces/${space.id}`,
			`/compass/spaces/${space.id}/entries`,
			`/compass/spaces/${space.id}/topics`,
			`/compass/entries/${vow.id}`,
		]) {
			expect([403, 404], path).toContain(await compassStatusFor(apiContext, userToken, path))
		}
		expect(await listCompassSpaces(apiContext, userToken)).toEqual([])

		await page.goto(`/compass/spaces/${space.id}`)
		await expect(page.getByRole('heading', {level: 1, name: 'This space is not available'})).toBeVisible()
		await expect(page.locator('body')).not.toContainText('Owner only')
		await expect(page.locator('body')).not.toContainText('Not for other eyes.')
		await expect(page.locator('body')).not.toContainText('Private vow')
		await expect(library(page)).toHaveCount(0)

		await page.goto('/compass/spaces/999999')
		await expect(page.getByRole('heading', {level: 1, name: 'This space is not available'})).toBeVisible()

		// The owner's space is not offered either: this account has none yet.
		await page.getByRole('link', {name: 'Back to Compass'}).click()
		await expect(page).toHaveURL(/\/compass$/)
		await expect(page.getByRole('button', {name: 'Create my private Compass'})).toBeVisible()
	})

	test('the space and its library fit a 390px phone in light and dark', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
		test.setTimeout(90_000)
		const long = 'Unbrokenwordthatismuchtoolongforanarrowphonescreenandmustwrap'
		const category = 'A category with a long name that has to wrap'
		const tag = 'long-tag-for-small-screens'
		const space = await createCompassSpace(apiContext, userToken, {
			title: 'A space with a rather long name that has to wrap on a phone',
			motto: 'Keep the long view, even on the days when the short one is loud.',
		})
		await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'principle',
			title: `${long} principle`,
			quote: `${long} as an epigraph`,
			category,
			tags: [tag, 'craft', 'sea'],
			pinned: true,
		})
		await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'memory',
			title: 'An ordinary memory',
			subtitle: `With ${long} in its subtitle`,
		})
		const draft = await createCompassEntry(apiContext, userToken, space.id, {title: `${long} draft`})
		await updateCompassEntry(apiContext, userToken, draft.id, {state: 'trashed'})

		await page.setViewportSize({width: 390, height: 844})
		await page.emulateMedia({reducedMotion: 'reduce'})
		for (const theme of ['light', 'dark'] as const) {
			await updateUserSettings(apiContext, userToken, {frontend_settings: {color_schema: theme}})
			await page.emulateMedia({colorScheme: theme})

			await openSpace(page, space.id)
			await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
			await expect(page.getByRole('region', {name: 'Guiding lights'})).toBeVisible()
			await expectNoHorizontalOverflow(page)
			const actions = (await spaceActions(page).boundingBox())!
			expect(actions.x).toBeGreaterThanOrEqual(0)
			expect(actions.x + actions.width).toBeLessThanOrEqual(390)

			// Below 1024px the topics fold into a disclosure above the list instead of a side rail.
			await expect(library(page).getByRole('complementary', {name: 'Categories and tags'})).toHaveCount(0)
			const topics = library(page).locator('details.compass-topics')
			const disclosure = topics.locator('summary')
			await expect(disclosure).toContainText('Categories and tags')
			expect((await topics.boundingBox())!.y).toBeLessThan((await rowTitles(page).first().boundingBox())!.y)
			await disclosure.click()
			await topics.getByRole('button', {name: new RegExp(`^#${tag}\\s*1 entry$`)}).click()
			await expect.poll(() => libraryQuery(page)).toEqual({tag})
			await expect(activeFilters(page)).toHaveText([`Tag: #${tag}`])
			await expect(topics).toHaveAttribute('open', '')
			await expectNoHorizontalOverflow(page)

			await openSpace(page, space.id, `?state=trashed&q=${long}`)
			await expect(row(page, draft.id).getByRole('button', {name: `Restore “${long} draft”`})).toBeVisible()
			await expect(row(page, draft.id).getByRole('button', {name: `Delete permanently: ${long} draft`})).toBeVisible()
			await expect(activeFilters(page)).toHaveText([`Search: “${long}”`])
			await expectNoHorizontalOverflow(page)
			await page.screenshot({
				path: testInfo.outputPath(`library-trash-${theme}-390.png`),
				fullPage: true,
			})
		}
	})
})
