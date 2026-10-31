import {readFile} from 'node:fs/promises'
import type {Page} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {login} from '../../support/authenticateUser'
import {TeamFactory} from '../../factories/team'
import {TeamMemberFactory} from '../../factories/team_member'
import {UserFactory} from '../../factories/user'
import {
	COMPASS_API,
	compassStatusFor,
	createCompassEntry,
	createCompassSpace,
	listCompassEntries,
	listCompassRevisions,
	readCompassEntry,
	updateCompassEntry,
} from './compassApi'

const SENTENCE = 'Slow work keeps its shape when the reasons for it are written down and read again later.'

// Long enough that every section can scroll to the top of a 900px window on its own.
function section(title: string, paragraphs = 8): string {
	const body = Array.from(
		{length: paragraphs},
		(_, index) => `<p>${title}, paragraph ${index + 1}. ${Array(4).fill(SENTENCE).join(' ')}</p>`,
	).join('')
	return `<h2>${title}</h2>${body}`
}

const THREE_SECTIONS = [
	section('Where it starts'),
	section('The long middle'),
	section('What remains'),
].join('')

function authorization(token: string) {
	return {Authorization: `Bearer ${token}`}
}

function isEntryRequest(url: URL | string, entryId: number) {
	return new URL(String(url)).pathname.endsWith(`/api/v2/compass/entries/${entryId}`)
}

