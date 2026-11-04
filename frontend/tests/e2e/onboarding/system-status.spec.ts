import {test, expect} from '../../support/fixtures'

for (const width of [1440, 390]) {
 test(`sidebar resource status ${width}px displays host load and failed refresh`, async ({authenticatedPage: page}, testInfo) => {
  await page.setViewportSize({width, height: 844})
  let fail = false
  await page.route('**/api/v2/system/status', route => route.fulfill(fail ? {status: 503, json: {message: 'offline'}} : {json: {
   version: 'v2.7.1-aster.50', started: new Date().toISOString(), sampled: new Date().toISOString(), uptime_seconds: 90061, healthy: true, scope: 'host', host_metrics_available: true, host_uptime_seconds: 180122, load_average: [1.25, 0.75, 0.5], cpu_io_wait_percent: 2, cpu_steal_percent: 0,
   application: {cpu_percent: 150.2, cpu_cores: 8, gpu_status: 'not_assigned', memory_used: 104857600, storage: {files_bytes: 1048576, database_bytes: 2097152, sampled: new Date().toISOString()}},
   cpu_percent: 12.5, cpu_cores: 4,  memory_used: 1073741824, memory_total: 4294967296,  disk_used: 10737418240, disk_total: 107374182400,
  }}))
  await page.goto('/ai')
  if (!await page.locator('.menu-container').evaluate(el => el.classList.contains('is-active'))) await page.locator('button.menu-show-button:visible').click()
  const status = page.getByRole('region', {name: 'Server load'})
  await status.scrollIntoViewIfNeeded()
  await expect(status).toContainText('12.5%')
  await expect(status).toContainText('150.2%')
  await expect(status).toContainText('No GPU assigned')
  await expect(status).toContainText('3.0 MiB')
  await expect(status).toContainText('25.0%')
  await expect(status).toContainText('10.0%')
  await expect(status).toContainText('1d 1h 1m')
  await expect(status.getByRole('link')).toHaveAttribute('href', /releases\/tag\/v2.7.1-aster.50$/)
  await status.getByText('How these numbers are measured').click()
  await expect(status).toContainText('1.25 / 0.75 / 0.50')
  await expect(status).toContainText('Server uptime: 2d 2h 2m')
  await expect(status).toContainText('all applications, not only Astering')
  await expect(status).toContainText('separately mounted disks are not summed')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({path: testInfo.outputPath(`system-status-${width}.png`)})
  fail = true
  await page.reload()
  if (!await page.locator('.menu-container').evaluate(el => el.classList.contains('is-active'))) await page.locator('button.menu-show-button:visible').click()
  await status.scrollIntoViewIfNeeded()
  await expect(status).toContainText('Disconnected')
  fail = false
  await status.getByRole('button', {name: 'try again', exact: true}).click()
  await expect(status).toContainText('Astering healthy')
 })
}
