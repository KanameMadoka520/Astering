import {test, expect} from '../../support/fixtures'
import {TeamFactory} from '../../factories/team'
import {TeamMemberFactory} from '../../factories/team_member'
import {TeamProjectFactory} from '../../factories/team_project'
import {UserFactory} from '../../factories/user'
import {createProjects} from '../project/prepareProjects'
import {login, setupApiUrl} from '../../support/authenticateUser'
import {serverPageSize} from '../../support/pagination'
import {createCompassSpace} from '../compass/compassApi'

test.describe('Team', () => {
	test('Creates a new team', async ({authenticatedPage: page}) => {
		await page.goto('/teams')
		// Both pages say up front that a team on its own shares nothing.
		const sharesNothing = 'Creating one shares nothing; you choose which projects and Compass spaces to share with it.'
		await expect(page.locator('.page-header__description')).toContainText(sharesNothing)

		const newTeamName = 'New Team'

		await page.locator('a.button').filter({hasText: 'Create a team'}).click()
		await expect(page).toHaveURL(/\/teams\/new/)
		await expect(page.getByText(sharesNothing)).toBeVisible()
		await expect(page.locator('.card-header-title')).toContainText('Create a team')
		await page.locator('input.input').fill(newTeamName)
		await page.locator('.button').filter({hasText: 'Create'}).click()

		await expect(page).toHaveURL(/\/edit/)
		await expect(page.locator('input#teamtext')).toHaveValue(newTeamName)
	})

	test('Shows all teams', async ({authenticatedPage: page}) => {
		await TeamMemberFactory.create(10, {
			team_id: '{increment}',
		})
		const teams = await TeamFactory.create(10, {
			id: '{increment}',
		})

		await page.goto('/teams')

		await expect(page.locator('ul.teams')).not.toBeEmpty()
		for (const t of teams) {
			await expect(page.locator('ul.teams')).toContainText(t.name)
		}
	})

	test('Paginates the team list', async ({authenticatedPage: page, apiContext}) => {
		const pageSize = await serverPageSize(apiContext)
		await TeamMemberFactory.create(pageSize + 5, {
			team_id: '{increment}',
		})
		const teams = await TeamFactory.create(pageSize + 5, {
			id: '{increment}',
			name: (i: number) => `paged team ${i}`,
		})
		const rows = page.locator('ul.teams li')

		await page.goto('/teams')
		await expect(rows).toHaveCount(pageSize)
		const firstPage = await rows.allTextContents()

		await page.getByRole('link', {name: 'Goto page 2'}).click()
		await expect(page).toHaveURL(/[?&]page=2/)
		await expect(rows).toHaveCount(5)
		const secondPage = await rows.allTextContents()

		expect([...firstPage, ...secondPage].map(name => name.trim()).sort())
			.toEqual(teams.map(team => team.name).sort())

		await page.reload()
		await expect(rows).toHaveCount(5)

		await page.goto('/teams?page=99')
		await expect(page).toHaveURL(/[?&]page=2(&|$)/)
		await expect(rows).toHaveCount(5)
	})

	test('Allows an admin to edit the team', async ({authenticatedPage: page}) => {
		await TeamMemberFactory.create(1, {
			team_id: 1,
			admin: true,
		})
		await TeamFactory.create(1, {
			id: 1,
		})

		await page.goto('/teams/1/edit')
		await page.locator('.card input.input').first().fill('New Team Name')

		await page.locator('.card .button').filter({hasText: 'Save'}).click()

		await expect(page.getByRole('cell', {name: 'Admin', exact: true})).toBeVisible()
		await expect(page.locator('.global-notification')).toContainText('Success')
		await page.reload()
		await expect(page.locator('input#teamtext')).toHaveValue('New Team Name')
	})

	test('Does not carry an unsaved draft over to another team', async ({authenticatedPage: page}) => {
		await TeamMemberFactory.create(2, {
			team_id: '{increment}',
			admin: true,
		})
		const [firstTeam, secondTeam] = await TeamFactory.create(2, {
			id: '{increment}',
		})

		await page.goto(`/teams/${firstTeam.id}/edit`)
		await expect(page.locator('input#teamtext')).toHaveValue(firstTeam.name)
		await page.locator('.menu-container').getByRole('link', {name: 'Teams'}).click()
		await page.locator('ul.teams').getByRole('link', {name: secondTeam.name, exact: true}).click()
		await expect(page.locator('input#teamtext')).toHaveValue(secondTeam.name)
		await page.locator('input#teamtext').fill('Unsaved team name')

		// Jump straight between the two edit pages so the view instance is reused.
		await page.evaluate(() => history.go(-2))
		await expect(page).toHaveURL(new RegExp(`/teams/${firstTeam.id}/edit`))
		await expect(page.locator('input#teamtext')).toHaveValue(firstTeam.name)
	})

	test('Does not allow a normal user to edit the team', async ({authenticatedPage: page}) => {
		await TeamMemberFactory.create(1, {
			team_id: 1,
			admin: false,
		})
		const [otherUser] = await UserFactory.create(1, {id: 2}, false)
		await TeamMemberFactory.create(1, {
			team_id: 1,
			user_id: otherUser.id,
			admin: false,
		}, false)
		await TeamFactory.create(1, {
			id: 1,
		})

		await page.goto('/teams/1/edit')
		await expect(page.locator('.card input.input')).not.toBeVisible()
		await expect(page.locator('table.table tr').filter({hasText: otherUser.username})).toBeVisible()
		await expect(page.locator('table.table td').filter({hasText: 'Member'})).toHaveCount(2)
		await expect(page.getByRole('button', {name: 'Make Admin', exact: true})).toHaveCount(0)
		await expect(page.getByRole('button', {name: 'Remove a user from the team'})).toHaveCount(0)
		await expect(page.locator('.card-content .multiselect')).toHaveCount(0)
	})

	test('Allows an admin to add members to the team', async ({authenticatedPage: page}) => {
		await TeamMemberFactory.create(1, {
			team_id: 1,
			admin: true,
		})
		await TeamFactory.create(1, {
			id: 1,
		})
		const users = await UserFactory.create(5)

		await page.goto('/teams/1/edit')
		const teamMembersCard = page.locator('.card').filter({hasText: 'Team Members'})
		const multiselect = teamMembersCard.locator('.card-content .multiselect')
		const input = multiselect.locator('.input-wrapper input')

		// Use the full username because the /users endpoint requires exact match
		// Use type/pressSequentially instead of fill to properly trigger Vue's input events
		await input.click()
		await input.pressSequentially(users[1].username, {delay: 10})

		// Wait for search results to appear (there's a 200ms debounce in the multiselect)
		await expect(multiselect.locator('.search-results')).toBeVisible({timeout: 5000})
		await expect(multiselect.locator('.search-results').locator('> *').first()).toContainText(users[1].username)
		await multiselect.locator('.search-results').locator('> *').first().click()
		await page.locator('input#teamtext').fill('Unsaved team name')
		await teamMembersCard.locator('.card-content .button').filter({hasText: 'Add to team'}).click()

		await expect(page.getByRole('cell', {name: 'Admin', exact: true})).toBeVisible()
		// Find the row containing the new member's username
		const newMemberRow = page.locator('table.table tr').filter({hasText: users[1].username})
		await expect(newMemberRow).toBeVisible()
		await expect(newMemberRow).toContainText('Member')
		await expect(page.locator('input#teamtext')).toHaveValue('Unsaved team name')
		await newMemberRow.getByRole('button', {name: 'Make Admin', exact: true}).click()
		// Making someone an admin hands them the team, so it asks first.
		const promoteDialog = page.getByRole('dialog', {name: `Make ${users[1].username} an admin?`})
		await promoteDialog.locator('[data-cy="modalPrimary"]').click()
		await expect(promoteDialog).toHaveCount(0)
		await expect(newMemberRow.getByRole('cell', {name: 'Admin', exact: true})).toBeVisible()
		await page.reload()
		await expect(newMemberRow.getByRole('cell', {name: 'Admin', exact: true})).toBeVisible()
		await newMemberRow.getByRole('button', {name: 'Remove a user from the team'}).click()
		await page.getByRole('dialog', {name: new RegExp(`^Remove ${users[1].username} from `)})
			.locator('[data-cy="modalPrimary"]').click()
		await expect(newMemberRow).toHaveCount(0)
		await expect(page.locator('.global-notification')).toContainText('Success')
	})

	test('Names the Compass spaces that are deleted with the team', async ({authenticatedPage: page, apiContext, userToken, currentUser}) => {
		await TeamFactory.create(1, {id: 1, name: 'Night Watch', created_by_id: currentUser.id})
		await TeamMemberFactory.create(1, {team_id: 1, user_id: currentUser.id, admin: true})
		await createCompassSpace(apiContext, userToken, {title: 'Watch log', team_id: 1})
		await createCompassSpace(apiContext, userToken, {title: 'Private harbour'})

		await page.goto('/teams/1/edit')
		await page.getByRole('button', {name: 'Delete the team'}).click()
		const dialog = page.getByRole('dialog', {name: 'Delete “Night Watch”?'})
		await expect(dialog).toContainText('Every Compass space that belongs to this team is deleted permanently with it')
		await expect(dialog).toContainText('Spaces you can open that would be deleted:')
		await expect(dialog).toContainText('Watch log')
		await expect(dialog).not.toContainText('Private harbour')
		await expect(dialog).toContainText('Members keep their accounts.')
		await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()
		await expect(dialog).toHaveCount(0)
	})

	test('Keeps the delete dialog open when deleting the team fails', async ({authenticatedPage: page}) => {
		await TeamMemberFactory.create(1, {team_id: 1, admin: true})
		await TeamFactory.create(1, {id: 1, name: 'Night Watch'})
		await page.route('**/teams/1', route => route.request().method() === 'DELETE'
			? route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'Internal Server Error'})})
			: route.fallback())

		await page.goto('/teams/1/edit')
		await page.getByRole('button', {name: 'Delete the team'}).click()
		const dialog = page.getByRole('dialog', {name: 'Delete “Night Watch”?'})
		// Nothing is sent before the permanent Compass deletion is acknowledged.
		await dialog.locator('[data-cy="modalPrimary"]').click()
		await expect(dialog.getByRole('alert')).toContainText('Tick the box above to confirm.')
		await dialog.getByText('I understand that the team\'s Compass spaces').click()
		await dialog.locator('[data-cy="modalPrimary"]').click()
		await expect(page.locator('.global-notification')).toBeVisible()
		await expect(dialog).toBeVisible()
		await expect(page).toHaveURL(/\/teams\/1\/edit/)
	})

	test('Offers deleting instead of leaving to the only member', async ({authenticatedPage: page}) => {
		await TeamMemberFactory.create(1, {team_id: 1, admin: true})
		await TeamFactory.create(1, {id: 1})

		await page.goto('/teams/1/edit')
		await expect(page.getByText('You\'re the only member of this team. To leave it, delete the team.')).toBeVisible()
		await expect(page.getByRole('button', {name: 'Leave team'})).toHaveCount(0)
	})

	test('Clears member search results when the search input is cleared', async ({authenticatedPage: page}) => {
		await TeamMemberFactory.create(1, {
			team_id: 1,
			admin: true,
		})
		await TeamFactory.create(1, {
			id: 1,
		})
		const [user] = await UserFactory.create(1, {id: 100}, false)

		await page.goto('/teams/1/edit')
		const multiselect = page.locator('.card').filter({hasText: 'Team Members'}).locator('.card-content .multiselect')
		const input = multiselect.locator('.input-wrapper input')

		await input.click()
		await input.pressSequentially(user.username, {delay: 10})
		await expect(multiselect.locator('.search-result-button').filter({hasText: user.username})).toBeVisible({timeout: 5000})

		// Backspace fires the keyup the multiselect searches on; fill('') would not.
		await input.press('ControlOrMeta+a')
		await input.press('Backspace')
		await expect(input).toHaveValue('')
		await expect(multiselect.locator('.search-results')).toHaveCount(0)
	})
})

