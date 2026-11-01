import {readFile} from 'node:fs/promises'
import {test, expect} from '../../support/fixtures'
import {TaskFactory} from '../../factories/task'
import {ProjectFactory} from '../../factories/project'
import {createProjects} from './prepareProjects'

test.describe('Projects', () => {
	test.use({
		// Use authenticated page for all tests
	})

	let projects: any[]

	test.beforeEach(async ({authenticatedPage}) => {
		projects = await createProjects()
	})

	test('Should create a new project', async ({authenticatedPage: page}) => {
		await page.goto('/projects')
		await page.waitForLoadState('networkidle')
		await page.locator('.action-buttons').getByRole('link', {name: /project/i}).click()
		await expect(page).toHaveURL(/\/projects\/new/)
		await expect(page.locator('.card-header-title')).toContainText('New project')
		await page.locator('input[name=projectTitle]').fill('New Project')
		await page.locator('.button').filter({hasText: 'Create'}).click()

		await expect(page.locator('.global-notification', {timeout: 1000})).toContainText('Success')
		await expect(page).toHaveURL(/\/projects\//)
		await expect(page.locator('.project-title')).toContainText('New Project')
	})

	test('Should redirect to a specific project view after visited', async ({authenticatedPage: page}) => {
		const projectId = projects[0].id
		const kanbanViewId = projects[0].views[3].id
		const loadBucketsPromise = page.waitForResponse(response =>
			response.url().includes(`/projects/${projectId}/`) &&
			response.url().includes('/views/') &&
			response.url().includes('/tasks'),
		)

		await page.goto(`/projects/${projectId}/${kanbanViewId}`)
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/${kanbanViewId}`))
		await loadBucketsPromise
		await page.goto(`/projects/${projectId}`)
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/${kanbanViewId}`))
	})

	// FIXME: seeding fails with error 500
	test('Should rename the project in all places', async ({authenticatedPage: page}) => {
		const projectId = projects[0].id
		const listViewId = projects[0].views[0].id
		await TaskFactory.create(5, {
			id: '{increment}',
			project_id: projectId,
		})
		const newProjectName = 'New project name'

		// Navigate to project and wait for redirect to view
		await page.goto(`/projects/${projectId}/${listViewId}`)
		await page.waitForLoadState('networkidle')
		await expect(page.locator('.project-title')).toContainText('First Project')

		// Click the project title dropdown and select Edit
		await page.locator('.project-title-dropdown .project-title-button').click()
		await page.getByRole('link', {name: /^edit$/i}).click()
		await page.waitForLoadState('networkidle')

		// Fill in the new name
		await page.locator('input#title').fill(newProjectName)
		await page.locator('footer.card-footer .button').filter({hasText: /^Save$/}).click()

		await expect(page.locator('.global-notification')).toContainText('Success')
		await expect(page.locator('.project-title')).toContainText(newProjectName)
		await expect(page.locator('.project-title')).not.toContainText(projects[0].title)
		await expect(page.locator('.menu-container .menu-list').getByRole('listitem').filter({hasText: newProjectName})).toBeVisible()
		await page.goto('/')
		await expect(page.locator('.recent-projects')).toContainText(newProjectName)
		await expect(page.locator('.recent-projects')).not.toContainText(projects[0].title)
	})

	test('Should remove a project when deleting it', async ({authenticatedPage: page}) => {
		const projectId = projects[0].id
		const listViewId = projects[0].views[0].id
		await page.goto(`/projects/${projectId}/${listViewId}`)
		await page.waitForLoadState('networkidle')

		await page.locator('.project-title-dropdown .project-title-button').click()
		await page.getByRole('link', {name: /^delete$/i}).click()
		await page.waitForLoadState('networkidle')

		await expect(page).toHaveURL(/\/settings\/delete/)
		// The confirm button names the action.
		await page.getByRole('dialog').getByRole('button', {name: 'Delete', exact: true}).click()

		await expect(page.locator('.global-notification')).toContainText('Success')
		await expect(page).toHaveURL('/')
		await expect(page.getByRole('link', {name: projects[0].title})).not.toBeVisible()
	})

	// Opened directly, the dialog is the first history entry, so there is nothing to go back to.
	test('Should close a directly opened edit dialog on cancel', async ({authenticatedPage: page}) => {
		const projectId = projects[0].id
		await page.goto(`/projects/${projectId}/settings/edit`)

		const dialog = page.getByRole('dialog', {name: 'Edit This Project'})
		await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()

		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/\\d+$`))
		await expect(dialog).toHaveCount(0)
	})

	test('Asks before Cancel or Escape drop typed changes in the edit dialog', async ({authenticatedPage: page}) => {
		const projectId = projects[0].id
		await page.goto(`/projects/${projectId}/settings/edit`)

		const dialog = page.getByRole('dialog', {name: 'Edit This Project'})
		await dialog.locator('input#title').fill('Typed but not saved')
		await page.keyboard.press('Escape')

		const question = page.getByRole('dialog', {name: 'Leave without saving?'})
		await expect(question).toBeVisible()
		await question.getByRole('button', {name: 'Keep editing'}).click()
		await expect(question).toHaveCount(0)
		await expect(dialog.locator('input#title')).toHaveValue('Typed but not saved')

		await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()
		await question.getByRole('button', {name: 'Discard and leave'}).click()
		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/\\d+$`))
		await expect(dialog).toHaveCount(0)
	})

	test('Should close a directly opened edit dialog after saving', async ({authenticatedPage: page}) => {
		const projectId = projects[0].id
		await page.goto(`/projects/${projectId}/settings/edit`)

		const dialog = page.getByRole('dialog', {name: 'Edit This Project'})
		await dialog.locator('input#title').fill('Renamed directly')
		await dialog.getByRole('button', {name: 'Save', exact: true}).click()

		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/\\d+$`))
		await expect(dialog).toHaveCount(0)
		await expect(page.locator('.project-title')).toContainText('Renamed directly')
	})

	test('Should keep the project when cancelling a directly opened delete dialog', async ({authenticatedPage: page, apiContext, userToken}) => {
		const projectId = projects[0].id
		await page.goto(`/projects/${projectId}/settings/delete`)

		const dialog = page.getByRole('dialog', {name: 'Delete this project'})
		await dialog.getByRole('button', {name: 'Cancel', exact: true}).click()

		await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/\\d+$`))
		await expect(dialog).toHaveCount(0)
		const response = await apiContext.get(`projects/${projectId}`, {
			headers: {Authorization: `Bearer ${userToken}`},
		})
		expect(response.ok()).toBe(true)
	})

	test('Should archive a project', async ({authenticatedPage: page}) => {
		const projectId = projects[0].id
		const listViewId = projects[0].views[0].id
		await page.goto(`/projects/${projectId}/${listViewId}`)
		await page.waitForLoadState('networkidle')

		await page.locator('.project-title-dropdown .project-title-button').click()
		await page.getByRole('link', {name: /^archive$/i}).click()
		await expect(page.locator('dialog[open] .modal-content')).toContainText('Archive this project')
		await page.getByRole('dialog').getByRole('button', {name: 'Archive', exact: true}).click()

		await expect(page.locator('.global-notification')).toContainText('Success')
		await expect(page.locator('main.app-content')).toContainText('This project is archived. It is not possible to create new or edit tasks for it.')
	})

	test('Should upload and remove a project background without stale previews', async ({authenticatedPage: page}) => {
		const project = projects[0]
		const background = page.locator('.app-container-background')
		const card = page.locator('.project-card').filter({has: page.getByRole('link', {name: project.title, exact: true})})

		async function openBackgroundSettings() {
			await page.locator('.project-title-dropdown .project-title-button').click()
			await page.locator(`a[href="/projects/${project.id}/settings/background"]`).click()
			await expect(page.locator('.project-background-setting')).toBeVisible()
		}

		await page.goto(`/projects/${project.id}/${project.views[0].id}`)
		await expect(page.locator('.project-title')).toContainText(project.title)
		await openBackgroundSettings()
		const upload = page.waitForResponse(response =>
			new URL(response.url()).pathname.endsWith(`/projects/${project.id}/backgrounds/upload`) &&
			response.request().method() === 'PUT',
		)
		await page.locator('.project-background-setting input[type="file"]').setInputFiles({
			name: 'image-blue.png',
			mimeType: 'image/png',
			buffer: await readFile('tests/fixtures/image-blue.png'),
		})
		await page.getByRole('dialog', {name: 'Choose how to upload images'}).getByRole('button', {name: 'Upload images', exact: true}).click()
		expect((await upload).ok()).toBe(true)
		await expect(background).toHaveClass(/is-visible/)
		await expect(background).toHaveCSS('background-image', /url\(/)
		await page.locator('.project-background-setting footer.card-footer').getByRole('button', {name: 'Close', exact: true}).click()
		// Closing navigates back; reload only once that navigation has finished.
		await expect(page.locator('.project-background-setting')).toBeHidden()
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/\\d+$`))

		await page.reload()
		await expect(background).toHaveClass(/is-visible/)
		await expect(background).toHaveCSS('background-image', /url\(/)
		await page.goto('/projects')
		await expect(card.locator('.project-background')).toHaveCSS('background-image', /url\(/)

		await card.getByRole('link', {name: project.title, exact: true}).click()
		await openBackgroundSettings()
		const removal = page.waitForResponse(response =>
			new URL(response.url()).pathname.endsWith(`/projects/${project.id}/background`) &&
			response.request().method() === 'DELETE',
		)
		await page.getByRole('button', {name: 'Remove Background', exact: true}).click()
		expect((await removal).ok()).toBe(true)
		await expect(background).not.toHaveClass(/is-visible/)
		await expect(background).toHaveCSS('background-image', 'none')
		// A successful removal closes the settings by navigating back.
		await expect(page.locator('.project-background-setting')).toBeHidden()
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/\\d+$`))

		await page.reload()
		await expect(page.locator('.project-title')).toContainText(project.title)
		await expect(background).toHaveCSS('background-image', 'none')
		await page.goto('/projects')
		await expect(card).not.toHaveClass(/has-background/)
		await expect(card.locator('.project-background')).toHaveCSS('background-image', 'none')
	})

	test('Should show all projects on the projects page', async ({authenticatedPage: page}) => {
		const projects = await ProjectFactory.create(10)

		await page.goto('/projects')
		await page.waitForLoadState('networkidle')

		for (const p of projects) {
			await expect(page.locator('.project-grid')).toContainText(p.title)
		}
	})

	test('Should hide archived projects unless the status filter includes them', async ({authenticatedPage: page}) => {
		await ProjectFactory.create(1, {
			id: 2,
			title: 'Visible active project',
		}, false)
		await ProjectFactory.create(1, {
			id: 3,
			title: 'Hidden archived project',
			is_archived: true,
		}, false)
		const grid = page.locator('.project-grid')
		const statusFilter = page.getByRole('group', {name: 'Project status', exact: true})

		await page.goto('/projects')
		await expect(grid).toContainText('Visible active project')
		await expect(grid).not.toContainText('Hidden archived project')
		await expect(grid).not.toContainText('Archived')
		await expect(statusFilter.getByRole('button', {name: /^Active/})).toHaveAttribute('aria-pressed', 'true')

		await statusFilter.getByRole('button', {name: /^Archived/}).click()
		await expect(statusFilter.getByRole('button', {name: /^Archived/})).toHaveAttribute('aria-pressed', 'true')
		await expect(grid).toContainText('Hidden archived project')
		await expect(grid).toContainText('Archived')
		await expect(grid).not.toContainText('Visible active project')

		await statusFilter.getByRole('button', {name: /^All/}).click()
		await expect(grid).toContainText('Visible active project')
		await expect(grid).toContainText('Hidden archived project')

		// The choice is stored, so it survives a reload.
		await page.reload()
		await expect(statusFilter.getByRole('button', {name: /^All/})).toHaveAttribute('aria-pressed', 'true')
		await expect(grid).toContainText('Hidden archived project')

		await statusFilter.getByRole('button', {name: /^Active/}).click()
		await page.reload()
		await expect(statusFilter.getByRole('button', {name: /^Active/})).toHaveAttribute('aria-pressed', 'true')
		await expect(grid).toContainText('Visible active project')
		await expect(grid).not.toContainText('Hidden archived project')
	})

	test('Should filter by status and search and fit a phone screen', async ({authenticatedPage: page}, testInfo) => {
		const now = new Date().toISOString()
		await ProjectFactory.create(1, {
			id: 2,
			title: 'Weekly groceries',
			parent_project_id: projects[0].id,
		}, false)
		await ProjectFactory.create(1, {
			id: 3,
			title: 'Finished garden plan',
			identifier: 'GRDN',
			is_completed: true,
			completed_at: now,
		}, false)
		await ProjectFactory.create(1, {
			id: 4,
			title: 'Old tax papers',
			is_archived: true,
		}, false)
		const grid = page.locator('.project-grid')
		const cards = page.locator('.project-grid .project-card')
		const statusFilter = page.getByRole('group', {name: 'Project status', exact: true})
		const statusButton = (name: string) => statusFilter.getByRole('button', {name: new RegExp(`^${name}`)})
		const search = page.getByRole('searchbox', {name: 'Search projects', exact: true})
		const cardFor = (title: string) => page.locator('.project-card')
			.filter({has: page.getByRole('link', {name: title, exact: true})})

		await page.goto('/projects')
		await expect(statusButton('Active')).toHaveAttribute('aria-pressed', 'true')
		await expect(cards).toHaveCount(2)
		await expect(grid).toContainText('First Project')
		await expect(grid).toContainText('Weekly groceries')
		await expect(cardFor('Weekly groceries')).toContainText('First Project')
		await expect(statusButton('Active').locator('.segment-count')).toHaveText('2')
		await expect(statusButton('Completed').locator('.segment-count')).toHaveText('1')
		await expect(statusButton('Archived').locator('.segment-count')).toHaveText('1')
		await expect(statusButton('All').locator('.segment-count')).toHaveText('4')

		await statusButton('Completed').click()
		await expect(cards).toHaveCount(1)
		await expect(cardFor('Finished garden plan').getByText('Completed', {exact: true})).toBeVisible()

		await statusButton('All').click()
		await expect(cards).toHaveCount(4)
		await search.fill('grdn')
		await expect(cards).toHaveCount(1)
		await expect(grid).toContainText('Finished garden plan')

		await statusButton('Active').click()
		await search.fill('tax')
		await expect(page.getByText('No projects match the current search and status.')).toBeVisible()
		await page.getByRole('button', {name: 'Clear Filters', exact: true}).click()
		await expect(search).toHaveValue('')
		await expect(statusButton('All')).toHaveAttribute('aria-pressed', 'true')
		await expect(cards).toHaveCount(4)

		await page.setViewportSize({width: 320, height: 800})
		// Reload so the page starts in its phone layout with the mobile menu closed.
		await page.reload()
		await expect(statusButton('All')).toHaveAttribute('aria-pressed', 'true')
		await expect(cards).toHaveCount(4)
		const cardLefts = await cards.evaluateAll(elements => elements
			.map(element => Math.round(element.getBoundingClientRect().left)))
		expect(new Set(cardLefts).size).toBe(1)
		const sizes = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			viewport: window.innerWidth,
		}))
		expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.viewport)
		await page.screenshot({
			path: testInfo.outputPath('projects-320.png'),
			fullPage: true,
			animations: 'disabled',
		})
	})
})

