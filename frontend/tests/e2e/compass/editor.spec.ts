import type {APIRequestContext, Locator, Page} from '@playwright/test'

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

const SAVE_FAILED = 'Couldn\'t save — your changes are kept on this device'
const DRAFT_KEPT = 'Draft kept on this device'
const SAVED_AT = /^Saved at \S/
const RESTORED = /^Restored your draft/
// helpers/compass/drafts.ts: `tcymc-compass-draft:v1:{account}:{space id}:{entry id | new}`.
const DRAFT_PREFIX = 'tcymc-compass-draft:v1:'

type StoredDraft = {
	entryId: number
	baseRevision: number
	fields: Record<string, unknown>
}

function desk(page: Page) {
	const root = page.locator('form.compass-desk')
	return {
		root,
		title: root.getByLabel('Title', {exact: true}),
		subtitle: root.getByLabel('Subtitle', {exact: true}),
		epigraph: root.getByLabel('Epigraph', {exact: true}),
		body: root.locator('.ProseMirror[contenteditable="true"]'),
		category: root.getByLabel('Category', {exact: true}),
		tagField: root.getByLabel('Tags', {exact: true}),
		tags: root.getByRole('list', {name: 'Tags on this entry'}).getByRole('listitem'),
		status: root.locator('.compass-desk__state [role="status"]'),
		save: root.locator('.compass-desk__save'),
		discard: root.locator('.compass-desk__actions').getByRole('button', {name: 'Discard changes', exact: true}),
		sheet: root.locator('.compass-desk__sheet'),
	}
}

function editHeading(page: Page, title: string) {
	return page.getByRole('heading', {level: 1, name: `Editing “${title}”`, exact: true})
}

function isApiPath(url: string, path: string): boolean {
	return new URL(url).pathname.endsWith(`/api/v2${path}`)
}

function waitForApi(page: Page, method: string, path: string) {
	return page.waitForResponse(response => response.request().method() === method && isApiPath(response.url(), path))
}

// Every matching request the page sends from now on, so "nothing was sent" can be checked afterwards.
function recordRequests(page: Page, method: string, path: string): string[] {
	const seen: string[] = []
	page.on('request', request => {
		if (request.method() === method && isApiPath(request.url(), path)) seen.push(request.url())
	})
	return seen
}

async function draftKeys(page: Page): Promise<string[]> {
	return page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)), DRAFT_PREFIX)
}

async function storedDraft(page: Page, spaceId: number, entryId: number): Promise<StoredDraft | null> {
	return page.evaluate(({prefix, suffix}) => {
		const key = Object.keys(localStorage)
			.find(candidate => candidate.startsWith(prefix) && candidate.endsWith(suffix))
		return key ? JSON.parse(localStorage.getItem(key) ?? 'null') : null
	}, {
		prefix: DRAFT_PREFIX,
		suffix: `:${spaceId}:${entryId}`,
	})
}

async function expectNoHorizontalOverflow(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
}

async function setDetailsOpen(details: Locator, open: boolean) {
	if (await details.evaluate(element => (element as HTMLDetailsElement).open) !== open) {
		await details.locator('summary').click()
	}
	await expect(details).toHaveJSProperty('open', open)
}

// Through the API, the way an admin empties the trash on another device.
async function deleteEntryPermanently(request: APIRequestContext, token: string, entryId: number) {
	const trashed = await updateCompassEntry(request, token, entryId, {state: 'trashed'})
	const response = await request.delete(`${COMPASS_API}/compass/entries/${entryId}`, {
		headers: {Authorization: `Bearer ${token}`},
		params: {revision: trashed.revision},
	})
	expect(response.ok(), await response.text()).toBe(true)
}

// Leaves a draft written against version 1 on this device, saves version 2 elsewhere and reopens the desk.
async function openWithStaleDraft(page: Page, apiContext: APIRequestContext, userToken: string) {
	const space = await createCompassSpace(apiContext, userToken, {title: 'Letters'})
	const entry = await createCompassEntry(apiContext, userToken, space.id, {
		title: 'Letters to myself',
		content: '<p>Dear me,</p>',
	})
	await page.goto(`/compass/entries/${entry.id}/edit`)
	const d = desk(page)
	await expect(d.title).toHaveValue('Letters to myself')
	await d.title.fill('Letters to my future self')
	await expect.poll(() => storedDraft(page, space.id, entry.id)).toMatchObject({
		baseRevision: 1,
		fields: {title: 'Letters to my future self'},
	})

	await updateCompassEntry(apiContext, userToken, entry.id, {quote: 'Written on the phone.'})
	await page.reload()

	await expect(d.root.getByText(
		'You have a draft on this device based on version 1; the entry is now at version 2.',
		{exact: true},
	)).toBeVisible()
	await expect(d.root.getByText('Your draft differs in: Title and Epigraph.', {exact: true})).toBeVisible()
	await expect(d.root.getByText('Choose how to continue. Editing is paused until you do.', {exact: true}))
		.toBeVisible()
	// The latest version is on the sheet, and the sheet waits for the writer's choice.
	await expect(d.title).toHaveValue('Letters to myself')
	await expect(d.epigraph).toHaveValue('Written on the phone.')
	await expect(d.sheet).toHaveJSProperty('inert', true)
	await expect(d.save).toHaveAttribute('aria-disabled', 'true')
	return entry
}

