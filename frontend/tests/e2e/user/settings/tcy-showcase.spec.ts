import {test, expect} from '../../../support/fixtures'
import {setupApiUrl} from '../../../support/authenticateUser'
import {apiRootUrl} from '../../../support/apiUrl'

import {UserFactory} from '../../../factories/user'

test.use({currentUser: async ({apiContext}, use) => {
	const [user] = await UserFactory.create(1, {language: 'zh-CN'})
	await use(user)
}})

test('tcymc public page requires preview, keeps drafts private and can be withdrawn', async ({authenticatedPage: page, browser, baseURL}) => {
	await page.goto('/user/settings/showcase')
	await expect(page.getByRole('heading', {name: '公开主页', exact: true})).toBeVisible()
	await page.getByLabel('页面地址').fill('tcy-e2e-public')
	await page.getByLabel('页面标题').fill('我的公开日程')
	await page.getByPlaceholder('写一段介绍，或者使用模板占位符嵌入公开日程。').fill('# 自定义内容\n\n欢迎朋友关注我的安排。')
	await expect(page.getByRole('button', {name: '发布当前预览'})).toBeDisabled()
	await page.getByRole('button', {name: '预览公开效果'}).click()
	await expect(page.getByRole('heading', {name: '外人看到的效果'})).toBeVisible()
	await expect(page.frameLocator('iframe').getByRole('heading', {name: '自定义内容'})).toBeVisible()
	// An earlier spec may have published under another slug, and the link shows that until this
	// publish answers: wait for the request and the new address before visiting it.
	const published = page.waitForResponse(response =>
		new URL(response.url()).pathname.endsWith('/showcase/publish') && response.request().method() === 'POST')
	await page.getByRole('button', {name: '发布当前预览'}).click()
	expect((await published).ok()).toBe(true)
	const publicLink = page.getByRole('link', {name: '查看公开页面 ↗'})
	await expect(publicLink).toHaveAttribute('href', /\/p\/tcy-e2e-public$/)
	// Visitors get the configured frontend address, bots the API's JSON address.
	const href = await publicLink.getAttribute('href')
	expect(new URL(href!).origin).toBe(new URL(baseURL!).origin)
	const json = await page.getByRole('link', {name: '机器人 JSON 接口 ↗'}).getAttribute('href')
	expect(json).toBe(`${apiRootUrl(process.env.API_URL || 'http://127.0.0.1:3456')}/api/v2/public/tcy-e2e-public`)
	const guest = await browser.newContext({locale: 'zh-CN'})
	try {
		const visitor = await guest.newPage()
		await setupApiUrl(visitor)
		await visitor.goto(href!)
		await expect(visitor.getByRole('heading', {name: '我的公开日程'})).toBeVisible()
		await expect(visitor.getByRole('heading', {name: '可联系时间'})).toBeVisible()
		await expect(visitor.getByRole('link', {name: '-x 版'})).toBeVisible()
		await page.getByLabel('页面标题').fill('仅草稿可见')
		await page.getByRole('button', {name: '保存草稿'}).click()
		await expect(page.getByLabel('页面标题')).toHaveValue('仅草稿可见')
		await visitor.reload()
		await expect(visitor.getByRole('heading', {name: '我的公开日程'})).toBeVisible()
		// Taking the page down is immediate for visitors, so it asks first.
		await page.getByRole('button', {name: '撤下公开页面'}).click()
		const takeDown = page.getByRole('dialog', {name: '撤下你的公开主页？'})
		await expect(takeDown).toContainText('JSON 接口')
		await takeDown.locator('[data-cy="modalPrimary"]').click()
		await expect(page.getByText('尚未公开', {exact: true})).toBeVisible()
		await visitor.reload()
		await expect(visitor.getByRole('heading', {name: '页面未发布或暂时不可用'})).toBeVisible()
	} finally {
		await guest.close()
	}
})

test('tcymc public page asks before leaving with unsaved changes', async ({authenticatedPage: page}) => {
	await page.goto('/user/settings/showcase')
	await expect(page.getByRole('heading', {name: '公开主页', exact: true})).toBeVisible()
	await page.getByLabel('页面标题').fill('还没保存的标题')
	await expect(page.getByText('有未保存的更改')).toBeVisible()

	await page.locator('a[href="/user/settings/general"]').first().click()
	const leave = page.getByRole('dialog', {name: '不保存就离开？'})
	await expect(leave).toBeVisible()
	await leave.getByRole('button', {name: '留在此页'}).click()
	await expect(page).toHaveURL(/\/user\/settings\/showcase$/)
	await expect(page.getByLabel('页面标题')).toHaveValue('还没保存的标题')

	await page.locator('a[href="/user/settings/general"]').first().click()
	await page.getByRole('dialog', {name: '不保存就离开？'}).getByRole('button', {name: '放弃更改并离开'}).click()
	await expect(page).toHaveURL(/\/user\/settings\/general$/)
})

test('tcymc public page asks before replacing a written body with the template', async ({authenticatedPage: page}) => {
	await page.goto('/user/settings/showcase')
	const body = page.getByPlaceholder('写一段介绍，或者使用模板占位符嵌入公开日程。')
	await body.fill('<h1>我自己写的</h1>')
	await page.getByRole('button', {name: '插入日程模板'}).click()
	const replace = page.getByRole('dialog', {name: '用模板替换页面正文？'})
	await expect(replace).toBeVisible()
	await replace.getByRole('button', {name: '取消'}).click()
	await expect(body).toHaveValue('<h1>我自己写的</h1>')
})
