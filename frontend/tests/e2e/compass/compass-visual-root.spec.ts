import {test, expect} from '../../support/fixtures'
import {ProjectFactory} from '../../factories/project'
import {ProjectViewFactory} from '../../factories/project_view'
import {updateUserSettings} from '../../support/updateUserSettings'
import {createCompassSpace, createCompassEntry} from './compassApi'

test('Compass reading and writing fit desktop and phones in both themes', async ({authenticatedPage: page, apiContext, userToken}, testInfo) => {
	test.setTimeout(120_000)
	const errors: string[] = []
	page.on('pageerror', error => errors.push(error.message))
	await ProjectFactory.create(1, {id: 1, title: 'Previous project'})
	await ProjectViewFactory.create(1, {id: 1, project_id: 1, title: 'List', view_kind: 0})
	const space = await createCompassSpace(apiContext, userToken, {
		title: '远行手记 · 测试空间', motto: '把值得记住的事情写下来，给下一段路留一束光。',
		introduction: '<p>这是浏览器验证使用的演示文字。记录研究中的问题、选择与变化，给回顾留出空间。</p>',
	})
	const entry = await createCompassEntry(apiContext, userToken, space.id, {
		title: '在长期研究中保持清晰', kind: 'principle', pinned: true,
		subtitle: '一篇用于检查阅读体验的演示文章', quote: '让文字承载经验，也留下重新思考的余地。',
		category: '研究与创造', tags: ['长期记录', '阅读体验'],
		content: '<h2>记下出发点</h2><p>一个问题值得认真研究，也值得把当时的判断完整留下。文字不必急着总结，可以先保存观察，再回来整理。</p><h2>给复杂问题留出时间</h2><p>将不同阶段的想法分开记录，重新阅读时便能看见理解如何发生变化。</p><blockquote>这是一段演示引语，用来检查长文的留白和排版。</blockquote><h3>记录证据</h3><ul><li>观察到了什么</li><li>哪些假设需要重新验证</li><li>接下来准备尝试什么</li></ul><pre><code>' + 'long_research_reference_'.repeat(20) + '</code></pre><table><tbody><tr><th>阶段</th><th>记录</th></tr><tr><td>观察</td><td>' + '连续文字'.repeat(50) + '</td></tr></tbody></table>',
	})
	await createCompassEntry(apiContext, userToken, space.id, {title: '一个新的问题', kind: 'memory', content: '<p>保持好奇，留下一份清晰的记录。</p>', category: '旅途'})
	await page.emulateMedia({reducedMotion: 'reduce'})
	for (const theme of ['light', 'dark'] as const) {
		await updateUserSettings(apiContext, userToken, {language: 'zh-CN', frontend_settings: {color_schema: theme}})
		await page.emulateMedia({colorScheme: theme})
		for (const width of [1280, 390, 320]) {
			await page.setViewportSize({width, height: 900})
			await page.goto(`/compass/spaces/${space.id}`)
			await expect(page.locator('.compass-library')).toBeVisible()
			await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
			await expect(page.locator('.compass-library')).toContainText('一个新的问题')
			expect(await page.evaluate(() => ({
				width: innerWidth,
				scroll: document.documentElement.scrollWidth,
				overflow: Array.from(document.querySelectorAll('body *')).filter(element => {
					const rect = element.getBoundingClientRect()
					return rect.width > 0 && rect.right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed'
				}).slice(0, 12).map(element => ({tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right})),
			}))).toMatchObject({scroll: width})
			await page.screenshot({path: testInfo.outputPath(`space-${theme}-${width}.png`)})
			await page.goto(`/compass/entries/${entry.id}`)
			await expect(page.locator('.compass-prose')).toContainText('记下出发点')
			expect(await page.evaluate(() => ({
				width: innerWidth,
				scroll: document.documentElement.scrollWidth,
				overflow: Array.from(document.querySelectorAll('body *')).filter(element => {
					const rect = element.getBoundingClientRect()
					return rect.width > 0 && rect.right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed'
				}).slice(0, 12).map(element => ({tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right})),
			}))).toMatchObject({scroll: width})
			await page.screenshot({path: testInfo.outputPath(`reader-${theme}-${width}.png`)})
			await page.goto(`/compass/entries/${entry.id}/edit`)
			await expect(page.locator('.compass-desk .ProseMirror[contenteditable=true]')).toBeVisible()
			expect(await page.evaluate(() => ({
				width: innerWidth,
				scroll: document.documentElement.scrollWidth,
				overflow: Array.from(document.querySelectorAll('body *')).filter(element => {
					const rect = element.getBoundingClientRect()
					return rect.width > 0 && rect.right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed'
				}).slice(0, 12).map(element => ({tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right})),
			}))).toMatchObject({scroll: width})
			await page.screenshot({path: testInfo.outputPath(`editor-${theme}-${width}.png`)})
		}
	}
	await page.setViewportSize({width: 1280, height: 900})
	await page.goto(`/compass/entries/${entry.id}`)
	await expect(page.locator('.compass-prose')).toContainText('记下出发点')
	await page.emulateMedia({media: 'print'})
	await expect(page.locator('.navbar')).toBeHidden()
	await expect(page.locator('.compass-prose')).toBeVisible()
	await expect(page.locator('.compass-prose pre')).toHaveCSS('white-space', 'pre-wrap')
	await page.pdf({path: testInfo.outputPath('compass-reading.pdf'), format: 'A4', printBackground: true, margin: {top: '16mm', right: '16mm', bottom: '16mm', left: '16mm'}})
	await page.emulateMedia({media: 'screen'})
	await page.goto('/projects/1/1')
	await expect(page.locator('.navbar .project-title')).toHaveText('Previous project')
	await page.locator('[data-tour="nav-compass"]').click()
	await expect(page.locator('.compass-library')).toBeVisible()
	await expect(page.locator('.navbar .project-title')).not.toHaveText('Previous project')
	await expect(page.locator('.navbar .project-title-dropdown')).toHaveCount(0)
	expect(errors).toEqual([])
})