test.describe('Team permission tiers on shared projects', () => {
	// These tests log in as the second user (the team member), so we can't use
	// the `authenticatedPage` fixture which auto-logs in as user 1.
	test.beforeEach(async ({page}) => {
		await setupApiUrl(page)
	})

	test('READ: team member cannot add tasks on a shared project', async ({page, apiContext}) => {
		const [, member] = await UserFactory.create(2)
		await createProjects(1)
		await TeamFactory.create(1, {id: 1, created_by_id: 1}, false)
		await TeamMemberFactory.create(1, {team_id: 1, user_id: member.id, admin: false}, false)
		await TeamProjectFactory.create(1, {team_id: 1, project_id: 1, permission: 0}, false)

		await login(page, apiContext, member)
		await page.goto('/projects/1/1')

		await expect(page.locator('.project-title')).toContainText('First Project')
		await expect(page.locator('input.input[placeholder="Add a task…"]')).not.toBeVisible()
	})

	test('READ_WRITE: team member can add tasks on a shared project', async ({page, apiContext}) => {
		const [, member] = await UserFactory.create(2)
		await createProjects(1)
		await TeamFactory.create(1, {id: 1, created_by_id: 1}, false)
		await TeamMemberFactory.create(1, {team_id: 1, user_id: member.id, admin: false}, false)
		await TeamProjectFactory.create(1, {team_id: 1, project_id: 1, permission: 1}, false)

		await login(page, apiContext, member)
		await page.goto('/projects/1/1')

		await expect(page.locator('.project-title')).toContainText('First Project')
		await expect(page.locator('.task-add textarea')).toBeVisible()
	})

	test('owner can revoke team share and member loses access', async ({page, apiContext}) => {
		const [owner, member] = await UserFactory.create(2)
		await createProjects(1)
		const [team] = await TeamFactory.create(1, {id: 1, name: 'Shared Team', created_by_id: owner.id}, false)
		await TeamMemberFactory.create(1, {team_id: team.id, user_id: owner.id, admin: true}, false)
		await TeamMemberFactory.create(1, {team_id: team.id, user_id: member.id, admin: false}, false)
		await TeamProjectFactory.create(1, {team_id: team.id, project_id: 1, permission: 1}, false)

		// Sanity check: member can see the project before revocation.
		await login(page, apiContext, member)
		await page.goto('/projects/1/1')
		await expect(page.locator('.project-title')).toContainText('First Project')

		// Owner opens the share settings and removes the team.
		await login(page, apiContext, owner)
		await page.goto('/projects/1/settings/share')

		const teamSection = page.getByRole('heading', {name: 'Shared with these teams', exact: true}).locator('..')
		const teamRow = teamSection.getByRole('row').filter({hasText: team.name})
		await expect(teamRow).toBeVisible()
		await teamRow.getByRole('button', {name: 'Remove this team'}).click()

		const deleteRequest = page.waitForResponse(r =>
			r.url().includes('/projects/1/teams/') && r.request().method() === 'DELETE',
		)
		await page.getByRole('dialog', {name: `Remove ${team.name}?`})
			.locator('[data-cy="modalPrimary"]').click()
		await deleteRequest

		await expect(teamRow).toHaveCount(0)

		// Member can no longer open the project: the API returns a permission
		// error and the frontend never renders the project title.
		await login(page, apiContext, member)
		const projectResponse = page.waitForResponse(r =>
			new URL(r.url()).pathname.endsWith('/projects/1') && r.request().method() === 'GET',
		)
		await page.goto('/projects/1/1')
		const resp = await projectResponse
		expect(resp.status()).toBeGreaterThanOrEqual(400)
		await expect(page.locator('.project-title').filter({hasText: 'First Project'})).toHaveCount(0)
	})
})
