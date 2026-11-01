import {test, expect} from '../../support/fixtures'
import {UserFactory} from '../../factories/user'
import {TeamFactory} from '../../factories/team'
import {TeamMemberFactory} from '../../factories/team_member'
import {UserProjectFactory} from '../../factories/users_project'
import {login} from '../../support/authenticateUser'
import {ProjectFactory} from '../../factories/project'
import {TeamProjectFactory} from '../../factories/team_project'
import {createDefaultViews, createProjects} from '../project/prepareProjects'

for (const kind of ['user', 'team'] as const) {
	test(`adds, changes and removes a project ${kind} share`, async ({authenticatedPage: page}) => {
		const users = await UserFactory.create(2)
		await createProjects(1)
		const [team] = await TeamFactory.create(1, {id: 1, name: 'Sharing Team'})
		await TeamMemberFactory.create(1, {team_id: team.id, user_id: 1, admin: true})
		const name = kind === 'user' ? users[1].username : team.name
		await page.goto('/projects/1/settings/share')
		const section = page.getByRole('heading', {name: `Shared with these ${kind}s`, exact: true}).locator('..')
		await section.getByRole('combobox', {name: `Search for a ${kind} to share this project with`}).pressSequentially(name, {delay: 10})
		await expect(section.locator('.search-results').getByRole('option').first()).toContainText(name)
		await section.locator('.search-results').getByRole('option').first().click()
		const share = section.getByRole('button', {name: 'Share', exact: true})
		await share.focus()
		await share.press('Enter')
		const row = section.getByRole('row').filter({hasText: name})
		await expect(row).toBeVisible()
		await expect(share).toBeFocused()
		if (kind === 'team') {
			await expect(row.getByRole('link', {name})).toHaveAttribute('href', `/teams/${team.id}/edit`)
		}
		await row.getByRole('combobox').selectOption('1')
		await expect(row.locator('td.type')).toHaveText('Read & write')
		await page.reload()
		await expect(row.locator('td.type')).toHaveText('Read & write')
		await row.getByRole('button', {name: `Remove this ${kind}`}).click()
		const removeDialog = page.getByRole('dialog', {name: `Remove ${name}?`})
		await expect(removeDialog).toContainText('First Project')
		await removeDialog.getByRole('button', {name: 'Cancel', exact: true}).click()
		await expect(removeDialog).toHaveCount(0)
		await expect(row).toBeVisible()
		await row.getByRole('button', {name: `Remove this ${kind}`}).click()
		await removeDialog.locator('[data-cy="modalPrimary"]').click()
		await expect(row).toHaveCount(0)
		await page.reload()
		await expect(row).toHaveCount(0)
	})
}

for (const kind of ['user', 'team'] as const) {
	test(`clears ${kind} share search results when the search is cleared`, async ({authenticatedPage: page}) => {
		const users = await UserFactory.create(2)
		await createProjects(1)
		const [team] = await TeamFactory.create(1, {id: 1, name: 'Sharing Team'})
		await TeamMemberFactory.create(1, {team_id: team.id, user_id: 1, admin: true})
		const name = kind === 'user' ? users[1].username : team.name
		await page.goto('/projects/1/settings/share')
		const section = page.getByRole('heading', {name: `Shared with these ${kind}s`, exact: true}).locator('..')
		const search = section.getByRole('combobox', {name: `Search for a ${kind} to share this project with`})
		await search.pressSequentially(name, {delay: 10})
		await expect(section.locator('.search-results').getByRole('option')).not.toHaveCount(0)
		// fill('') skips the keyup handler the search binds to; select-all + Backspace is a real keystroke.
		await search.press('ControlOrMeta+a')
		await search.press('Backspace')
		await expect(section.locator('.search-results').getByRole('option')).toHaveCount(0)
	})
}

test('read-only members cannot manage shares', async ({page, apiContext}) => {
	const [, reader] = await UserFactory.create(2)
	await createProjects(1)
	await UserProjectFactory.create(1, {project_id: 1, user_id: reader.id, permission: 0})
	await login(page, apiContext, reader)
	await page.goto('/projects/1/settings/share')
	const section = page.getByRole('heading', {name: 'Shared with these users', exact: true}).locator('..')
	await expect(section.getByRole('row').filter({hasText: reader.username}).getByText('You', {exact: true})).toBeVisible()
	await expect(section.getByRole('combobox', {name: 'Search for a user to share this project with'})).toHaveCount(0)
	await expect(section.getByRole('button', {name: 'Share', exact: true})).toHaveCount(0)
	await expect(section.getByRole('button', {name: 'Remove this user'})).toHaveCount(0)
})

