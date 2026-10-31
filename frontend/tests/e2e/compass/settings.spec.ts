import type {APIRequestContext, Locator, Page} from '@playwright/test'

import {test, expect} from '../../support/fixtures'
import {login} from '../../support/authenticateUser'
import {TeamFactory} from '../../factories/team'
import {TeamMemberFactory} from '../../factories/team_member'
import {UserFactory} from '../../factories/user'
import {
	COMPASS_API,
	compassStatusFor,
	createCompassSpace,
	listCompassSpaces,
	readCompassSpace,
	type CompassSpaceJson,
} from './compassApi'

// Ids follow the seeding order. The admin team gets the higher id so "admin teams first" is a real reordering.
const READING = {
	id: 1,
	name: 'Reading club',
}
const RESEARCH = {
	id: 2,
	name: 'Research circle',
}

const PREFACE_LABEL = 'What is this place for, and who is it written for?'
const PREFACE_TOO_LONG = 'The preface is too long to save'
const CONFLICT_TITLE = 'These settings were changed elsewhere while you were editing.'
const DIFFERS = 'Differs from yours'
const PERMANENT = 'The sharing choice can\'t be changed after the space is created.'
const UNAVAILABLE = 'This space doesn\'t exist, or you can no longer see it.'

type SpaceText = {
	title: string
	motto: string
	introduction: string
	theme: string
}

type Membership = {
	team_id: number
	user_id: number
	admin: boolean
}

// The path below /api/v2, or null for any other URL.
function apiPath(url: string): string | null {
	const {pathname} = new URL(url)
	const index = pathname.indexOf('/api/v2/')
	return index < 0 ? null : pathname.slice(index + '/api/v2'.length)
}

function waitForWrite(page: Page, method: 'POST' | 'PUT', path: string) {
	return page.waitForResponse(response => response.request().method() === method && apiPath(response.url()) === path)
}