test.describe('Compass editor', () => {
	test('a new entry is written with its details, saved with Ctrl+S, and stays on the same desk', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Field notes'})
		const creates = recordRequests(page, 'POST', `/compass/spaces/${space.id}/entries`)
		await page.goto(`/compass/spaces/${space.id}/write?kind=principle`)

		const d = desk(page)
		await expect(page.getByRole('heading', {level: 1, name: 'New entry in Field notes', exact: true}))
			.toBeAttached()
		await expect(d.root.getByRole('link', {name: 'Back to Field notes', exact: true})).toBeVisible()
		await expect(d.status).toHaveText('Not saved yet')
		await expect(d.discard).toHaveCount(0)
		await expect(d.root.getByRole('complementary', {name: 'Details'})).toBeVisible()
		await expect(d.root.getByRole('radio', {name: 'Principle', exact: true})).toBeChecked()

		// A fresh desk starts at the title; Enter moves on instead of breaking the line.
		await expect(d.title).toBeFocused()
		await d.title.fill('Leave room for slowness')
		await d.title.press('Enter')
		await expect(d.subtitle).toBeFocused()
		await expect(d.title).toHaveValue('Leave room for slowness')
		await d.subtitle.fill('On not filling every hour')
		await d.subtitle.press('Enter')
		await expect(d.epigraph).toBeFocused()
		await d.epigraph.fill('Unhurried is not idle.')
		await d.body.fill('Keep one evening a week without plans.')

		await d.root.getByRole('radio', {name: 'Vision', exact: true}).check()
		await d.category.fill('Rhythm')
		const eyebrow = d.root.locator('.compass-desk__eyebrow')
		await expect(eyebrow).toContainText('Vision')
		await expect(eyebrow).toContainText('Rhythm')

		await d.tagField.fill('rest')
		await d.tagField.press('Enter')
		// A typed comma closes a tag as well.
		await d.tagField.pressSequentially('evenings,')
		await expect(d.tags).toHaveText(['rest', 'evenings'])
		await expect(d.tagField).toHaveValue('')

		// The theme radios are visually hidden; their cards are what gets clicked.
		await d.root.getByRole('group', {name: 'Theme', exact: true})
			.locator('label')
			.filter({hasText: 'Solar'})
			.click()
		await expect(d.root.getByRole('radio', {name: 'Solar', exact: true})).toBeChecked()
		await expect(page.locator('.compass-editor-page')).toHaveAttribute('data-compass-theme', 'solar')
		await d.root.getByRole('checkbox', {name: 'Pin as a guiding light'}).check()
		await expect(d.discard).toBeVisible()
		await expect(d.save).not.toHaveAttribute('aria-disabled', 'true')

		await d.title.focus()
		const created = waitForApi(page, 'POST', `/compass/spaces/${space.id}/entries`)
		await page.keyboard.press('Control+s')
		const response = await created
		expect(response.status()).toBe(201)
		const {id} = await response.json() as {id: number}

		// The desk moves to the entry's own address without remounting: the text and the cursor stay.
		await expect(page).toHaveURL(new RegExp(`/compass/entries/${id}/edit$`))
		await expect(d.title).toHaveValue('Leave room for slowness')
		await expect(d.title).toBeFocused()
		await expect(editHeading(page, 'Leave room for slowness')).toBeAttached()
		await expect(d.status).toHaveText(SAVED_AT)
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
		await expect(d.discard).toHaveCount(0)
		await expect(d.root.getByRole('link', {name: 'Back to the entry', exact: true})).toBeVisible()
		// Pinning an existing entry happens in the reader.
		await expect(d.root.getByRole('checkbox', {name: 'Pin as a guiding light'})).toHaveCount(0)
		await expect.poll(() => draftKeys(page)).toEqual([])

		const stored = await readCompassEntry(apiContext, userToken, id)
		expect(stored).toMatchObject({
			space_id: space.id,
			kind: 'vision',
			title: 'Leave room for slowness',
			subtitle: 'On not filling every hour',
			quote: 'Unhurried is not idle.',
			category: 'Rhythm',
			tags: ['rest', 'evenings'],
			theme: 'solar',
			pinned: true,
			state: 'active',
			revision: 1,
		})
		expect(stored.content).toContain('Keep one evening a week without plans.')
		// Enter in the title and subtitle never submitted the form on its own.
		expect(creates).toHaveLength(1)

		await page.reload()
		await expect(d.title).toHaveValue('Leave room for slowness')
		await expect(d.subtitle).toHaveValue('On not filling every hour')
		await expect(d.epigraph).toHaveValue('Unhurried is not idle.')
		await expect(d.body).toContainText('Keep one evening a week without plans.')
		await expect(d.root.getByRole('radio', {name: 'Vision', exact: true})).toBeChecked()
		await expect(d.category).toHaveValue('Rhythm')
		await expect(d.tags).toHaveText(['rest', 'evenings'])
		await expect(d.root.getByRole('radio', {name: 'Solar', exact: true})).toBeChecked()
		await expect(d.status).toHaveText('Saved')
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
	})

	test('saving an existing entry adds revisions and never rolls back its archive state or pin', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Workshop'})
		const seeded = await createCompassEntry(apiContext, userToken, space.id, {
			kind: 'action',
			title: 'Morning pages',
			content: '<p>Three pages, longhand.</p>',
			tags: ['habit'],
			pinned: true,
		})
		// Archived from the reader; the desk only edits the text.
		const archived = await updateCompassEntry(apiContext, userToken, seeded.id, {state: 'archived'})
		expect(archived).toMatchObject({
			state: 'archived',
			pinned: true,
		})
		const writes = recordRequests(page, 'PUT', `/compass/entries/${seeded.id}`)
		await page.goto(`/compass/entries/${seeded.id}/edit`)

		const d = desk(page)
		await expect(d.title).toHaveValue('Morning pages')
		await expect(editHeading(page, 'Morning pages')).toBeAttached()
		await expect(d.root.locator('.compass-desk__state')).toContainText('Archived')
		await expect(d.status).toHaveText('Saved')
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
		await expect(d.discard).toHaveCount(0)
		await expect(d.root.getByRole('checkbox', {name: 'Pin as a guiding light'})).toHaveCount(0)
		// Nothing changed yet: the shortcut has nothing to send (counted at the end).
		await page.keyboard.press('Control+s')
		await expect(d.status).toHaveText('Saved')

		await d.title.fill('Morning pages, before email')
		await expect(d.status).toHaveText(/^(Unsaved changes|Draft kept on this device)$/)
		await expect(d.discard).toBeVisible()
		await expect(d.save).not.toHaveAttribute('aria-disabled', 'true')
		const first = waitForApi(page, 'PUT', `/compass/entries/${seeded.id}`)
		await d.save.click()
		expect((await first).status()).toBe(200)
		await expect(d.status).toHaveText(SAVED_AT)
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
		await expect(editHeading(page, 'Morning pages, before email')).toBeAttached()
		expect(await readCompassEntry(apiContext, userToken, seeded.id)).toMatchObject({
			kind: 'action',
			title: 'Morning pages, before email',
			tags: ['habit'],
			state: 'archived',
			pinned: true,
			revision: archived.revision + 1,
		})

		// Mod-Enter inside the body saves as well.
		await d.body.fill('Three pages, longhand, before opening the laptop.')
		await expect(d.save).not.toHaveAttribute('aria-disabled', 'true')
		const second = waitForApi(page, 'PUT', `/compass/entries/${seeded.id}`)
		await d.body.press('ControlOrMeta+Enter')
		expect((await second).status()).toBe(200)
		await expect(d.status).toHaveText(SAVED_AT)
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')

		const stored = await readCompassEntry(apiContext, userToken, seeded.id)
		expect(stored).toMatchObject({
			title: 'Morning pages, before email',
			state: 'archived',
			pinned: true,
			revision: archived.revision + 2,
		})
		expect(stored.content).toContain('before opening the laptop.')
		expect(await listCompassRevisions(apiContext, userToken, seeded.id)).toHaveLength(archived.revision + 2)
		expect(writes).toHaveLength(2)

		await page.reload()
		await expect(d.title).toHaveValue('Morning pages, before email')
		await expect(d.body).toContainText('before opening the laptop.')
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toHaveCount(0)
	})

	test('saving without a title or over a limit points at the field instead of sending', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Drafts'})
		const creates = recordRequests(page, 'POST', `/compass/spaces/${space.id}/entries`)
		await page.goto(`/compass/spaces/${space.id}/write`)

		const d = desk(page)
		await d.body.fill('A body without a heading yet.')
		await d.save.click()
		await expect(d.title).toBeFocused()
		await expect(d.title).toHaveAttribute('aria-invalid', 'true')
		await expect(d.title).toHaveAccessibleDescription('Give this entry a title before saving.')
		await expect(d.root.getByText('Give this entry a title before saving.')).toBeVisible()

		// From 80 % of the limit a counter appears; past the limit the overrun is spelled out.
		await d.title.fill('a'.repeat(160))
		await expect(d.root.getByText('160 / 200')).toBeVisible()
		await expect(d.title).not.toHaveAttribute('aria-invalid', 'true')
		await d.title.fill('a'.repeat(203))
		await expect(d.root.getByText('3 characters over the limit of 200.')).toBeVisible()
		await expect(d.root.getByText('203 / 200')).toBeVisible()
		await expect(d.title).toHaveAttribute('aria-invalid', 'true')

		await d.subtitle.focus()
		await page.keyboard.press('Control+s')
		await expect(d.title).toBeFocused()
		expect(creates).toHaveLength(0)

		await d.title.fill('Small things, done slowly')
		await expect(d.title).not.toHaveAttribute('aria-invalid')
		await expect(d.root.locator('.compass-field-note')).toHaveCount(0)
		const created = waitForApi(page, 'POST', `/compass/spaces/${space.id}/entries`)
		await d.save.click()
		const response = await created
		expect(response.status()).toBe(201)
		const {id} = await response.json() as {id: number}
		expect(creates).toHaveLength(1)
		expect(await readCompassEntry(apiContext, userToken, id)).toMatchObject({title: 'Small things, done slowly'})
	})

	test('tags commit on Enter or a comma, refuse duplicates and limits, and are stored in order', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Threads'})
		const many = Array.from({length: 24}, (_, index) => `t${index + 1}`)
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			title: 'Many threads',
			tags: many,
		})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		const d = desk(page)
		const problem = d.root.locator('.compass-tag-input__problem')
		const announcer = d.root.locator('.compass-tag-input [aria-live="polite"]')
		await expect(d.tags).toHaveCount(24)
		await expect(d.root.locator('.compass-tag-input__count')).toHaveText('24 / 24')

		// A 25th tag is refused visibly and stays in the field.
		await d.tagField.fill('one more')
		await d.tagField.press('Enter')
		await expect(problem).toHaveText('An entry can have up to 24 tags.')
		await expect(d.tagField).toHaveAttribute('aria-invalid', 'true')
		await expect(d.tagField).toHaveValue('one more')
		await expect(d.tags).toHaveCount(24)

		await d.root.getByRole('button', {name: 'Remove tag t24', exact: true}).click()
		await expect(d.tags).toHaveCount(23)
		await expect(d.tagField).toBeFocused()
		await expect(problem).toHaveCount(0)

		await d.tagField.fill('x'.repeat(41))
		await d.tagField.press('Enter')
		await expect(problem).toHaveText('A tag can be at most 40 characters.')
		await expect(d.tagField).toHaveAttribute('aria-invalid', 'true')
		await expect(d.tags).toHaveCount(23)

		await d.tagField.fill('Long walks')
		await expect(problem).toHaveCount(0)
		await d.tagField.press('Enter')
		await expect(d.tags.last()).toHaveText('Long walks')

		// A duplicate, in any case, is only announced; the field empties.
		await d.tagField.fill('LONG WALKS')
		await d.tagField.press('Enter')
		await expect(announcer).toHaveText('“LONG WALKS” is already here.')
		await expect(problem).toHaveCount(0)
		await expect(d.tagField).toHaveValue('')
		await expect(d.tags).toHaveCount(24)

		// Backspace in the empty field takes the last tag back.
		await d.tagField.press('Backspace')
		await expect(d.tags).toHaveCount(23)
		await expect(announcer).toHaveText('Removed tag Long walks.')

		// The Chinese enumeration comma closes a tag too.
		await d.tagField.pressSequentially('慢慢来、')
		await expect(d.tags.last()).toHaveText('慢慢来')
		await expect(d.tagField).toHaveValue('')

		const expected = [...many.slice(0, 23), '慢慢来']
		const saved = waitForApi(page, 'PUT', `/compass/entries/${entry.id}`)
		await page.keyboard.press('Control+s')
		expect((await saved).status()).toBe(200)
		expect((await readCompassEntry(apiContext, userToken, entry.id)).tags).toEqual(expected)

		await page.reload()
		await expect(d.tags).toHaveText(expected)
	})

	test('unsaved changes survive a reload, and the restored draft can be discarded', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Notebook'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			title: 'Notes on patience',
			content: '<p>Wait for the second thought.</p>',
		})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		const d = desk(page)
		await expect(d.title).toHaveValue('Notes on patience')
		await d.title.fill('Notes on patience, again')
		await d.body.fill('Wait for the second and the third thought.')
		await expect(d.status).toHaveText(DRAFT_KEPT)
		await expect.poll(() => storedDraft(page, space.id, entry.id)).toMatchObject({
			entryId: entry.id,
			baseRevision: 1,
			fields: {
				title: 'Notes on patience, again',
				content: expect.stringContaining('the third thought.'),
			},
		})

		await page.reload()
		await expect(d.title).toHaveValue('Notes on patience, again')
		await expect(d.body).toContainText('Wait for the second and the third thought.')
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: /^Restored your draft from .+\.$/})).toBeVisible()
		await expect(d.status).toHaveText(DRAFT_KEPT)
		await expect(d.save).not.toHaveAttribute('aria-disabled', 'true')
		// Only this device holds it.
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({
			title: 'Notes on patience',
			revision: 1,
		})

		await d.root.getByRole('button', {name: 'Discard draft', exact: true}).click()
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toHaveCount(0)
		await expect(d.title).toHaveValue('Notes on patience')
		await expect(d.body).toContainText('Wait for the second thought.')
		await expect(d.status).toHaveText('Saved')
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
		await expect.poll(() => draftKeys(page)).toEqual([])

		await page.reload()
		await expect(d.title).toHaveValue('Notes on patience')
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toHaveCount(0)
	})

	test('a draft based on an older version pauses the desk; continuing with it replaces the latest', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const entry = await openWithStaleDraft(page, apiContext, userToken)
		const d = desk(page)
		const writes = recordRequests(page, 'PUT', `/compass/entries/${entry.id}`)
		// Paused: the shortcut sends nothing (counted at the end).
		await page.keyboard.press('Control+s')

		await d.root.getByRole('button', {
			name: 'Continue with my draft (saving replaces the latest version)',
			exact: true,
		}).click()
		await expect(d.sheet).toHaveJSProperty('inert', false)
		await expect(d.title).toHaveValue('Letters to my future self')
		await expect(d.title).toBeFocused()
		await expect(d.epigraph).toHaveValue('')
		await expect(d.save).not.toHaveAttribute('aria-disabled', 'true')

		const saved = waitForApi(page, 'PUT', `/compass/entries/${entry.id}`)
		await page.keyboard.press('Control+s')
		expect((await saved).status()).toBe(200)
		await expect(d.status).toHaveText(SAVED_AT)
		expect(writes).toHaveLength(1)
		// The whole draft replaced version 2, including the epigraph it never had.
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({
			title: 'Letters to my future self',
			quote: '',
			revision: 3,
		})
		await expect.poll(() => draftKeys(page)).toEqual([])
	})

	test('a draft based on an older version can be dropped in favour of the latest', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const entry = await openWithStaleDraft(page, apiContext, userToken)
		const d = desk(page)

		await d.root.getByRole('button', {name: 'Discard my draft', exact: true}).click()
		await expect(d.sheet).toHaveJSProperty('inert', false)
		await expect(d.root.getByText(/^You have a draft on this device/)).toHaveCount(0)
		await expect(d.title).toHaveValue('Letters to myself')
		await expect(d.epigraph).toHaveValue('Written on the phone.')
		await expect(d.status).toHaveText('Saved')
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
		await expect.poll(() => draftKeys(page)).toEqual([])

		await page.reload()
		await expect(d.title).toHaveValue('Letters to myself')
		await expect(d.root.getByText(/^You have a draft on this device/)).toHaveCount(0)
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toHaveCount(0)
		expect((await readCompassEntry(apiContext, userToken, entry.id)).revision).toBe(2)
	})

	test('leaving with unsaved changes asks: keep editing, leave with the draft, or discard', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Margins'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Slow mornings'})
		const editUrl = `/compass/entries/${entry.id}/edit`
		const reader = new RegExp(`/compass/entries/${entry.id}$`)
		await page.goto(editUrl)

		const d = desk(page)
		const back = d.root.getByRole('link', {name: 'Back to the entry', exact: true})
		const dialog = page.getByRole('dialog', {name: 'Leave without saving?'})
		const keepEditing = dialog.getByRole('button', {name: 'Keep editing', exact: true})
		await expect(d.title).toHaveValue('Slow mornings')
		await d.title.fill('Slow mornings, kept')

		await back.click()
		await expect(dialog).toBeVisible()
		await expect(dialog.getByRole('button', {
			name: /^(Discard changes and leave|Leave and keep the draft|Keep editing)$/,
		})).toHaveText(['Discard changes and leave', 'Leave and keep the draft', 'Keep editing'])
		// The safe choice has the focus.
		await expect(keepEditing).toBeFocused()
		await keepEditing.click()
		await expect(dialog).toBeHidden()
		await expect(page).toHaveURL(new RegExp(`${editUrl}$`))
		await expect(d.title).toHaveValue('Slow mornings, kept')

		await back.click()
		await dialog.getByRole('button', {name: 'Leave and keep the draft', exact: true}).click()
		await expect(page).toHaveURL(reader)
		expect(await storedDraft(page, space.id, entry.id)).toMatchObject({fields: {title: 'Slow mornings, kept'}})
		expect((await readCompassEntry(apiContext, userToken, entry.id)).title).toBe('Slow mornings')

		await page.goto(editUrl)
		await expect(d.title).toHaveValue('Slow mornings, kept')
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toBeVisible()

		await back.click()
		await dialog.getByRole('button', {name: 'Discard changes and leave', exact: true}).click()
		await expect(page).toHaveURL(reader)
		await expect.poll(() => draftKeys(page)).toEqual([])

		await page.goto(editUrl)
		await expect(d.title).toHaveValue('Slow mornings')
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toHaveCount(0)
		// Nothing unsaved: leaving does not ask.
		await back.click()
		await expect(page).toHaveURL(reader)
		await expect(dialog).toHaveCount(0)
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({
			title: 'Slow mornings',
			revision: 1,
		})
	})

	test('“Discard changes” asks first, then returns to the saved version', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Hours'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			title: 'Quiet hours',
			subtitle: 'Nine to eleven',
		})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		const d = desk(page)
		const dialog = page.getByRole('dialog', {name: 'Discard your changes?'})
		const keepEditing = dialog.getByRole('button', {name: 'Keep editing', exact: true})
		await expect(d.subtitle).toHaveValue('Nine to eleven')
		await d.subtitle.fill('Nine to noon')

		await d.discard.click()
		await expect(dialog).toContainText('Your unsaved changes and their draft on this device will be removed.')
		await expect(keepEditing).toBeFocused()
		await keepEditing.click()
		await expect(dialog).toBeHidden()
		await expect(d.subtitle).toHaveValue('Nine to noon')

		await d.discard.click()
		await dialog.getByRole('button', {name: 'Discard changes', exact: true}).click()
		await expect(dialog).toBeHidden()
		await expect(d.subtitle).toHaveValue('Nine to eleven')
		await expect(d.title).toBeFocused()
		await expect(d.discard).toHaveCount(0)
		await expect(d.status).toHaveText('Saved')
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
		await expect.poll(() => draftKeys(page)).toEqual([])
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({
			subtitle: 'Nine to eleven',
			revision: 1,
		})

		await page.reload()
		await expect(d.subtitle).toHaveValue('Nine to eleven')
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toHaveCount(0)
	})

	test('a newer version saved elsewhere opens the conflict panel; “Keep my version” overwrites it', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Reviews'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			title: 'Evening review',
			subtitle: 'Three questions',
			content: '<p>What went well?</p>',
		})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		const d = desk(page)
		await expect(d.title).toHaveValue('Evening review')
		await d.title.fill('Evening review, in my words')
		// Another tab of the same account saves version 2 meanwhile.
		await updateCompassEntry(apiContext, userToken, entry.id, {subtitle: 'Four questions, from the phone'})

		const refused = waitForApi(page, 'PUT', `/compass/entries/${entry.id}`)
		await d.save.click()
		expect((await refused).status()).toBe(409)

		const panel = d.root.locator('.compass-conflict')
		const latest = d.root.getByRole('region', {name: 'Latest saved version'})
		await expect(panel.getByRole('alert'))
			.toContainText('You saved a newer version elsewhere, perhaps in another tab (version 2, ')
		await expect(panel).toContainText('It differs from your text in: Title and Subtitle.')
		await expect(latest).toContainText('Four questions, from the phone')
		await expect(latest).toContainText('What went well?')
		await expect(latest).toHaveAttribute('tabindex', '0')
		await expect(d.title).toHaveValue('Evening review, in my words')
		await expect(d.status).toHaveText(SAVE_FAILED)
		await expect.poll(() => storedDraft(page, space.id, entry.id)).toMatchObject({
			fields: {title: 'Evening review, in my words'},
		})

		await panel.getByRole('button', {name: 'Keep my version', exact: true}).click()
		await expect(latest).toHaveCount(0)
		await expect(d.save).toBeFocused()
		const saved = waitForApi(page, 'PUT', `/compass/entries/${entry.id}`)
		await page.keyboard.press('Control+s')
		expect((await saved).status()).toBe(200)
		await expect(d.status).toHaveText(SAVED_AT)
		// The whole desk wins, including the subtitle it never touched.
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({
			title: 'Evening review, in my words',
			subtitle: 'Three questions',
			revision: 3,
		})
		await expect.poll(() => draftKeys(page)).toEqual([])

		await page.reload()
		await expect(d.title).toHaveValue('Evening review, in my words')
		await expect(d.subtitle).toHaveValue('Three questions')
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toHaveCount(0)
	})

	test('a teammate’s newer version names them; “Use the latest version” replaces the desk', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
		currentUser,
	}) => {
		const [teammate] = await UserFactory.create(1, {id: 2}, false)
		await TeamFactory.create(1, {
			id: 1,
			name: 'Studio',
			created_by_id: currentUser.id,
		})
		await TeamMemberFactory.create(2, {
			team_id: 1,
			user_id: (index: number) => [currentUser.id, teammate.id][index - 1],
			admin: (index: number) => index === 1,
		})
		const {token: teammateToken} = await login(null, apiContext, teammate)
		const space = await createCompassSpace(apiContext, userToken, {
			title: 'Studio compass',
			team_id: 1,
		})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {
			title: 'How we review work',
			content: '<p>Weekly, in person.</p>',
		})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		const d = desk(page)
		await expect(d.title).toHaveValue('How we review work')
		await d.title.fill('How I would review work')
		await updateCompassEntry(apiContext, teammateToken, entry.id, {
			title: 'How we review work together',
			content: '<p>Weekly, in person, with notes.</p>',
		})

		const refused = waitForApi(page, 'PUT', `/compass/entries/${entry.id}`)
		await d.save.click()
		expect((await refused).status()).toBe(409)

		const panel = d.root.locator('.compass-conflict')
		const latest = d.root.getByRole('region', {name: 'Latest saved version'})
		await expect(panel.getByRole('alert')).toContainText('Someone saved a newer version (version 2, ')
		await expect(panel.getByRole('alert')).toContainText(`by ${teammate.username}).`)
		await expect(panel).toContainText('It differs from your text in: Title and Body.')
		await expect(latest).toContainText('How we review work together')
		await expect(latest).toContainText('Weekly, in person, with notes.')
		await expect(d.title).toHaveValue('How I would review work')

		await panel.getByRole('button', {name: 'Use the latest version', exact: true}).click()
		await expect(latest).toHaveCount(0)
		await expect(d.title).toHaveValue('How we review work together')
		await expect(d.title).toBeFocused()
		await expect(d.body).toContainText('Weekly, in person, with notes.')
		await expect(d.status).toHaveText('Saved')
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
		await expect.poll(() => draftKeys(page)).toEqual([])
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({
			title: 'How we review work together',
			revision: 2,
		})

		await page.reload()
		await expect(d.title).toHaveValue('How we review work together')
		await expect(d.root.locator('.compass-desk__notice > p').filter({hasText: RESTORED})).toHaveCount(0)
	})

	test('a save that cannot reach the server keeps the text on this device and succeeds later', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Travel'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Notes from the road'})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		const d = desk(page)
		await expect(d.title).toHaveValue('Notes from the road')
		await d.title.fill('Notes from the road, between stations')

		await page.context().setOffline(true)
		await page.keyboard.press('Control+s')
		const problem = d.root.getByText(
			'Couldn\'t reach the server. Your changes are kept on this device; save again when you\'re back online.',
			{exact: true},
		)
		await expect(problem).toBeVisible()
		await expect(problem).toHaveAttribute('role', 'alert')
		await expect(d.status).toHaveText(SAVE_FAILED)
		await expect(d.title).toHaveValue('Notes from the road, between stations')
		await expect(d.save).not.toHaveAttribute('aria-disabled', 'true')
		await expect.poll(() => storedDraft(page, space.id, entry.id)).toMatchObject({
			baseRevision: 1,
			fields: {title: 'Notes from the road, between stations'},
		})

		await page.context().setOffline(false)
		const saved = waitForApi(page, 'PUT', `/compass/entries/${entry.id}`)
		await d.save.click()
		expect((await saved).status()).toBe(200)
		await expect(problem).toHaveCount(0)
		await expect(d.status).toHaveText(SAVED_AT)
		await expect.poll(() => draftKeys(page)).toEqual([])
		expect(await readCompassEntry(apiContext, userToken, entry.id)).toMatchObject({
			title: 'Notes from the road, between stations',
			revision: 2,
		})
	})

	test('when the entry was deleted permanently meanwhile, the text can be saved as a new entry', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Storms'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Before the storm'})
		// A later entry, so the new one can never reuse the deleted entry's id.
		const neighbour = await createCompassEntry(apiContext, userToken, space.id, {title: 'Still here'})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		const d = desk(page)
		await expect(d.title).toHaveValue('Before the storm')
		await d.title.fill('After the storm')
		await d.body.fill('The text outlived its entry.')
		await deleteEntryPermanently(apiContext, userToken, entry.id)

		const refused = waitForApi(page, 'PUT', `/compass/entries/${entry.id}`)
		await d.save.click()
		expect((await refused).status()).toBe(404)
		const problem = d.root.getByText('This entry was deleted permanently. Your text is still here.', {exact: true})
		await expect(problem).toBeVisible()
		await expect(problem).toHaveAttribute('role', 'alert')
		await expect(d.root.getByRole('button', {name: 'Dismiss', exact: true})).toBeVisible()
		await expect(d.title).toHaveValue('After the storm')
		await expect(d.body).toContainText('The text outlived its entry.')
		await expect(d.status).toHaveText(SAVE_FAILED)

		const created = waitForApi(page, 'POST', `/compass/spaces/${space.id}/entries`)
		await d.root.getByRole('button', {name: 'Save as a new entry', exact: true}).click()
		const response = await created
		expect(response.status()).toBe(201)
		const {id} = await response.json() as {id: number}
		await expect(page).toHaveURL(new RegExp(`/compass/entries/${id}/edit$`))
		await expect(problem).toHaveCount(0)
		await expect(d.title).toHaveValue('After the storm')
		await expect(d.status).toHaveText(SAVED_AT)

		const stored = await readCompassEntry(apiContext, userToken, id)
		expect(stored).toMatchObject({
			space_id: space.id,
			title: 'After the storm',
			revision: 1,
		})
		expect(stored.content).toContain('The text outlived its entry.')
		expect(await compassStatusFor(apiContext, userToken, `/compass/entries/${entry.id}`)).toBe(404)
		const {items} = await listCompassEntries(apiContext, userToken, space.id)
		expect(items.map(item => item.id).sort((a, b) => a - b)).toEqual([neighbour.id, id])
	})

	test('an entry in the trash opens a notice instead of the desk, and Restore opens the desk', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Attic'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Old resolution'})
		await updateCompassEntry(apiContext, userToken, entry.id, {state: 'trashed'})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		await expect(page.getByRole('heading', {level: 1, name: 'This entry is in the trash', exact: true}))
			.toBeVisible()
		await expect(page.getByText('This entry is in the trash. Restore it to edit.')).toBeVisible()
		await expect(page.getByRole('link', {name: 'Open the entry', exact: true}))
			.toHaveAttribute('href', `/compass/entries/${entry.id}`)
		await expect(page.locator('form.compass-desk')).toHaveCount(0)

		await page.getByRole('button', {name: 'Restore', exact: true}).click()
		const d = desk(page)
		await expect(d.title).toHaveValue('Old resolution')
		// The button that had focus is gone; writing starts at the title.
		await expect(d.title).toBeFocused()
		await expect(d.save).toHaveAttribute('aria-disabled', 'true')
		await expect(d.root.locator('.compass-state-badge')).toHaveCount(0)
		expect((await readCompassEntry(apiContext, userToken, entry.id)).state).toBe('active')
	})

	test('another person’s private space and its entries cannot be opened for writing', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const [owner] = await UserFactory.create(1, {id: 2}, false)
		const {token: ownerToken} = await login(null, apiContext, owner)
		const space = await createCompassSpace(apiContext, ownerToken, {title: 'Someone else’s sky'})
		const entry = await createCompassEntry(apiContext, ownerToken, space.id, {title: 'A private letter'})
		expect([403, 404]).toContain(await compassStatusFor(apiContext, userToken, `/compass/entries/${entry.id}`))

		await page.goto(`/compass/entries/${entry.id}/edit`)
		await expect(page.getByRole('heading', {level: 1, name: 'This entry can\'t be opened', exact: true}))
			.toBeVisible()
		await expect(page.getByRole('link', {name: 'Go to Compass', exact: true})).toHaveAttribute('href', '/compass')
		await expect(page.locator('form.compass-desk')).toHaveCount(0)
		await expect(page.getByText('A private letter')).toHaveCount(0)

		await page.goto(`/compass/spaces/${space.id}/write`)
		await expect(page.getByRole('heading', {level: 1, name: 'This space can\'t be opened', exact: true}))
			.toBeVisible()
		await expect(page.locator('form.compass-desk')).toHaveCount(0)
		await expect(page.getByText('Someone else’s sky')).toHaveCount(0)
	})

	test('a desk that could not load shows a quiet skeleton, then the failure, and opens on Retry', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Weak signal'})
		const entry = await createCompassEntry(apiContext, userToken, space.id, {title: 'Behind a flaky line'})
		let release: () => void = () => {}
		const held = new Promise<void>(resolve => {
			release = resolve
		})
		const entryRead = (url: URL) => url.pathname.endsWith(`/api/v2/compass/entries/${entry.id}`)
		await page.route(entryRead, async route => {
			if (route.request().method() !== 'GET') {
				await route.continue()
				return
			}
			await held
			await route.abort()
		})
		await page.goto(`/compass/entries/${entry.id}/edit`)

		await expect(page.locator('.compass-editor-skeleton')).toHaveAttribute('aria-busy', 'true')
		await expect(page.getByRole('status').filter({hasText: 'Opening the writing desk…'})).toBeAttached()
		release()

		const notice = page.locator('.compass-editor-notice')
		await expect(page.getByRole('heading', {level: 1, name: 'The writing desk couldn\'t open', exact: true}))
			.toBeVisible()
		await expect(notice.getByRole('alert')).toHaveText('Could not load this. Please try again.')
		await expect(notice.getByRole('link', {name: 'Go to Compass', exact: true})).toHaveAttribute('href', '/compass')
		await expect(page.locator('form.compass-desk')).toHaveCount(0)

		await page.unroute(entryRead)
		await notice.getByRole('button', {name: 'Retry', exact: true}).click()
		const d = desk(page)
		await expect(d.title).toHaveValue('Behind a flaky line')
		await expect(editHeading(page, 'Behind a flaky line')).toBeAttached()
		await expect(d.status).toHaveText('Saved')
	})

	test('on a 390px phone the details fold away, open for a problem inside them, and nothing overflows', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		await page.setViewportSize({width: 390, height: 844})
		const space = await createCompassSpace(apiContext, userToken, {title: 'Phone notes'})
		const creates = recordRequests(page, 'POST', `/compass/spaces/${space.id}/entries`)
		await page.goto(`/compass/spaces/${space.id}/write`)

		const d = desk(page)
		const details = d.root.locator('details.compass-desk__aside')
		await expect(d.title).toBeVisible()
		await expect(details.locator('summary')).toContainText('Details')
		await expect(d.root.getByRole('complementary', {name: 'Details'})).toHaveCount(0)
		// The back link keeps its name while its text is visually hidden.
		await expect(d.root.getByRole('link', {name: 'Back to Phone notes', exact: true})).toBeVisible()
		await expectNoHorizontalOverflow(page)

		await d.title.fill('Walking without headphones')
		await d.body.fill('Let the street be loud for a while.')
		await setDetailsOpen(details, true)
		await d.category.fill('m'.repeat(85))
		await expect(d.root.getByText('5 characters over the limit of 80.')).toBeVisible()
		await setDetailsOpen(details, false)
		await expect(d.category).toBeHidden()

		// The problem sits inside the folded details: they open and the field takes the focus.
		await d.save.click()
		await expect(details).toHaveJSProperty('open', true)
		await expect(d.category).toBeFocused()
		await expect(d.category).toHaveAttribute('aria-invalid', 'true')
		await expect(d.root.getByText('5 characters over the limit of 80.')).toBeVisible()
		expect(creates).toHaveLength(0)

		await d.category.fill('Mornings')
		const created = waitForApi(page, 'POST', `/compass/spaces/${space.id}/entries`)
		await d.save.click()
		const response = await created
		expect(response.status()).toBe(201)
		const {id} = await response.json() as {id: number}
		await expect(page).toHaveURL(new RegExp(`/compass/entries/${id}/edit$`))
		await expect(d.status).toHaveText(SAVED_AT)
		expect(await readCompassEntry(apiContext, userToken, id)).toMatchObject({
			title: 'Walking without headphones',
			category: 'Mornings',
		})
		await expectNoHorizontalOverflow(page)
	})
})