test('asks before you lower or remove your own access', async ({page, apiContext}) => {
	const [, admin] = await UserFactory.create(2)
	await createProjects(1)
	await UserProjectFactory.create(1, {project_id: 1, user_id: admin.id, permission: 2})
	await login(page, apiContext, admin)
	await page.goto('/projects/1/settings/share')
	const section = page.getByRole('heading', {name: 'Shared with these users', exact: true}).locator('..')
	const own = section.getByRole('row').filter({hasText: admin.username})

	await own.locator('select').selectOption('0')
	const lower = page.getByRole('dialog', {name: 'Lower your own permission to Read only?'})
	await expect(lower).toBeVisible()
	await lower.getByRole('button', {name: 'Cancel', exact: true}).click()
	await expect(own.locator('select')).toHaveValue('2')

	await own.getByRole('button', {name: 'Remove this user'}).click()
	const remove = page.getByRole('dialog', {name: 'Remove your own access?'})
	await expect(remove).toContainText('You won\'t be able to open')
	await remove.locator('[data-cy="modalPrimary"]').click()
	await expect(page).toHaveURL('/')
})

test('shows a team that can open the project through its parent project', async ({authenticatedPage: page}) => {
	const [parent, child] = await ProjectFactory.create(2, {
		id: '{increment}',
		title: (i: number) => i === 1 ? 'Parent' : 'Child',
		parent_project_id: (i: number) => i === 1 ? 0 : 1,
	})
	await createDefaultViews(parent.id, 1)
	await createDefaultViews(child.id, 5)
	await TeamFactory.create(1, {id: 1, name: 'Parent Team'})
	await TeamMemberFactory.create(1, {team_id: 1, user_id: 1, admin: true})
	await TeamProjectFactory.create(1, {team_id: 1, project_id: parent.id, permission: 1})

	await page.goto(`/projects/${child.id}/settings/share`)
	const summary = page.getByRole('heading', {name: 'Who can open this project', exact: true}).locator('..')
	await expect(summary).toContainText('Through the parent project “Parent”')
	await expect(summary).toContainText('Parent Team')
	await expect(summary).toContainText('Read & write')
	await expect(summary.getByRole('link', {name: 'Manage sharing of “Parent”'})).toHaveAttribute('href', `/projects/${parent.id}/settings/share`)
	// The team has no share of its own on the child, and the page doesn't call it private.
	const teams = page.getByRole('heading', {name: 'Shared with these teams', exact: true}).locator('..')
	await expect(teams).toContainText('Not shared directly with any teams yet.')
	await expect(summary).not.toContainText('Not shared with anyone else')
})

test('says a project is not shared once every source of access is checked', async ({authenticatedPage: page}) => {
	await createProjects(1)
	await page.goto('/projects/1/settings/share')
	const summary = page.getByRole('heading', {name: 'Who can open this project', exact: true}).locator('..')
	await expect(summary).toContainText('Not shared with anyone else, directly or through a parent project.')
})

test('keeps the removal dialog open when removing a share fails', async ({authenticatedPage: page}) => {
	const [, other] = await UserFactory.create(2)
	await createProjects(1)
	await UserProjectFactory.create(1, {project_id: 1, user_id: other.id, permission: 1})
	await page.route('**/projects/1/users/*', route => route.request().method() === 'DELETE'
		? route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'Internal Server Error'})})
		: route.fallback())

	await page.goto('/projects/1/settings/share')
	const section = page.getByRole('heading', {name: 'Shared with these users', exact: true}).locator('..')
	const row = section.getByRole('row').filter({hasText: other.username})
	await row.getByRole('button', {name: 'Remove this user'}).click()
	const removeDialog = page.getByRole('dialog', {name: `Remove ${other.username}?`})
	await removeDialog.locator('[data-cy="modalPrimary"]').click()

	await expect(page.locator('.global-notification')).toBeVisible()
	await expect(removeDialog).toBeVisible()
	await expect(row).toBeVisible()
})

test('shows a retry when the share list fails to load', async ({authenticatedPage: page}) => {
	await createProjects(1)
	let fail = true
	await page.route('**/projects/1/users*', route => fail && route.request().method() === 'GET'
		? route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'Internal Server Error'})})
		: route.fallback())

	await page.goto('/projects/1/settings/share')
	const section = page.getByRole('heading', {name: 'Shared with these users', exact: true}).locator('..')
	await expect(section.getByRole('alert')).toContainText('Couldn\'t check who this project is shared with.')
	await expect(section).not.toContainText('Not shared directly')
	fail = false
	await section.getByRole('button', {name: 'Retry'}).click()
	await expect(section).toContainText('Not shared directly with any users yet.')
})

test('duplicating a project does not copy its shares unless asked to', async ({authenticatedPage: page}) => {
	const [, other] = await UserFactory.create(2)
	await createProjects(1)
	await UserProjectFactory.create(1, {project_id: 1, user_id: other.id, permission: 1})

	await page.goto('/projects/1/settings/duplicate')
	const checkbox = page.getByRole('checkbox', {name: 'Share the copy the same way as the original'})
	await expect(checkbox).not.toBeChecked()
	await expect(page.getByText('1 person, no teams and no public links would also get access to the copy.')).toBeVisible()

	const duplicated = page.waitForResponse(response => /\/projects\/1\/duplicate$/.test(new URL(response.url()).pathname))
	await page.getByRole('button', {name: 'Duplicate', exact: true}).click()
	const request = (await duplicated).request()
	expect(request.postDataJSON().duplicate_shares).toBe(false)
})