// Every Compass write the page sends. "Nothing was sent" is checked after a later write that was sent,
// so a blocked attempt that leaked a request shows up as an extra entry.
function recordCompassWrites(page: Page): string[] {
	const writes: string[] = []
	page.on('request', request => {
		const path = apiPath(request.url())
		if (path?.startsWith('/compass/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
			writes.push(`${request.method()} ${path}`)
		}
	})
	return writes
}

function textOf(space: CompassSpaceJson): SpaceText {
	return {
		title: space.title,
		motto: space.motto ?? '',
		introduction: space.introduction ?? '',
		theme: space.theme,
	}
}

function putSpace(request: APIRequestContext, token: string, spaceId: number, text: SpaceText, revision: number) {
	return request.put(`${COMPASS_API}/compass/spaces/${spaceId}`, {
		headers: {Authorization: `Bearer ${token}`},
		data: {
			...text,
			revision,
		},
	})
}

// Saves on top of the latest version, the way a second tab or another device would.
async function saveSpaceElsewhere(
	request: APIRequestContext,
	token: string,
	spaceId: number,
	change: Partial<SpaceText>,
) {
	const latest = await readCompassSpace(request, token, spaceId)
	const response = await putSpace(request, token, spaceId, {...textOf(latest), ...change}, latest.revision)
	expect(response.ok(), await response.text()).toBe(true)
}

// The teammate administers both teams. The current user is a plain member of the reading club and,
// unless told otherwise, an admin of the research circle.
function memberships(userId: number, teammateId: number, adminOfResearch: boolean): Membership[] {
	return [
		{team_id: READING.id, user_id: teammateId, admin: true},
		{team_id: READING.id, user_id: userId, admin: false},
		{team_id: RESEARCH.id, user_id: teammateId, admin: true},
		{team_id: RESEARCH.id, user_id: userId, admin: adminOfResearch},
	]
}

async function seedMemberships(rows: Membership[]) {
	// Relation ids far from the user ids: a member record must never pass for the user by coincidence.
	await TeamMemberFactory.create(rows.length, {
		id: (i: number) => 100 + i,
		team_id: (i: number) => rows[i - 1].team_id,
		user_id: (i: number) => rows[i - 1].user_id,
		admin: (i: number) => rows[i - 1].admin,
	})
}

async function seedTeams(userId: number, {adminOfResearch = true} = {}) {
	const [teammate] = await UserFactory.create(1, {id: 2}, false)
	await TeamFactory.create(2, {
		id: '{increment}',
		name: (i: number) => [READING.name, RESEARCH.name][i - 1],
		created_by_id: teammate.id,
	})
	await seedMemberships(memberships(userId, teammate.id, adminOfResearch))
	return teammate
}

function settingsUrl(spaceId: number) {
	return `/compass/spaces/${spaceId}/settings`
}

function spaceUrl(spaceId: number) {
	return new RegExp(`/compass/spaces/${spaceId}$`)
}

function fields(page: Page) {
	return {
		name: page.getByRole('textbox', {name: 'Name', exact: true}),
		motto: page.getByRole('textbox', {name: 'Motto', exact: true}),
		preface: page.getByLabel(PREFACE_LABEL, {exact: true}),
		save: page.getByRole('button', {name: 'Save', exact: true}),
		status: page.locator('.compass-settings-form__status'),
	}
}

function previewOf(page: Page) {
	const root = page.locator('figure.compass-space-preview')
	return {
		root,
		eyebrow: root.locator('.compass-space-preview__eyebrow'),
		title: root.locator('.compass-space-preview__title'),
		motto: root.locator('.compass-space-preview__motto'),
	}
}

// The theme radios are visually hidden; the card around each one is what people click.
async function chooseTheme(page: Page, theme: string) {
	await page.locator('.compass-theme-picker__option').filter({hasText: theme}).click()
	await expect(page.getByRole('radio', {name: theme, exact: true})).toBeChecked()
}

function latestRow(panel: Locator, label: string) {
	return panel.locator('.compass-settings-form__latest-row').filter({
		has: panel.page().locator('.compass-settings-form__latest-term > span:first-child', {hasText: label}),
	})
}

function summaryRow(page: Page, label: string) {
	return page.locator('.compass-settings__summary-row').filter({has: page.locator('dt', {hasText: label})})
}

test.describe('Compass settings', () => {
	test('creates a private space with the chosen theme while the preview follows the form', async ({
		authenticatedPage: page,
		apiContext,
		currentUser,
		userToken,
	}) => {
		const [stranger] = await UserFactory.create(1, {id: 2}, false)
		await page.goto('/compass/new')
		await expect(page.getByRole('heading', {level: 1, name: 'New Compass space'})).toBeVisible()
		const {name, motto} = fields(page)
		const preview = previewOf(page)

		await expect(name).toHaveValue('Compass')
		await expect(name).toHaveAttribute('maxlength', '80')
		await expect(page.getByRole('radio', {name: 'Private (recommended)'})).toBeChecked()
		await expect(page.getByRole('radio', {name: 'Share with a team'})).not.toBeChecked()
		await expect(page.getByRole('radio', {name: 'Aurora', exact: true})).toBeChecked()
		await expect(page.getByText(PERMANENT)).toBeVisible()
		await expect(page.getByRole('group', {name: 'Choose a team'})).toHaveCount(0)
		await expect(preview.title).toHaveText('Compass')
		await expect(preview.motto).toHaveText('Your motto will appear here.')
		await expect(preview.eyebrow).toHaveText('Private')
		await expect(motto).toHaveAccessibleDescription(/0 \/ 600/)

		await name.fill('')
		await expect(preview.title).toHaveText('Untitled space')
		await name.fill('North star')
		await motto.fill('Choose the harder right.')
		await expect(preview.title).toHaveText('North star')
		await expect(preview.motto).toHaveText('Choose the harder right.')
		await expect(motto).toHaveAccessibleDescription(/24 \/ 600/)

		await chooseTheme(page, 'Solar')
		await expect(page.getByRole('radio', {name: 'Aurora', exact: true})).not.toBeChecked()
		await expect(page.locator('.compass-create')).toHaveAttribute('data-compass-theme', 'solar')
		await expect(preview.root).toHaveAttribute('data-compass-theme', 'solar')

		const created = waitForWrite(page, 'POST', '/compass/spaces')
		await page.getByRole('button', {name: 'Create space'}).click()
		const response = await created
		expect(response.ok()).toBe(true)
		const space = await response.json() as CompassSpaceJson
		await expect(page).toHaveURL(spaceUrl(space.id))
		await expect(page.locator('.global-notification')).toContainText('Your Compass is ready.')
		await expect(page.locator('.compass-hero__title')).toHaveText('North star')

		expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({
			title: 'North star',
			motto: 'Choose the harder right.',
			theme: 'solar',
			team_id: 0,
			owner_id: currentUser.id,
		})
		expect(await listCompassSpaces(apiContext, userToken)).toHaveLength(1)

		await page.reload()
		await expect(page.locator('.compass-hero__title')).toHaveText('North star')

		// Private means private: another account can neither open nor list it.
		const {token: strangerToken} = await login(null, apiContext, stranger)
		const strangerStatus = await compassStatusFor(apiContext, strangerToken, `/compass/spaces/${space.id}`)
		expect([403, 404]).toContain(strangerStatus)
		expect(await listCompassSpaces(apiContext, strangerToken)).toEqual([])
	})

	test('a space needs a name, and sharing it needs a team, before anything is sent', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const writes = recordCompassWrites(page)
		await page.goto('/compass/new')
		const {name} = fields(page)
		const submit = page.getByRole('button', {name: 'Create space'})

		await name.fill('')
		await submit.click()
		await expect(page.getByRole('alert').filter({hasText: 'Give the space a name.'})).toBeVisible()
		await expect(name).toBeFocused()
		await expect(name).toHaveAttribute('aria-invalid', 'true')

		await name.fill('Shared notes')
		await page.getByRole('radio', {name: 'Share with a team'}).check()
		await expect(previewOf(page).eyebrow).toHaveText('Shared with a team')
		// No teams at all: say why there is nothing to pick and where teams are made.
		const picker = page.getByRole('group', {name: 'Choose a team'})
		await expect(picker).toContainText('You aren\'t an admin of any team.')
		await expect(picker.getByRole('link', {name: 'Go to Teams'})).toHaveAttribute('href', /\/teams$/)
		await expect(picker.getByRole('radio')).toHaveCount(0)

		await submit.click()
		await expect(picker.getByRole('alert')).toHaveText('Choose a team, or keep the space private.')
		await expect(page).toHaveURL(/\/compass\/new$/)

		await page.getByRole('radio', {name: 'Private (recommended)'}).check()
		await expect(picker).toHaveCount(0)
		const created = waitForWrite(page, 'POST', '/compass/spaces')
		await submit.click()
		const response = await created
		expect(response.ok()).toBe(true)
		const space = await response.json() as CompassSpaceJson
		await expect(page).toHaveURL(spaceUrl(space.id))

		// Only the last attempt reached the server.
		expect(writes).toEqual(['POST /compass/spaces'])
		const stored = await listCompassSpaces(apiContext, userToken)
		expect(stored).toHaveLength(1)
		expect(stored[0]).toMatchObject({
			title: 'Shared notes',
			team_id: 0,
		})
	})

	test('cancel on a page opened directly goes to Compass and creates nothing', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const writes = recordCompassWrites(page)
		await page.goto('/compass/new')
		await fields(page).name.fill('Never mind')
		await page.getByRole('button', {name: 'Cancel', exact: true}).click()

		await expect(page).toHaveURL(/\/compass$/)
		expect(writes).toEqual([])
		expect(await listCompassSpaces(apiContext, userToken)).toEqual([])
	})

	test('only teams the user administers can be chosen, and the space is shared with that team', async ({
		authenticatedPage: page,
		apiContext,
		currentUser,
		userToken,
	}) => {
		const teammate = await seedTeams(currentUser.id)
		await page.goto('/compass/new')
		await fields(page).name.fill('Lab principles')
		await page.getByRole('radio', {name: 'Share with a team'}).check()
		const preview = previewOf(page)
		await expect(preview.eyebrow).toHaveText('Shared with a team')
		await expect(page.getByText(PERMANENT)).toBeVisible()

		const picker = page.getByRole('group', {name: 'Choose a team'})
		const research = picker.getByRole('radio', {name: RESEARCH.name})
		const reading = picker.getByRole('radio', {name: READING.name})
		await expect(research).toBeEnabled()
		await expect(research).not.toBeChecked()
		await expect(picker.locator('label', {hasText: RESEARCH.name})).toContainText('2 members')
		// Admin teams are listed first, whatever order the server returns.
		await expect(picker.locator('.compass-team-picker__name')).toHaveText([RESEARCH.name, READING.name])

		// Listed so the choice is understandable, but it cannot be focused or picked.
		await expect(reading).toHaveAttribute('aria-disabled', 'true')
		await expect(reading).toHaveAccessibleDescription(/You're not an admin of this team/)
		await expect(reading).not.toHaveAttribute('tabindex')
		await reading.click({force: true})
		await expect(reading).toHaveAttribute('aria-checked', 'false')
		await expect(preview.eyebrow).toHaveText('Shared with a team')

		const search = picker.getByRole('searchbox', {name: 'Find a team'})
		await expect(search).toHaveAttribute('placeholder', 'Team name')
		await search.fill('zzz')
		// Enter searches; it must not submit the form (that would flag the missing team).
		await search.press('Enter')
		await expect(picker).toContainText('No team matches “zzz”.')
		await expect(picker.getByRole('radio')).toHaveCount(0)
		await expect(picker.getByRole('alert')).toHaveCount(0)
		await search.fill('')
		await expect(research).toBeVisible()

		await research.check()
		await expect(preview.eyebrow).toHaveText(`Shared with ${RESEARCH.name}`)

		const created = waitForWrite(page, 'POST', '/compass/spaces')
		await page.getByRole('button', {name: 'Create space'}).click()
		const response = await created
		expect(response.ok()).toBe(true)
		const space = await response.json() as CompassSpaceJson
		expect(space).toMatchObject({title: 'Lab principles', team_id: RESEARCH.id})
		await expect(page).toHaveURL(spaceUrl(space.id))
		expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({
			team_id: RESEARCH.id,
			owner_id: currentUser.id,
			max_permission: 2,
		})

		// Current members of the team can open it.
		const {token: teammateToken} = await login(null, apiContext, teammate)
		expect(await compassStatusFor(apiContext, teammateToken, `/compass/spaces/${space.id}`)).toBe(200)

		// Afterwards the sharing is only described, never offered as a choice again.
		await page.goto(settingsUrl(space.id))
		const sharing = page.getByRole('group', {name: 'Sharing', exact: true})
		await expect(sharing).toContainText(`Shared with ${RESEARCH.name}`)
		await expect(sharing).toContainText(`Current members of ${RESEARCH.name} can read and write entries`)
		await expect(sharing).toContainText(PERMANENT)
		await expect(sharing.getByRole('radio')).toHaveCount(0)
	})

	test('losing team admin rights before creating explains why nothing was created', async ({
		authenticatedPage: page,
		apiContext,
		currentUser,
		userToken,
	}) => {
		const teammate = await seedTeams(currentUser.id)
		await page.goto('/compass/new')
		await page.getByRole('radio', {name: 'Share with a team'}).check()
		await page.getByRole('group', {name: 'Choose a team'}).getByRole('radio', {name: RESEARCH.name}).check()

		// Another admin takes the right away while the form is open.
		await seedMemberships(memberships(currentUser.id, teammate.id, false))

		const created = waitForWrite(page, 'POST', '/compass/spaces')
		await page.getByRole('button', {name: 'Create space'}).click()
		expect((await created).status()).toBe(403)
		await expect(page.getByRole('alert').filter({hasText: 'Only admins of this team can share a space with it.'}))
			.toBeVisible()
		await expect(page).toHaveURL(/\/compass\/new$/)
		expect(await listCompassSpaces(apiContext, userToken)).toEqual([])
	})

	test('an admin saves name, motto, preface and theme, and they stay after a reload', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Field notes'})
		await page.goto(settingsUrl(space.id))
		const form = fields(page)
		const preview = previewOf(page)

		await expect(page.getByRole('heading', {level: 1, name: 'Space settings'})).toBeVisible()
		await expect(page.locator('.compass-settings__space')).toHaveText('Field notes')
		await expect(form.name).toHaveValue('Field notes')
		// Nothing changed yet: nothing to save.
		await expect(form.save).toHaveAttribute('aria-disabled', 'true')
		await expect(form.save).toHaveAttribute('aria-keyshortcuts', 'Control+S Meta+S')
		await expect(page.getByRole('group', {name: 'Sharing', exact: true}))
			.toContainText('Private — only you can see this space')
		await expect(page.locator('.compass-settings-form__count').filter({hasText: 'of 64 KB'}))
			.toHaveText('0 B of 64 KB')

		// The preface takes text, links and tables, but no images or task lists.
		const toolbar = page.locator('.compass-settings-form .editor-toolbar')
		await expect(toolbar.getByRole('button', {name: 'Bold', exact: true, includeHidden: true})).toHaveCount(1)
		await expect(toolbar.getByRole('button', {name: 'Image', exact: true, includeHidden: true})).toHaveCount(0)
		await expect(toolbar.getByRole('button', {name: 'Task list', exact: true, includeHidden: true})).toHaveCount(0)

		await form.name.fill('Harbour lights')
		await form.motto.fill('Steer by what stays.')
		await chooseTheme(page, 'Nebula')
		await form.preface.fill('Written for the version of me who has lost the thread.')
		await expect(form.status).toContainText('Unsaved changes')
		await expect(form.save).not.toHaveAttribute('aria-disabled', 'true')
		await expect(preview.title).toHaveText('Harbour lights')
		await expect(preview.motto).toHaveText('Steer by what stays.')
		await expect(preview.eyebrow).toHaveText('Private')
		await expect(preview.root).toHaveAttribute('data-compass-theme', 'nebula')

		const saved = waitForWrite(page, 'PUT', `/compass/spaces/${space.id}`)
		await form.save.click()
		expect((await saved).status()).toBe(200)
		await expect(form.status).toContainText('Saved')
		await expect(form.status.getByRole('link', {name: 'Back to the space'})).toBeVisible()
		await expect(page.locator('.global-notification')).toContainText('Space settings saved.')
		await expect(form.save).toHaveAttribute('aria-disabled', 'true')

		const stored = await readCompassSpace(apiContext, userToken, space.id)
		expect(stored).toMatchObject({
			title: 'Harbour lights',
			motto: 'Steer by what stays.',
			theme: 'nebula',
			revision: 2,
		})
		expect(stored.introduction).toContain('Written for the version of me who has lost the thread.')

		await page.reload()
		await expect(form.name).toHaveValue('Harbour lights')
		await expect(form.motto).toHaveValue('Steer by what stays.')
		await expect(page.getByRole('radio', {name: 'Nebula', exact: true})).toBeChecked()
		await expect(form.preface).toContainText('Written for the version of me who has lost the thread.')
		await expect(page.locator('.compass-settings')).toHaveAttribute('data-compass-theme', 'nebula')
		await expect(form.save).toHaveAttribute('aria-disabled', 'true')

		// Ctrl/⌘+S saves from any field.
		await form.motto.fill('Steer by what stays, not by what shines.')
		const shortcut = waitForWrite(page, 'PUT', `/compass/spaces/${space.id}`)
		await page.keyboard.press('ControlOrMeta+s')
		expect((await shortcut).status()).toBe(200)
		await expect(form.status).toContainText('Saved')
		expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({
			motto: 'Steer by what stays, not by what shines.',
			revision: 3,
		})

		// The space itself now carries the new identity.
		await form.status.getByRole('link', {name: 'Back to the space'}).click()
		await expect(page).toHaveURL(spaceUrl(space.id))
		await expect(page.locator('.compass-hero__title')).toHaveText('Harbour lights')
		await expect(page.locator('.compass-preface')).toContainText('Written for the version of me')
	})

	test('a preface over 64 KB is not sent until it is shortened', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const almostFull = `<p>${'a'.repeat(65_400)}</p>`
		const space = await createCompassSpace(apiContext, userToken, {
			title: 'Long preface',
			introduction: almostFull,
		})
		// The test only means something if the stored preface really sits just under the limit.
		expect((await readCompassSpace(apiContext, userToken, space.id)).introduction).toBe(almostFull)

		const writes = recordCompassWrites(page)
		await page.goto(settingsUrl(space.id))
		const form = fields(page)
		const size = page.locator('.compass-settings-form__count').filter({hasText: 'of 64 KB'})
		const tooLong = page.getByRole('alert').filter({hasText: PREFACE_TOO_LONG})
		await expect(size).toHaveText(/63\.\d+ KB of 64 KB/)
		await expect(tooLong).toHaveCount(0)

		await form.preface.focus()
		await page.keyboard.type('b'.repeat(200))
		await expect(tooLong).toBeVisible()
		await expect(tooLong).toContainText('at most 64 KB')
		await expect(size).toHaveText(/64\.\d+ KB of 64 KB/)
		await expect(form.save).toHaveAttribute('aria-disabled', 'true')
		// Neither the shortcut nor a click gets past the limit.
		await page.keyboard.press('ControlOrMeta+s')
		await form.save.click({force: true})

		await form.preface.fill('A short preface again.')
		await expect(tooLong).toHaveCount(0)
		await expect(form.save).not.toHaveAttribute('aria-disabled', 'true')
		// The editor's own shortcut saves as well.
		const saved = waitForWrite(page, 'PUT', `/compass/spaces/${space.id}`)
		await page.keyboard.press('ControlOrMeta+Enter')
		expect((await saved).status()).toBe(200)
		await expect(form.status).toContainText('Saved')

		expect(writes).toEqual([`PUT /compass/spaces/${space.id}`])
		const stored = await readCompassSpace(apiContext, userToken, space.id)
		expect(stored.revision).toBe(2)
		expect(stored.introduction).toContain('A short preface again.')
		expect(stored.introduction).not.toContain('aaaa')
	})

	test('a stale save shows the latest version, and keeping my changes replaces it', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {
			title: 'Field notes',
			motto: 'Keep walking.',
		})
		await page.goto(settingsUrl(space.id))
		const form = fields(page)
		await expect(form.name).toHaveValue('Field notes')
		await form.name.fill('My chosen name')

		// Another tab saves first.
		await saveSpaceElsewhere(apiContext, userToken, space.id, {
			title: 'Their name',
			theme: 'ink',
		})

		const conflict = waitForWrite(page, 'PUT', `/compass/spaces/${space.id}`)
		await form.save.click()
		expect((await conflict).status()).toBe(409)

		const panel = page.getByRole('region', {name: CONFLICT_TITLE})
		await expect(panel.getByRole('alert')).toHaveText(CONFLICT_TITLE)
		await expect(panel).toContainText('Latest saved version')
		await expect(latestRow(panel, 'Name').locator('dd')).toHaveText('Their name')
		await expect(latestRow(panel, 'Name')).toContainText(DIFFERS)
		await expect(latestRow(panel, 'Theme').locator('dd')).toHaveText('Ink')
		await expect(latestRow(panel, 'Theme')).toContainText(DIFFERS)
		await expect(latestRow(panel, 'Motto').locator('dd')).toHaveText('Keep walking.')
		await expect(latestRow(panel, 'Motto')).not.toContainText(DIFFERS)
		await expect(latestRow(panel, 'Preface').locator('dd')).toHaveText('Empty')
		// The draft is untouched, and saving waits for a decision.
		await expect(form.name).toHaveValue('My chosen name')
		await expect(form.save).toHaveAttribute('aria-disabled', 'true')
		await expect(page.getByText('Choose one of the two versions above before saving.')).toBeVisible()

		await panel.getByRole('button', {name: 'Keep my changes'}).click()
		await expect(panel).toHaveCount(0)
		await expect(form.status).toContainText('Unsaved changes. Saving will replace the latest version.')
		await expect(form.save).toBeFocused()
		await expect(page.getByText('Choose one of the two versions above before saving.')).toHaveCount(0)

		const saved = waitForWrite(page, 'PUT', `/compass/spaces/${space.id}`)
		await form.save.click()
		expect((await saved).status()).toBe(200)
		await expect(form.status).toContainText('Saved')

		// The whole draft won, including the theme this page never touched.
		expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({
			title: 'My chosen name',
			motto: 'Keep walking.',
			theme: 'aurora',
			revision: 3,
		})
		await page.reload()
		await expect(form.name).toHaveValue('My chosen name')
		await expect(page.getByRole('radio', {name: 'Aurora', exact: true})).toBeChecked()
	})

	test('a stale save can be resolved by taking the latest version', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {
			title: 'Field notes',
			motto: 'Keep walking.',
		})
		await page.goto(settingsUrl(space.id))
		const form = fields(page)
		await expect(form.name).toHaveValue('Field notes')
		await form.name.fill('My chosen name')
		await form.motto.fill('A line of my own.')

		await saveSpaceElsewhere(apiContext, userToken, space.id, {
			title: 'Their name',
			theme: 'ink',
			introduction: '<p>Their preface.</p>',
		})

		const conflict = waitForWrite(page, 'PUT', `/compass/spaces/${space.id}`)
		await form.save.click()
		expect((await conflict).status()).toBe(409)
		const panel = page.getByRole('region', {name: CONFLICT_TITLE})
		await expect(latestRow(panel, 'Motto').locator('dd')).toHaveText('Keep walking.')
		await expect(latestRow(panel, 'Motto')).toContainText(DIFFERS)
		await expect(latestRow(panel, 'Preface').locator('dd')).toHaveText('Their preface.')
		await expect(latestRow(panel, 'Preface')).toContainText(DIFFERS)

		await panel.getByRole('button', {name: 'Use the latest'}).click()
		await expect(panel).toHaveCount(0)
		await expect(form.name).toHaveValue('Their name')
		await expect(form.motto).toHaveValue('Keep walking.')
		await expect(page.getByRole('radio', {name: 'Ink', exact: true})).toBeChecked()
		await expect(page.locator('.compass-settings-form')).toHaveAttribute('data-compass-theme', 'ink')
		await expect(form.preface).toContainText('Their preface.')
		await expect(form.status).toContainText('The latest version is loaded.')
		// Identical to the server again: nothing to save.
		await expect(form.save).toHaveAttribute('aria-disabled', 'true')

		expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({
			title: 'Their name',
			motto: 'Keep walking.',
			theme: 'ink',
			revision: 2,
		})
		await page.reload()
		await expect(form.name).toHaveValue('Their name')
		await expect(form.motto).toHaveValue('Keep walking.')
	})

	test('losing admin rights while editing keeps the changes on the page and says why', async ({
		authenticatedPage: page,
		apiContext,
		currentUser,
		userToken,
	}) => {
		// The draft is still unsaved when the test ends; let the fixture's navigation pass the leave prompt.
		page.on('dialog', dialog => {
			void dialog.accept()
		})
		const teammate = await seedTeams(currentUser.id)
		const space = await createCompassSpace(apiContext, userToken, {
			title: 'Lab principles',
			team_id: RESEARCH.id,
		})
		await page.goto(settingsUrl(space.id))
		const form = fields(page)
		await expect(form.name).toHaveValue('Lab principles')
		await form.motto.fill('Measure twice.')

		// Another admin demotes the current user while the form is open.
		await seedMemberships(memberships(currentUser.id, teammate.id, false))

		const refused = waitForWrite(page, 'PUT', `/compass/spaces/${space.id}`)
		await form.save.click()
		expect((await refused).status()).toBe(403)
		await expect(page.getByRole('alert').filter({hasText: 'You can no longer change these settings.'}))
			.toBeVisible()
		// The form stays, with the words still in it, even though the space now reads as read-only.
		await expect(form.motto).toHaveValue('Measure twice.')
		await expect(form.status).toContainText('Unsaved changes')
		expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({
			motto: '',
			revision: 1,
			max_permission: 1,
		})
	})

	test('leaving with unsaved changes asks first, by link or by the browser\'s back button', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Field notes'})
		// Arrive from the space inside the app, so there is history to go back to.
		await page.goto(`/compass/spaces/${space.id}`)
		await page.getByRole('link', {name: 'Space settings', exact: true}).click()
		await expect(page).toHaveURL(new RegExp(`${settingsUrl(space.id)}$`))
		const form = fields(page)
		await form.motto.fill('Not saved yet.')
		await expect(form.status).toContainText('Unsaved changes')

		const dialog = page.getByRole('dialog', {name: 'Leave without saving?'})
		await page.evaluate(() => history.back())
		await expect(dialog).toBeVisible()
		await expect(page).toHaveURL(new RegExp(`${settingsUrl(space.id)}$`))
		await dialog.getByRole('button', {name: 'Stay', exact: true}).click()
		await expect(dialog).toHaveCount(0)
		await expect(form.motto).toHaveValue('Not saved yet.')

		await page.getByRole('link', {name: 'Back to the space'}).click()
		await expect(dialog).toBeVisible()
		await dialog.getByRole('button', {name: 'Discard and leave'}).click()
		await expect(page).toHaveURL(spaceUrl(space.id))
		await expect(page.locator('.compass-hero__title')).toHaveText('Field notes')
		expect(await readCompassSpace(apiContext, userToken, space.id)).toMatchObject({
			motto: '',
			revision: 1,
		})
	})

	test('closing the tab with unsaved changes asks the browser to confirm', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Field notes'})
		await page.goto(settingsUrl(space.id))
		const form = fields(page)
		await form.motto.click()
		await page.keyboard.type('Half a thought')
		await expect(form.status).toContainText('Unsaved changes')

		const prompt = page.waitForEvent('dialog')
		await page.close({runBeforeUnload: true})
		const dialog = await prompt
		expect(dialog.type()).toBe('beforeunload')
		await dialog.accept()
	})

	test('a team member who is not an admin sees the settings read-only', async ({
		authenticatedPage: page,
		apiContext,
		currentUser,
		userToken,
	}) => {
		const teammate = await seedTeams(currentUser.id)
		const {token: teammateToken} = await login(null, apiContext, teammate)
		const space = await createCompassSpace(apiContext, teammateToken, {
			title: 'Lab principles',
			theme: 'solar',
			team_id: READING.id,
		})

		await page.goto(`/compass/spaces/${space.id}`)
		await expect(page.locator('.compass-hero__title')).toHaveText('Lab principles')
		await expect(page.getByRole('link', {name: 'Space settings', exact: true})).toHaveCount(0)

		await page.goto(settingsUrl(space.id))
		await expect(page.getByText('Only the space owner or team admins can change these settings.')).toBeVisible()
		await expect(summaryRow(page, 'Name').locator('dd')).toHaveText('Lab principles')
		await expect(summaryRow(page, 'Motto').locator('dd')).toHaveText('No motto yet.')
		await expect(summaryRow(page, 'Theme').locator('dd')).toHaveText('Solar')
		await expect(summaryRow(page, 'Sharing').locator('dd')).toContainText(`Shared with ${READING.name}`)
		await expect(page.locator('.compass-settings')).toHaveAttribute('data-compass-theme', 'solar')
		const settings = page.locator('.compass-settings')
		await expect(settings.getByRole('textbox')).toHaveCount(0)
		await expect(settings.getByRole('radio')).toHaveCount(0)
		await expect(page.getByRole('button', {name: 'Save', exact: true})).toHaveCount(0)

		// The server agrees: reading is allowed, changing is not.
		const mine = await readCompassSpace(apiContext, userToken, space.id)
		expect(mine.max_permission).toBe(1)
		const refused = await putSpace(apiContext, userToken, space.id, {
			...textOf(mine),
			title: 'Taken over',
		}, mine.revision)
		expect(refused.status()).toBe(403)
		expect((await readCompassSpace(apiContext, teammateToken, space.id)).title).toBe('Lab principles')
	})

	test('a space that is gone or belongs to someone else offers no retry and shows nothing of it', async ({
		authenticatedPage: page,
		apiContext,
	}) => {
		const [owner] = await UserFactory.create(1, {id: 2}, false)
		const {token: ownerToken} = await login(null, apiContext, owner)
		const hidden = await createCompassSpace(apiContext, ownerToken, {
			title: 'Someone else\'s compass',
			motto: 'Not for other eyes.',
		})

		for (const spaceId of [hidden.id, hidden.id + 100]) {
			await page.goto(settingsUrl(spaceId))
			const state = page.getByRole('alert').filter({hasText: UNAVAILABLE})
			await expect(state).toBeVisible()
			await expect(state.getByRole('link', {name: 'Go to Compass'})).toHaveAttribute('href', /\/compass$/)
			await expect(page.getByRole('heading', {level: 1, name: 'Space settings'})).toBeVisible()
			await expect(page.getByRole('button', {name: 'Retry'})).toHaveCount(0)
			await expect(page.getByRole('link', {name: 'Back to the space'})).toHaveCount(0)
			await expect(page.locator('.compass-settings')).not.toContainText('Someone else')
			await expect(page.locator('.compass-settings')).not.toContainText('Not for other eyes.')
		}
	})

	test('a space that failed to load says so and can be retried', async ({
		authenticatedPage: page,
		apiContext,
		userToken,
	}) => {
		const space = await createCompassSpace(apiContext, userToken, {title: 'Field notes'})
		let failing = true
		await page.route(url => apiPath(url.toString()) === `/compass/spaces/${space.id}`, async route => {
			if (failing && route.request().method() === 'GET') {
				// Built on the real answer so its CORS headers stay; only status and body change.
				const response = await route.fetch()
				await route.fulfill({
					response,
					status: 500,
					json: {message: 'Temporarily unavailable'},
				})
				return
			}
			await route.continue()
		})

		await page.goto(settingsUrl(space.id))
		const state = page.getByRole('alert').filter({hasText: 'This space couldn\'t be loaded.'})
		await expect(state).toBeVisible()
		await expect(fields(page).name).toHaveCount(0)

		failing = false
		await state.getByRole('button', {name: 'Retry'}).click()
		await expect(state).toHaveCount(0)
		await expect(fields(page).name).toHaveValue('Field notes')
	})
})