test.describe('Projects page states', () => {
	test('Should welcome an account without projects once loading finishes', async ({authenticatedPage: page}) => {
		await page.goto('/projects')
		const hint = page.locator('[data-empty="no-projects"]')
		await expect(hint).toContainText('No projects yet')
		await expect(page.getByText('No projects match the current search and status.')).toHaveCount(0)
		await expect(page.getByRole('group', {name: 'Project status', exact: true})).toHaveCount(0)
		await hint.getByRole('link', {name: 'New project'}).click()
		await expect(page).toHaveURL(/\/projects\/new/)
	})

	test('Should explain why completed and archived counts overlap', async ({authenticatedPage: page}) => {
		await ProjectFactory.create(1, {
			id: 1,
			title: 'Closed and stored',
			is_completed: true,
			completed_at: new Date().toISOString(),
			is_archived: true,
		})
		await page.goto('/projects')
		const statusFilter = page.getByRole('group', {name: 'Project status', exact: true})
		const count = (name: string) => statusFilter
			.getByRole('button', {name: new RegExp(`^${name}`)})
			.locator('.segment-count')
		await expect(count('Completed')).toHaveText('1')
		await expect(count('Archived')).toHaveText('1')
		await expect(count('All')).toHaveText('1')
		await expect(page.locator('.project-list-help')).toContainText('both completed and archived')
	})
})