async function expectNoHorizontalOverflow(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

function toolbar(page: Page) {
	return page.getByRole('group', {name: 'Entry actions'})
}

function toast(page: Page) {
	return page.locator('.global-notification')
}

async function openMoreActions(page: Page) {
	await toolbar(page).getByRole('button', {name: 'More actions'}).click()
}

function versionList(page: Page) {
	return page.getByRole('region', {name: 'Saved versions'})
}

// The link's name starts with the kind and carries the date, author and size; the number is what identifies it.
function versionLink(page: Page, revision: number) {
	return versionList(page).getByRole('link', {name: new RegExp(`Version ${revision}(?!\\d)`)})
}

function snapshot(page: Page, revision: number) {
	return page.getByRole('region', {name: `Version ${revision}`, exact: true})
}

test.describe('Compass reader', () => {
	test('shows the entry as written, with its place in the library', async ({authenticatedPage: page, apiContext, userToken}) => {
		const errors: string[] = []
		page.on('pageerror', error => errors.push(error.message))
		const space = await createCompassSpace(apiContext, userToken, {title: 'Long-term notes'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'principle',
			title: 'Keep the long view',
			subtitle: 'Notes for slow years',
			quote: 'Plant trees whose shade you will not sit in.',
			category: 'Craft',
			tags: ['patience', 'craft'],
			content: '<h2>First light</h2><p>Begin before you feel ready, and keep the first notes.</p>',
		})

		await page.goto(`/compass/entries/${entry.id}`)

		const title = page.getByRole('heading', {level: 1})
		await expect(title).toHaveText('Keep the long view')
		await expect(page.getByRole('article', {name: 'Keep the long view'})).toBeVisible()
		await expect(page.locator('.compass-reader__subtitle')).toHaveText('Notes for slow years')
		await expect(page.locator('blockquote.compass-reader__epigraph')).toHaveText('Plant trees whose shade you will not sit in.')
		await expect(page.locator('.compass-reader__body')).toContainText('Begin before you feel ready, and keep the first notes.')

		const kicker = page.locator('.compass-reader__kicker')
		await expect(kicker).toContainText('Principle')
		await expect(kicker).not.toContainText('Guiding light')
		await expect(kicker.getByRole('link', {name: 'Craft'})).toHaveAttribute('href', `/compass/spaces/${space.id}?category=Craft`)

		const meta = page.locator('.compass-reader__meta')
		await expect(meta).toContainText('Updated')
		await expect(meta).toContainText('version 1')
		await expect(meta).toContainText(/about \d+ min read/)
		// A personal space has one author; only shared spaces say who saved.
		await expect(meta).not.toContainText(/\bby\b/)

		const tags = page.getByRole('list', {name: 'Tags'})
		await expect(tags.getByRole('link')).toHaveText(['#patience', '#craft'])
		await expect(tags.getByRole('link', {name: '#patience'})).toHaveAttribute('href', `/compass/spaces/${space.id}?tag=patience`)

		// One heading is not worth a table of contents.
		await expect(page.locator('.compass-toc')).toHaveCount(0)
		await expect(page.getByRole('navigation', {name: 'Contents'})).toHaveCount(0)

		const footer = page.locator('.compass-reader__footer')
		await expect(footer).toContainText('Written')
		await expect(footer.getByRole('link', {name: 'Version history'})).toHaveAttribute('href', `/compass/entries/${entry.id}/history`)

		// The owner gets every action; the pin toggle starts released.
		const actions = toolbar(page)
		await expect(actions.getByRole('link', {name: 'Edit', exact: true})).toHaveAttribute('href', `/compass/entries/${entry.id}/edit`)
		await expect(actions.getByRole('link', {name: 'History', exact: true})).toHaveAttribute('href', `/compass/entries/${entry.id}/history`)
		await expect(actions.getByRole('button', {name: 'Guiding light'})).toHaveAttribute('aria-pressed', 'false')
		await expect(actions.getByRole('button', {name: 'Export'})).toHaveAttribute('aria-expanded', 'false')
		await expect(actions.getByRole('button', {name: 'Reading settings'})).toBeVisible()
		await expect(actions.getByRole('button', {name: 'More actions'})).toBeVisible()

		await tags.getByRole('link', {name: '#patience'}).click()
		await expect(page).toHaveURL(new RegExp(`/compass/spaces/${space.id}\\?tag=patience$`))

		await page.goto(`/compass/entries/${entry.id}`)
		const back = page.getByRole('link', {name: 'Back to Long-term notes'})
		await expect(back).toHaveText('Long-term notes')
		await back.click()
		await expect(page).toHaveURL(new RegExp(`/compass/spaces/${space.id}$`))
		expect(errors).toEqual([])
	})

	test('an entry with neither body nor epigraph invites writing', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Unwritten'})

		await page.goto(`/compass/entries/${entry.id}`)
		await expect(page.getByRole('heading', {level: 1})).toHaveText('Unwritten')
		const empty = page.locator('.compass-reader__empty')
		await expect(empty).toContainText('Nothing written here yet.')
		await expect(empty.getByRole('link', {name: 'Start writing'})).toHaveAttribute('href', `/compass/entries/${entry.id}/edit`)
		await expect(page.locator('.compass-reader__meta')).not.toContainText('min read')
		await expect(page.locator('.compass-reader__body')).toHaveCount(0)

		// An epigraph alone is already something to read.
		await updateCompassEntry(apiContext, userToken, entry.id, {quote: 'Begin anywhere.'})
		await page.reload()
		await expect(page.locator('blockquote.compass-reader__epigraph')).toHaveText('Begin anywhere.')
		await expect(page.getByText('Nothing written here yet.')).toHaveCount(0)
		await expect(page.locator('.compass-reader__meta')).toContainText('version 2')
	})

	test('a wide reader gets a contents rail that jumps to a section without touching the URL', async ({authenticatedPage: page, apiContext, userToken}) => {
		await page.setViewportSize({width: 1440, height: 900})
		await page.emulateMedia({reducedMotion: 'reduce'})
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Three movements', content: THREE_SECTIONS})

		await page.goto(`/compass/entries/${entry.id}`)
		await expect(page.getByRole('heading', {level: 1})).toHaveText('Three movements')

		const contents = page.getByRole('navigation', {name: 'Contents'})
		await expect(contents).toBeVisible()
		await expect(page.locator('details.compass-toc')).toHaveCount(0)
		const links = contents.getByRole('link')
		await expect(links).toHaveText(['Where it starts', 'The long middle', 'What remains'])

		const progress = page.locator('.compass-reading-progress')
		await expect(progress).toHaveAttribute('aria-hidden', 'true')
		const progressValue = () => progress.evaluate(element => (element as HTMLElement).style.getPropertyValue('--compass-progress'))
		await expect.poll(progressValue).toBe('0.0000')

		const before = page.url()
		await links.nth(1).click()
		await expect(page.locator('#compass-section-2')).toBeFocused()
		await expect(page.locator('#compass-section-2')).toHaveText('The long middle')
		await expect(page).toHaveURL(before)
		expect(new URL(page.url()).hash).toBe('')
		await expect(links.nth(1)).toHaveAttribute('aria-current', 'location')
		await expect(links.nth(0)).not.toHaveAttribute('aria-current', /.+/)
		await expect(links.nth(2)).not.toHaveAttribute('aria-current', /.+/)
		await expect.poll(async () => Number(await progressValue())).toBeGreaterThan(0)

		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
		await expect.poll(progressValue).toBe('1.0000')
		await expect(links.nth(2)).toHaveAttribute('aria-current', 'location')
	})

	test('a phone folds the contents above the body and nothing overflows', async ({authenticatedPage: page, apiContext, userToken}) => {
		await page.setViewportSize({width: 390, height: 844})
		await page.emulateMedia({reducedMotion: 'reduce'})
		const space = await createCompassSpace(apiContext, userToken, {title: 'A space with a rather long name for a phone'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'memory',
			title: 'A fairly long entry title that has to wrap on a narrow phone screen',
			quote: 'An epigraph that also needs to wrap rather than push the page sideways.',
			category: 'Travels',
			tags: ['a-rather-long-tag-name-without-breaks', 'road'],
			content: [
				THREE_SECTIONS,
				`<p>https://example.com/${'very-long-path-segment-'.repeat(12)}</p>`,
				`<table><tbody><tr>${'<td>wide cell content</td>'.repeat(8)}</tr></tbody></table>`,
			].join(''),
		})

		await page.goto(`/compass/entries/${entry.id}`)
		await expect(page.getByRole('heading', {level: 1})).toContainText('A fairly long entry title')

		const disclosure = page.locator('details.compass-toc')
		const summary = disclosure.locator('summary')
		await expect(summary).toContainText('Contents')
		await expect(summary).toContainText('3 sections')
		const contents = page.getByRole('navigation', {name: 'Contents'})
		await expect(contents).toBeHidden()

		await summary.click()
		await expect(contents).toBeVisible()
		await expect(contents.getByRole('link')).toHaveCount(3)
		const before = page.url()
		await contents.getByRole('link', {name: 'What remains'}).click()
		await expect(page.locator('#compass-section-3')).toBeFocused()
		await expect(page).toHaveURL(before)

		// The labels fold away visually on phones but every tool keeps its name.
		const actions = toolbar(page)
		for (const name of ['Guiding light', 'Export', 'Reading settings', 'More actions']) {
			await expect(actions.getByRole('button', {name})).toBeVisible()
		}
		await expect(actions.getByRole('link', {name: 'Edit', exact: true})).toBeVisible()
		await expect(actions.getByRole('link', {name: 'History', exact: true})).toBeVisible()

		await page.evaluate(() => window.scrollTo(0, 0))
		await expectNoHorizontalOverflow(page)
		const table = page.locator('.compass-reader__body table')
		await table.scrollIntoViewIfNeeded()
		await expectNoHorizontalOverflow(page)

		await openMoreActions(page)
		await expect(page.getByRole('button', {name: 'Move to the trash'})).toBeVisible()
		await expectNoHorizontalOverflow(page)
	})

	test('pinning as a guiding light is stored and survives a reload', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'principle',
			title: 'Tell the truth kindly',
			content: '<p>Even when it costs something.</p>',
		})

		await page.goto(`/compass/entries/${entry.id}`)
		const pin = toolbar(page).getByRole('button', {name: 'Guiding light'})
		await expect(pin).toHaveAttribute('aria-pressed', 'false')
		await pin.click()
		await expect(toast(page)).toContainText('Pinned as a guiding light.')
		await expect(pin).toHaveAttribute('aria-pressed', 'true')
		await expect(page.locator('.compass-reader__kicker')).toContainText('Guiding light')

		const pinned = await readCompassEntry(apiContext, userToken, entry.id)
		expect(pinned).toMatchObject({pinned: true, revision: 2, state: 'active'})
		// The text was not touched by the metadata write.
		expect(pinned.content).toContain('Even when it costs something.')
		expect((await listCompassEntries(apiContext, userToken, space.id, {pinned: 'true'})).items.map(item => item.id)).toEqual([entry.id])

		await page.reload()
		await expect(pin).toHaveAttribute('aria-pressed', 'true')
		await expect(page.locator('.compass-reader__kicker')).toContainText('Guiding light')
		await expect(page.locator('.compass-reader__meta')).toContainText('version 2')

		await pin.click()
		await expect(toast(page)).toContainText('No longer pinned.')
		await expect(pin).toHaveAttribute('aria-pressed', 'false')
		await expect(page.locator('.compass-reader__kicker')).not.toContainText('Guiding light')
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({pinned: false, revision: 3})
	})

	test('archiving keeps the entry readable behind a banner until it returns to the library', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'memory',
			title: 'The first apartment',
			content: '<p>Cold floors and a window full of sky.</p>',
		})

		await page.goto(`/compass/entries/${entry.id}`)
		await openMoreActions(page)
		await page.getByRole('button', {name: 'Archive', exact: true}).click()
		await expect(toast(page)).toContainText('Archived.')

		const banner = page.locator('.compass-state-banner')
		await expect(banner).toContainText('Archived — still readable, not shown in the library')
		await expect(page.locator('.compass-reader__kicker')).toContainText('Archived')
		await expect(page.locator('.compass-reader__body')).toContainText('Cold floors and a window full of sky.')
		// Only library entries can be guiding lights; editing an archived entry is still allowed.
		await expect(toolbar(page).getByRole('button', {name: 'Guiding light'})).toHaveCount(0)
		await expect(toolbar(page).getByRole('link', {name: 'Edit', exact: true})).toBeVisible()

		expect((await readCompassEntry(apiContext, userToken, entry.id)).state).toBe('archived')
		expect((await listCompassEntries(apiContext, userToken, space.id)).items).toEqual([])
		expect((await listCompassEntries(apiContext, userToken, space.id, {state: 'archived'})).items.map(item => item.id)).toEqual([entry.id])

		await page.reload()
		await expect(banner).toContainText('Archived — still readable, not shown in the library')
		await openMoreActions(page)
		await expect(page.getByRole('button', {name: 'Move to the trash'})).toBeVisible()
		await expect(page.getByRole('button', {name: 'Archive', exact: true})).toHaveCount(0)
		await page.keyboard.press('Escape')

		await banner.getByRole('button', {name: 'Return to the library'}).click()
		await expect(toast(page)).toContainText('Back in the library.')
		await expect(page.locator('.compass-state-banner')).toHaveCount(0)
		// The button that was used is gone; focus stays on the page instead of falling to the body.
		await expect(page.getByRole('heading', {level: 1})).toBeFocused()
		await expect(toolbar(page).getByRole('button', {name: 'Guiding light'})).toBeVisible()
		expect((await readCompassEntry(apiContext, userToken, entry.id)).state).toBe('active')
	})

	test('moving to the trash asks first, unpins, and makes the entry read-only until restored', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'vision',
			title: 'A workshop by the sea',
			content: '<p>Wood, salt and quiet mornings.</p>',
			pinned: true,
		})

		await page.goto(`/compass/entries/${entry.id}`)
		await expect(page.locator('.compass-reader__kicker')).toContainText('Guiding light')

		await openMoreActions(page)
		await page.getByRole('button', {name: 'Move to the trash'}).click()
		const confirm = page.getByRole('dialog', {name: 'Move to the trash?'})
		await expect(confirm).toContainText('A workshop by the sea')
		await expect(confirm).toContainText('You can restore it from the trash. It will no longer be pinned.')
		await confirm.getByRole('button', {name: 'Cancel', exact: true}).click()
		await expect(confirm).toBeHidden()
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({state: 'active', pinned: true})

		await openMoreActions(page)
		await page.getByRole('button', {name: 'Move to the trash'}).click()
		await confirm.getByRole('button', {name: 'Do it!', exact: true}).click()
		await expect(confirm).toBeHidden()
		await expect(toast(page)).toContainText('Moved to the trash.')

		const banner = page.locator('.compass-state-banner')
		await expect(banner).toContainText('In the trash — read-only until restored')
		await expect(page.locator('.compass-reader__kicker')).toContainText('In the trash')
		await expect(page.locator('.compass-reader__kicker')).not.toContainText('Guiding light')
		await expect(page.locator('.compass-reader__body')).toContainText('Wood, salt and quiet mornings.')
		await expect(toolbar(page).getByRole('link', {name: 'Edit', exact: true})).toHaveCount(0)
		await expect(toolbar(page).getByRole('button', {name: 'Guiding light'})).toHaveCount(0)

		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({state: 'trashed', pinned: false})
		expect((await listCompassEntries(apiContext, userToken, space.id, {state: 'all'})).items).toEqual([])
		expect((await listCompassEntries(apiContext, userToken, space.id, {state: 'trashed'})).items.map(item => item.id)).toEqual([entry.id])

		await page.reload()
		await expect(banner).toContainText('In the trash — read-only until restored')
		await openMoreActions(page)
		await expect(page.getByRole('button', {name: 'Restore from the trash'})).toBeVisible()
		await expect(page.getByRole('button', {name: 'Move to the trash'})).toHaveCount(0)
		await page.keyboard.press('Escape')

		await banner.getByRole('button', {name: 'Restore', exact: true}).click()
		await expect(toast(page)).toContainText('Back in the library.')
		await expect(page.locator('.compass-state-banner')).toHaveCount(0)
		await expect(toolbar(page).getByRole('link', {name: 'Edit', exact: true})).toBeVisible()
		// Restoring does not bring the pin back; that stays a deliberate choice.
		await expect(toolbar(page).getByRole('button', {name: 'Guiding light'})).toHaveAttribute('aria-pressed', 'false')
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({state: 'active', pinned: false})
	})

	test('deleting forever needs the trash and an explicit tick, then lands in the trash view', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'A plan that did not age well', content: '<p>Gone soon.</p>'})
		await updateCompassEntry(apiContext, userToken, entry.id, {title: 'A plan, revised'})
		await updateCompassEntry(apiContext, userToken, entry.id, {state: 'trashed'})

		await page.goto(`/compass/entries/${entry.id}`)
		const banner = page.locator('.compass-state-banner')
		await expect(banner).toContainText('In the trash — read-only until restored')
		await banner.getByRole('button', {name: 'Delete permanently'}).click()

		const dialog = page.getByRole('dialog', {name: 'Delete permanently'})
		await expect(dialog).toContainText('A plan, revised')
		await expect(dialog).toContainText('This deletes the entry and every saved version of it.')
		const deleteForever = dialog.getByRole('button', {name: 'Delete forever'})
		await expect(deleteForever).toHaveAttribute('aria-disabled', 'true')
		// Without the tick the button refuses, even when clicked anyway.
		await deleteForever.click({force: true})
		await expect(dialog).toBeVisible()
		expect(await compassStatusFor(apiContext, userToken, `/compass/entries/${entry.id}`)).toBe(200)

		await dialog.getByLabel('I understand this cannot be undone').check()
		await expect(deleteForever).not.toHaveAttribute('aria-disabled', 'true')
		const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && isEntryRequest(response.url(), entry.id))
		await deleteForever.click()
		expect((await deleted).ok()).toBe(true)

		await expect(page).toHaveURL(new RegExp(`/compass/spaces/${space.id}\\?state=trashed$`))
		await expect(toast(page)).toContainText('Deleted permanently.')
		expect(await compassStatusFor(apiContext, userToken, `/compass/entries/${entry.id}`)).toBe(404)
		expect(await compassStatusFor(apiContext, userToken, `/compass/entries/${entry.id}/revisions/1`)).toBe(404)
		expect((await listCompassEntries(apiContext, userToken, space.id, {state: 'trashed'})).items).toEqual([])
	})

	test('in a team space members see who saved, can trash, but only team admins delete forever', async ({authenticatedPage: page, apiContext, currentUser, userToken}) => {
		const [owner] = await UserFactory.create(1, {id: 2, username: 'stargazer'}, false)
		await TeamFactory.create(1, {id: 1, name: 'Night watch', created_by_id: owner.id})
		await TeamMemberFactory.create(2, {
			team_id: 1,
			user_id: (index: number) => index === 1 ? owner.id : currentUser.id,
			admin: (index: number) => index === 1,
		})
		const {token: ownerToken} = await login(null, apiContext, owner)
		const space = await createCompassSpace(apiContext, ownerToken, {title: 'Shared sky', team_id: 1})
		const entry = await createCompassEntry(apiContext, ownerToken, space.id, {
			kind: 'action',
			title: 'How we hand over a shift',
			content: '<p>Write down what is still open.</p>',
		})

		await page.goto(`/compass/entries/${entry.id}`)
		await expect(page.getByRole('heading', {level: 1})).toHaveText('How we hand over a shift')
		await expect(page.locator('.compass-reader__meta')).toContainText(/by (stargazer|member #2)/)
		await expect(toolbar(page).getByRole('link', {name: 'Edit', exact: true})).toBeVisible()

		await openMoreActions(page)
		await page.getByRole('button', {name: 'Move to the trash'}).click()
		await page.getByRole('dialog', {name: 'Move to the trash?'}).getByRole('button', {name: 'Do it!', exact: true}).click()
		await expect(toast(page)).toContainText('Moved to the trash.')
		// The member saved the last version now.
		await expect(page.locator('.compass-reader__meta')).toContainText('by you')
		expect((await readCompassEntry(apiContext, ownerToken, entry.id)).state).toBe('trashed')

		const banner = page.locator('.compass-state-banner')
		await expect(banner.getByRole('button', {name: 'Restore', exact: true})).toBeVisible()
		await expect(banner.getByRole('button', {name: 'Delete permanently'})).toHaveCount(0)
		await openMoreActions(page)
		await expect(page.getByRole('button', {name: 'Restore from the trash'})).toBeVisible()
		await expect(page.getByRole('button', {name: 'Delete permanently'})).toHaveCount(0)
		await page.keyboard.press('Escape')

		const trashed = await readCompassEntry(apiContext, userToken, entry.id)
		const refused = await apiContext.delete(`${COMPASS_API}/compass/entries/${entry.id}`, {
			headers: authorization(userToken),
			params: {revision: String(trashed.revision)},
		})
		expect(refused.status()).toBe(403)

		await banner.getByRole('button', {name: 'Restore', exact: true}).click()
		await expect(page.locator('.compass-state-banner')).toHaveCount(0)
		expect((await readCompassEntry(apiContext, ownerToken, entry.id)).state).toBe('active')
	})

	test('someone else\'s personal entry and a missing one look the same', async ({authenticatedPage: page, apiContext, userToken}) => {
		const [stranger] = await UserFactory.create(1, {id: 2}, false)
		const {token: strangerToken} = await login(null, apiContext, stranger)
		const space = await createCompassSpace(apiContext, strangerToken, {title: 'Private sky'})
		const entry = await createCompassEntry(apiContext, strangerToken, space.id, {title: 'Not for other eyes', content: '<p>Secret.</p>'})
		expect([403, 404]).toContain(await compassStatusFor(apiContext, userToken, `/compass/entries/${entry.id}`))

		for (const path of [`/compass/entries/${entry.id}`, '/compass/entries/987654', `/compass/entries/${entry.id}/history`]) {
			await page.goto(path)
			await expect(page.getByRole('heading', {level: 1})).toHaveText('This entry doesn\'t exist or isn\'t shared with you', {timeout: 10_000})
			await expect(page.getByRole('link', {name: 'Go to Compass'})).toHaveAttribute('href', '/compass')
			await expect(page.getByText('Not for other eyes')).toHaveCount(0)
			await expect(page.getByRole('group', {name: 'Entry actions'})).toHaveCount(0)
		}
	})

	test('a failed first load offers Retry and recovers', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Worth the wait', content: '<p>Here at last.</p>'})
		const entryRead = (url: URL) => isEntryRequest(url, entry.id)
		await page.route(entryRead, async route => {
			if (route.request().method() !== 'GET') {
				await route.continue()
				return
			}
			// The real response keeps the CORS headers; only the outcome changes.
			const response = await route.fetch()
			await route.fulfill({
				response,
				status: 500,
				json: {code: 0, message: 'Temporarily unavailable'},
			})
		})

		await page.goto(`/compass/entries/${entry.id}`)
		const failure = page.getByRole('alert').filter({hasText: 'This entry couldn\'t be loaded.'})
		await expect(failure).toBeVisible({timeout: 10_000})
		await expect(page.getByRole('heading', {level: 1})).toHaveText('This entry couldn\'t be loaded.')

		await page.unroute(entryRead)
		await failure.getByRole('button', {name: 'Retry'}).click()
		await expect(page.getByRole('heading', {level: 1})).toHaveText('Worth the wait')
		await expect(page.locator('.compass-reader__body')).toContainText('Here at last.')
		await expect(failure).toHaveCount(0)
	})

	test('a failed background refresh keeps the text on screen and offers Retry', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Still here', content: '<p>The words stay put.</p>'})

		await page.goto(`/compass/entries/${entry.id}`)
		await expect(page.locator('.compass-reader__body')).toContainText('The words stay put.')

		// Reads succeed until the pin is saved; the refresh that follows the save fails.
		let failReads = false
		const entryRead = (url: URL) => isEntryRequest(url, entry.id)
		await page.route(entryRead, async route => {
			const method = route.request().method()
			if (method === 'PUT') {
				const response = await route.fetch()
				failReads = true
				await route.fulfill({response})
				return
			}
			if (method === 'GET' && failReads) {
				const response = await route.fetch()
				await route.fulfill({
					response,
					status: 500,
					json: {code: 0, message: 'Temporarily unavailable'},
				})
				return
			}
			await route.continue()
		})

		const pin = toolbar(page).getByRole('button', {name: 'Guiding light'})
		await pin.click()
		const stale = page.getByRole('status').filter({hasText: 'Couldn\'t refresh this entry. What you see may be out of date.'})
		await expect(stale).toBeVisible({timeout: 10_000})
		await expect(page.getByRole('heading', {level: 1})).toHaveText('Still here')
		await expect(page.locator('.compass-reader__body')).toContainText('The words stay put.')
		await expect(pin).toHaveAttribute('aria-pressed', 'true')

		await page.unroute(entryRead)
		await stale.getByRole('button', {name: 'Retry'}).click()
		await expect(stale).toHaveCount(0)
		await expect(pin).toHaveAttribute('aria-pressed', 'true')
		expect((await readCompassEntry(apiContext, userToken, entry.id)).pinned).toBe(true)
	})

	test('Download Markdown saves front matter and the whole text, and focus returns to Export', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'principle',
			title: 'Keep the long view: notes',
			subtitle: 'Notes for slow years',
			quote: 'Plant trees whose shade you will not sit in.',
			category: 'Craft',
			tags: ['patience', 'craft'],
			content: '<h2>First light</h2><p>Begin before you feel ready.</p><ul><li><p>Walk daily</p></li><li><p>Write it down</p></li></ul>',
		})

		await page.goto(`/compass/entries/${entry.id}`)
		const exportButton = toolbar(page).getByRole('button', {name: 'Export'})
		await exportButton.click()
		await expect(exportButton).toHaveAttribute('aria-expanded', 'true')
		const downloaded = page.waitForEvent('download')
		await page.getByRole('button', {name: 'Download Markdown'}).click()
		const download = await downloaded

		// A colon is not allowed in every file system; the rest of the title is kept.
		expect(download.suggestedFilename()).toBe('Keep the long view notes.md')
		const markdown = (await readFile((await download.path())!)).toString('utf8')
		const [, frontMatter, body] = markdown.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/) ?? []
		expect(frontMatter, markdown).toBeDefined()
		expect(frontMatter).toContain('title: "Keep the long view: notes"')
		expect(frontMatter).toContain('kind: "principle"')
		expect(frontMatter).toContain('category: "Craft"')
		expect(frontMatter).toContain('tags: ["patience", "craft"]')
		expect(frontMatter).toContain('revision: 1')
		expect(frontMatter).toMatch(/^created: "\d{4}-\d{2}-\d{2}/m)
		expect(frontMatter).toMatch(/^updated: "\d{4}-\d{2}-\d{2}/m)
		// Active and unpinned are the defaults and are left out.
		expect(frontMatter).not.toContain('state:')
		expect(frontMatter).not.toContain('pinned:')
		expect(body).toContain([
			'# Keep the long view: notes',
			'*Notes for slow years*',
			'> Plant trees whose shade you will not sit in.',
			'## First light',
			'Begin before you feel ready.',
			'- Walk daily\n- Write it down',
		].join('\n\n'))

		await expect(exportButton).toBeFocused()
		await expect(exportButton).toHaveAttribute('aria-expanded', 'false')
	})

	test('Print hands the article alone to the printer', async ({authenticatedPage: page, apiContext, userToken}) => {
		await page.setViewportSize({width: 1440, height: 900})
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			title: 'For the paper copy',
			quote: 'Ink outlasts screens.',
			content: [section('One', 6), section('Two', 6)].join(''),
		})
		await updateCompassEntry(apiContext, userToken, entry.id, {state: 'archived'})

		await page.goto(`/compass/entries/${entry.id}`)
		const contents = page.getByRole('navigation', {name: 'Contents'})
		const banner = page.locator('.compass-state-banner')
		const historyLink = page.locator('.compass-reader__footer').getByRole('link', {name: 'Version history'})
		await expect(contents).toBeVisible()
		await expect(banner).toBeVisible()
		await expect(historyLink).toBeVisible()

		await page.evaluate(() => {
			const counted = window as Window & {printCalls?: number}
			counted.printCalls = 0
			window.print = () => {
				counted.printCalls = (counted.printCalls ?? 0) + 1
			}
		})
		const exportButton = toolbar(page).getByRole('button', {name: 'Export'})
		await exportButton.click()
		await page.getByRole('button', {name: 'Print', exact: true}).click()
		await expect.poll(() => page.evaluate(() => (window as Window & {printCalls?: number}).printCalls)).toBe(1)
		await expect(exportButton).toBeFocused()

		// At the end of the article the progress bar spans the page, so hiding it is the print style's doing.
		const progress = page.locator('.compass-reading-progress')
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
		await expect(progress).toBeVisible()

		await page.emulateMedia({media: 'print'})
		const article = page.getByRole('article', {name: 'For the paper copy'})
		await expect(article).toBeVisible()
		await expect(article.getByRole('heading', {level: 1})).toBeVisible()
		await expect(page.locator('blockquote.compass-reader__epigraph')).toBeVisible()
		await expect(page.locator('.compass-reader__body')).toContainText('Two, paragraph 6.')
		await expect(page.locator('.compass-reader__dates')).toBeVisible()

		await expect(page.locator('.navbar')).toBeHidden()
		await expect(page.locator('.compass-reader__bar')).toBeHidden()
		await expect(page.getByRole('group', {name: 'Entry actions'})).toBeHidden()
		await expect(contents).toBeHidden()
		await expect(page.locator('.compass-toc')).toBeHidden()
		await expect(progress).toBeHidden()
		await expect(banner).toBeHidden()
		await expect(historyLink).toBeHidden()
		await page.emulateMedia({media: 'screen'})
	})

	test('reading settings change typeface and size and are remembered', async ({authenticatedPage: page, apiContext, userToken}) => {
		const space = await createCompassSpace(apiContext, userToken)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Read it twice', content: '<p>Some text to read.</p>'})

		await page.goto(`/compass/entries/${entry.id}`)
		const body = page.locator('.compass-reader__body')
		await expect(body).toHaveClass(/compass-prose--serif/)
		await expect(body).toHaveClass(/compass-prose--medium/)

		const settings = toolbar(page).getByRole('button', {name: 'Reading settings'})
		await settings.click()
		await expect(settings).toHaveAttribute('aria-expanded', 'true')
		const typeface = page.getByRole('group', {name: 'Typeface'})
		const size = page.getByRole('group', {name: 'Size', exact: true})
		await expect(typeface.getByRole('button', {name: 'Serif'})).toHaveAttribute('aria-pressed', 'true')
		await expect(size.getByRole('button', {name: 'Medium'})).toHaveAttribute('aria-pressed', 'true')

		await typeface.getByRole('button', {name: 'Sans'}).click()
		await size.getByRole('button', {name: 'Large'}).click()
		await expect(typeface.getByRole('button', {name: 'Sans'})).toHaveAttribute('aria-pressed', 'true')
		await expect(typeface.getByRole('button', {name: 'Serif'})).toHaveAttribute('aria-pressed', 'false')
		await expect(size.getByRole('button', {name: 'Large'})).toHaveAttribute('aria-pressed', 'true')
		await expect(body).toHaveClass(/compass-prose--sans/)
		await expect(body).toHaveClass(/compass-prose--large/)
		await expect(body).not.toHaveClass(/compass-prose--serif|compass-prose--medium/)

		await page.reload()
		await expect(body).toHaveClass(/compass-prose--sans/)
		await expect(body).toHaveClass(/compass-prose--large/)
		await settings.click()
		await expect(page.getByRole('group', {name: 'Typeface'}).getByRole('button', {name: 'Sans'})).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByRole('group', {name: 'Size', exact: true}).getByRole('button', {name: 'Large'})).toHaveAttribute('aria-pressed', 'true')

		await page.getByRole('group', {name: 'Size', exact: true}).getByRole('button', {name: 'Small'}).click()
		await expect(body).toHaveClass(/compass-prose--small/)
	})

	test.describe('version history', () => {
		test('lists every saved version and shows what an old one said', async ({authenticatedPage: page, apiContext, userToken}) => {
			await page.setViewportSize({width: 1440, height: 900})
			const space = await createCompassSpace(apiContext, userToken)
			const entry = await createCompassEntry(apiContext, userToken, space.id, {
				kind: 'principle',
				title: 'First draft',
				content: '<p>Original words.</p>',
			})
			await updateCompassEntry(apiContext, userToken, entry.id, {title: 'Second thoughts', content: '<p>Revised words.</p>'})
			await updateCompassEntry(apiContext, userToken, entry.id, {tags: ['revisited']})
			// Pinning saves a version too, with the same text as the one before it.
			await updateCompassEntry(apiContext, userToken, entry.id, {pinned: true})
			expect((await listCompassRevisions(apiContext, userToken, entry.id)).map(item => item.revision)).toEqual([4, 3, 2, 1])

			await page.goto(`/compass/entries/${entry.id}/history`)
			await expect(page.getByRole('heading', {level: 1})).toHaveText('Version history')
			await expect(page.locator('.compass-history__subtitle')).toHaveText('Second thoughts')
			await expect(versionList(page).getByRole('heading', {level: 2})).toHaveText('Saved versions')
			await expect(versionList(page).getByRole('link')).toHaveCount(4)

			// Without ?revision the current version is selected and shown.
			const current = versionLink(page, 4)
			await expect(current).toHaveAccessibleName(/^Principle\s*Version 4/)
			await expect(current).toContainText('Current')
			await expect(current).toHaveAttribute('aria-current', 'true')
			for (const revision of [3, 2, 1]) {
				await expect(versionLink(page, revision)).toHaveAttribute('aria-current', 'false')
				await expect(versionLink(page, revision)).not.toContainText('Current')
			}
			await expect(versionLink(page, 1)).toContainText('Then titled “First draft”')
			await expect(versionLink(page, 2)).not.toContainText('Then titled')
			await expect(versionLink(page, 1)).toContainText('by you')
			await expect(versionLink(page, 1)).toContainText(/\d+(\.\d)? KiB/)

			const latest = snapshot(page, 4)
			await expect(latest).toContainText('This is the current version.')
			await expect(latest.getByRole('button', {name: 'Restore this version'})).toHaveCount(0)

			await versionLink(page, 3).click()
			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}/history\\?revision=3$`))
			await expect(versionLink(page, 3)).toHaveAttribute('aria-current', 'true')
			await expect(versionLink(page, 4)).toHaveAttribute('aria-current', 'false')
			await expect(snapshot(page, 3)).toContainText('Same as the current version.')

			await versionLink(page, 1).click()
			const first = snapshot(page, 1)
			await expect(first).toContainText('Changed compared with the current version: ')
			await expect(first).toContainText(/Title, Body,? and Tags/)
			await expect(first.locator('.compass-snapshot__saved')).toContainText('Saved')
			await expect(first.locator('.compass-snapshot__saved')).toContainText('by you')
			await expect(first).toContainText('Read-only snapshot')
			await expect(first.getByRole('heading', {level: 3})).toHaveText('First draft')
			await expect(first).toContainText('Original words.')
			await expect(first).not.toContainText('Revised words.')
			await expect(first.getByRole('button', {name: 'Restore this version'})).toBeVisible()

			// The selection lives in the URL.
			await page.reload()
			await expect(versionLink(page, 1)).toHaveAttribute('aria-current', 'true')
			await expect(snapshot(page, 1).getByRole('heading', {level: 3})).toHaveText('First draft')

			await page.getByRole('link', {name: 'Back to the entry'}).click()
			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}$`))
			await expect(page.getByRole('heading', {level: 1})).toHaveText('Second thoughts')
		})

		test('restoring an old version saves it as a new version and keeps pin and state', async ({authenticatedPage: page, apiContext, userToken}) => {
			await page.setViewportSize({width: 1440, height: 900})
			const space = await createCompassSpace(apiContext, userToken)
			const entry = await createCompassEntry(apiContext, userToken, space.id, {
				kind: 'vision',
				title: 'A small press',
				category: 'Work',
				tags: ['books'],
				content: '<p>Print what deserves a second reading.</p>',
			})
			await updateCompassEntry(apiContext, userToken, entry.id, {
				title: 'A large press',
				category: 'Business',
				tags: ['scale'],
				content: '<p>Print as much as possible.</p>',
				pinned: true,
			})

			await page.goto(`/compass/entries/${entry.id}/history?revision=1`)
			await snapshot(page, 1).getByRole('button', {name: 'Restore this version'}).click()
			const dialog = page.getByRole('dialog', {name: 'Restore version 1?'})
			await expect(dialog).toContainText('A large press')
			await expect(dialog).toContainText('Restoring copies the text, category, tags and theme of version 1 into a new version 3.')
			await expect(dialog).not.toContainText('unsaved draft')

			const restored = page.waitForResponse(response => response.request().method() === 'POST'
				&& response.url().endsWith(`/compass/entries/${entry.id}/revisions/1/restore`))
			await dialog.getByRole('button', {name: 'Restore version 1', exact: true}).click()
			expect((await restored).status()).toBe(200)
			await expect(dialog).toBeHidden()
			await expect(toast(page)).toContainText('Version 1 restored as a new version.')

			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}/history\\?revision=3$`))
			await expect(versionList(page).getByRole('link')).toHaveCount(3)
			await expect(versionLink(page, 3)).toContainText('Current')
			await expect(versionLink(page, 3)).toHaveAttribute('aria-current', 'true')
			await expect(versionLink(page, 2)).toContainText('Then titled “A large press”')
			await expect(snapshot(page, 3)).toContainText('This is the current version.')
			await expect(page.getByRole('heading', {level: 2, name: 'Version 3', exact: true})).toBeFocused()
			await expect(page.locator('.compass-history__subtitle')).toHaveText('A small press')

			const stored = await readCompassEntry(apiContext, userToken, entry.id)
			expect(stored).toMatchObject({
				revision: 3,
				title: 'A small press',
				category: 'Work',
				tags: ['books'],
				pinned: true,
				state: 'active',
			})
			expect(stored.content).toContain('Print what deserves a second reading.')
			const revisions = await listCompassRevisions(apiContext, userToken, entry.id)
			expect(revisions.map(item => [item.revision, item.title])).toEqual([
				[3, 'A small press'],
				[2, 'A large press'],
				[1, 'A small press'],
			])

			await page.goto(`/compass/entries/${entry.id}`)
			await expect(page.getByRole('heading', {level: 1})).toHaveText('A small press')
			await expect(page.locator('.compass-reader__meta')).toContainText('version 3')
			await expect(toolbar(page).getByRole('button', {name: 'Guiding light'})).toHaveAttribute('aria-pressed', 'true')
		})

		test('a restore against an entry that changed meanwhile stays open until checked again', async ({authenticatedPage: page, apiContext, userToken}) => {
			await page.setViewportSize({width: 1440, height: 900})
			const space = await createCompassSpace(apiContext, userToken)
			const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'First draft', content: '<p>Original words.</p>'})
			await updateCompassEntry(apiContext, userToken, entry.id, {title: 'Second thoughts'})

			await page.goto(`/compass/entries/${entry.id}/history?revision=1`)
			await snapshot(page, 1).getByRole('button', {name: 'Restore this version'}).click()
			const dialog = page.getByRole('dialog', {name: 'Restore version 1?'})
			await expect(dialog).toContainText('into a new version 3.')

			// Another device saves while the question is open.
			await updateCompassEntry(apiContext, userToken, entry.id, {subtitle: 'Edited elsewhere'})

			const conflict = page.waitForResponse(response => response.request().method() === 'POST'
				&& response.url().endsWith(`/compass/entries/${entry.id}/revisions/1/restore`))
			await dialog.getByRole('button', {name: 'Restore version 1', exact: true}).click()
			expect((await conflict).status()).toBe(409)
			await expect(dialog).toBeVisible()
			await expect(dialog.getByRole('alert')).toContainText('This entry changed meanwhile. The latest version is loaded; check it, then restore again.')
			await expect(dialog).toContainText('into a new version 4.')
			await expect(versionLink(page, 3)).toContainText('Current')
			expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({revision: 3, title: 'Second thoughts', subtitle: 'Edited elsewhere'})

			const restored = page.waitForResponse(response => response.request().method() === 'POST'
				&& response.url().endsWith(`/compass/entries/${entry.id}/revisions/1/restore`))
			await dialog.getByRole('button', {name: 'Restore version 1', exact: true}).click()
			expect((await restored).status()).toBe(200)
			await expect(dialog).toBeHidden()
			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}/history\\?revision=4$`))
			// The whole text of version 1 came back, including the subtitle it never had.
			expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({revision: 4, title: 'First draft', subtitle: ''})
		})

		test('the restore dialog warns when this device holds a draft of the entry', async ({authenticatedPage: page, apiContext, userToken}) => {
			await page.setViewportSize({width: 1440, height: 900})
			const space = await createCompassSpace(apiContext, userToken)
			const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'First draft', content: '<p>Original words.</p>'})
			await updateCompassEntry(apiContext, userToken, entry.id, {title: 'Second thoughts'})
			const draftWarning = 'This device has an unsaved draft of this entry.'

			await page.goto(`/compass/entries/${entry.id}/history?revision=1`)
			await snapshot(page, 1).getByRole('button', {name: 'Restore this version'}).click()
			const dialog = page.getByRole('dialog', {name: 'Restore version 1?'})
			await expect(dialog).toContainText('into a new version 3.')
			await expect(dialog).not.toContainText(draftWarning)
			await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()
			await expect(dialog).toBeHidden()

			await page.goto(`/compass/entries/${entry.id}/edit`)
			const title = page.getByLabel('Title', {exact: true})
			await expect(title).toHaveValue('Second thoughts')
			await title.fill('An idea I have not saved')
			await page.locator('.compass-desk__back').click()
			await page.getByRole('dialog', {name: 'Leave without saving?'}).getByRole('button', {name: 'Leave and keep the draft', exact: true}).click()
			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}$`))

			await page.goto(`/compass/entries/${entry.id}/history?revision=1`)
			await snapshot(page, 1).getByRole('button', {name: 'Restore this version'}).click()
			await expect(dialog).toContainText(draftWarning)
			await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()
			await expect(dialog).toBeHidden()
			expect((await readCompassEntry(apiContext, userToken, entry.id)).revision).toBe(2)
		})

		test('a trashed entry offers no restore until it is back from the trash', async ({authenticatedPage: page, apiContext, userToken}) => {
			await page.setViewportSize({width: 1440, height: 900})
			const space = await createCompassSpace(apiContext, userToken)
			const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'First draft', content: '<p>Original words.</p>'})
			await updateCompassEntry(apiContext, userToken, entry.id, {title: 'Second thoughts'})
			await updateCompassEntry(apiContext, userToken, entry.id, {state: 'trashed'})

			await page.goto(`/compass/entries/${entry.id}/history?revision=1`)
			const first = snapshot(page, 1)
			await expect(first.getByRole('heading', {level: 3})).toHaveText('First draft')
			await expect(first).toContainText('Restore the entry from the trash first.')
			await expect(first.getByRole('button', {name: 'Restore this version'})).toHaveCount(0)
			await expect(versionLink(page, 3)).toContainText('In the trash')
			await expect(versionLink(page, 1)).not.toContainText('In the trash')

			await first.getByRole('link', {name: 'Open the entry'}).click()
			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}$`))
			await expect(page.locator('.compass-state-banner')).toContainText('In the trash — read-only until restored')
			expect((await readCompassEntry(apiContext, userToken, entry.id)).revision).toBe(3)
		})

		test('a version that does not exist says so', async ({authenticatedPage: page, apiContext, userToken}) => {
			await page.setViewportSize({width: 1440, height: 900})
			const space = await createCompassSpace(apiContext, userToken)
			const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Only once', content: '<p>Saved a single time.</p>'})

			await page.goto(`/compass/entries/${entry.id}/history?revision=99`)
			const missing = snapshot(page, 99)
			await expect(missing).toContainText('This version doesn\'t exist.', {timeout: 10_000})
			await expect(missing.getByRole('button', {name: 'Restore this version'})).toHaveCount(0)
			await expect(versionLink(page, 1)).toHaveAttribute('aria-current', 'false')
			await expect(versionLink(page, 1)).toContainText('Current')
		})

		test('a phone shows the list or one version at a time, following the URL', async ({authenticatedPage: page, apiContext, userToken}) => {
			await page.setViewportSize({width: 390, height: 844})
			const space = await createCompassSpace(apiContext, userToken)
			const entry = await createCompassEntry(apiContext, userToken, space.id, {
				kind: 'memory',
				title: 'A long walk home that deserves a long enough title to wrap',
				content: `<p>https://example.com/${'very-long-path-segment-'.repeat(12)}</p>`,
			})
			await updateCompassEntry(apiContext, userToken, entry.id, {content: '<p>A shorter second telling.</p>'})

			await page.goto(`/compass/entries/${entry.id}/history`)
			await expect(versionList(page)).toBeVisible()
			await expect(versionList(page).getByRole('link')).toHaveCount(2)
			await expect(page.getByRole('region', {name: /^Version \d+$/})).toHaveCount(0)
			await expect(page.getByRole('link', {name: 'Back to the list'})).toBeHidden()
			await expectNoHorizontalOverflow(page)

			await versionLink(page, 1).click()
			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}/history\\?revision=1$`))
			const first = snapshot(page, 1)
			await expect(first).toBeVisible()
			await expect(first).toContainText('very-long-path-segment-')
			await expect(versionList(page)).toBeHidden()
			await expect(page.getByRole('heading', {level: 2, name: 'Version 1', exact: true})).toBeFocused()
			await expectNoHorizontalOverflow(page)

			await page.getByRole('link', {name: 'Back to the list'}).click()
			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}/history$`))
			await expect(versionList(page)).toBeVisible()
			await expect(page.getByRole('heading', {level: 2, name: 'Saved versions'})).toBeFocused()
			await expect(page.getByRole('region', {name: /^Version \d+$/})).toHaveCount(0)

			await page.goBack()
			await expect(page).toHaveURL(new RegExp(`/compass/entries/${entry.id}/history\\?revision=1$`))
			await expect(snapshot(page, 1)).toBeVisible()
			await expect(versionList(page)).toBeHidden()
		})
	})
})
