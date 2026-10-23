/** Chromium -> real Seller React components -> real route handlers -> mocked services.
 * Requires browser-build.mjs and browser-server.mjs; no real provider or payment calls.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile, mkdir } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.MAHSHAR_PLAYWRIGHT_MODULE ?? 'playwright-core')
const base = `http://127.0.0.1:${process.env.MAHSHAR_BROWSER_PORT ?? 3057}`
const evidenceDir = process.env.MAHSHAR_BROWSER_EVIDENCE ?? 'validation/evidence'
await mkdir(evidenceDir, { recursive: true })
const bundle = value => JSON.stringify(value)
const models = [
  { type: 'public' },
  { type: 'apikey', key: 'browser-legacy-private' },
  { type: 'bearer', key: 'browser-bearer-private' },
  { type: 'queryparam', key: 'browser-query-private', param: 'api_key' },
  { type: 'basic', key: bundle({ username: 'browser-user', password: 'browser-password-private' }) },
  { type: 'headers', key: bundle({ headers: [{ name: 'X-Custom-Key', value: 'browser-custom-private' }] }) },
  { type: 'authorization', key: bundle({ scheme: 'Token', token: 'browser-token-private' }) },
  { type: 'authorization', variant: 'ApiKey', key: bundle({ scheme: 'ApiKey', token: 'browser-apikey-private' }) },
  { type: 'headers', variant: 'multiple', key: bundle({ headers: [{ name: 'X-Client-ID', value: 'browser-client-id' },
    { name: 'X-Client-Secret', value: 'browser-client-private' }], authorization: { scheme: 'Bearer', token: 'browser-multi-private' } }) },
  ...['oauth_client_credentials', 'oauth_pkce'].map(type => ({ type, key: bundle({ provider: 'fixture',
    client_id: 'browser-oauth-id', client_secret: 'browser-oauth-private', account_mode: 'seller' }) })),
  { type: 'oauth_pkce', variant: 'buyer', key: bundle({ provider: 'fixture', client_id: 'browser-oauth-id',
    client_secret: 'browser-oauth-private', account_mode: 'buyer' }) },
]
const browser = await chromium.launch({ headless: true,
  ...(process.env.MAHSHAR_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MAHSHAR_CHROMIUM_EXECUTABLE } : {}) })
const results = []
try {
  for (const model of models) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const consoleErrors = [], responses = []
    page.on('pageerror', error => consoleErrors.push(error.message))
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin === base) {
        if (!url.pathname.startsWith('/api/')) return route.continue()
        // Capture before navigation; redirect response bodies are unavailable
        // from Chromium's response event after window.location.assign().
        const response = await route.fetch({ maxRedirects: 0 })
        const body = await response.text()
        responses.push(body)
        return route.fulfill({ response, body })
      }
      if (url.origin === 'https://auth.provider.example' && url.pathname === '/authorize') {
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
        assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
        assert.equal(url.searchParams.get('client_secret'), null)
        const callback = new URL(url.searchParams.get('redirect_uri'))
        const target = base + callback.pathname + '?state=' + encodeURIComponent(url.searchParams.get('state'))
        return route.fulfill({ contentType: 'text/html', body: `<h1>Mock provider consent</h1><a href="${target}&code=browser-code">Approve fixture</a><a href="${target}&error=access_denied">Deny fixture</a>` })
      }
      throw new Error('External browser network forbidden: ' + url.origin)
    })
    const waitRequest = (path, method, click) => Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === method), click(),
    ]).then(([response]) => response)
    try {
      await page.request.get(base + '/fixture/reset')
      await page.goto(base)
      await page.getByLabel(/^Endpoint URL/).fill('https://provider.example/data')
      await page.getByLabel(/^API Name/).fill('Browser Provider')
      await page.getByLabel(/^Description/).fill('Synthetic non billing provider')
      await page.getByLabel(/^Authentication/).selectOption(model.type)
      if (model.key) await page.locator('input[type=password]').fill(model.key)
      if (model.param) await page.getByLabel(/^Credential parameter/).fill(model.param)
      const oauth = model.type.startsWith('oauth_')
      if (oauth) {
        const saved = await waitRequest('/api/apis', 'POST', () => page.getByRole('button', { name: 'Save OAuth configuration' }).click())
        assert.equal(saved.status(), 201, await saved.text())
      } else {
        const analyzed = await waitRequest('/api/ai/score', 'POST', () => page.getByRole('button', { name: 'Analyze', exact: true }).click())
        assert.equal((await analyzed.json()).endpoint_verified, true)
        const published = await waitRequest('/api/apis', 'POST', () => page.getByRole('button', { name: 'Publish API', exact: true }).click())
        assert.equal(published.status(), 201, await published.text())
        await page.waitForFunction(() => window.__navigation === '/dashboard/apis')
      }
      let serverEvidence = await (await page.request.get(base + '/fixture/evidence')).json()
      const id = serverEvidence.listings[0].id
      await page.goto(base + '/?edit=' + id)
      await page.getByRole('button', { name: 'Save changes', exact: true }).waitFor()
      assert.equal(await page.locator('input[type=password]').count() ? await page.locator('input[type=password]').inputValue() : '', '')
      if (oauth) {
        const connected = await waitRequest('/api/provider-oauth/' + id, 'POST', () => page.getByRole('button', { name: 'Connect provider', exact: true }).click())
        assert.equal(connected.status(), 200)
        if (model.type === 'oauth_pkce') {
          await page.getByRole('link', { name: 'Approve fixture' }).click()
          await page.waitForURL(/provider_oauth=connected/)
          await page.goto(base + '/?edit=' + id)
        }
        const verified = await waitRequest(`/api/apis/${id}/verify`, 'POST', () => page.getByRole('button', { name: 'Verify saved setup', exact: true }).click())
        assert.equal((await verified.json()).verified, true)
      }
      await page.getByLabel(/^API Name/).fill('Browser Provider edited')
      const saved = await waitRequest(`/api/apis/${id}`, 'PATCH', () => page.getByRole('button', { name: 'Save changes', exact: true }).click())
      assert.equal(saved.status(), 200, await saved.text())
      await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '' || !document.querySelector('input[type=password]'))
      if (model.key) {
        await page.locator('input[type=password]').fill(model.key.replaceAll('private', 'replacement'))
        const replaced = await waitRequest(`/api/apis/${id}`, 'PATCH', () => page.getByRole('button', { name: 'Save changes', exact: true }).click())
        assert.equal(replaced.status(), 200, await replaced.text())
        await page.getByRole('button', { name: 'Verify saved setup', exact: true }).waitFor()
        // OAuth replacements require a new connection because the encrypted config hash changed.
        if (oauth) {
          await waitRequest('/api/provider-oauth/' + id, 'POST', () => page.getByRole('button', { name: 'Connect provider', exact: true }).click())
          if (model.type === 'oauth_pkce') {
            await page.getByRole('link', { name: 'Approve fixture' }).click()
            await page.waitForURL(/provider_oauth=connected/)
            await page.goto(base + '/?edit=' + id)
          }
        }
        const verified = await waitRequest(`/api/apis/${id}/verify`, 'POST', () => page.getByRole('button', { name: 'Verify saved setup', exact: true }).click())
        assert.equal((await verified.json()).verified, true)
      }
      if (oauth) {
        const status = await waitRequest('/api/provider-oauth/' + id, 'GET', () => page.getByRole('button', { name: 'Check connection', exact: true }).click())
        assert.equal((await status.json()).status, 'active')
        await page.getByLabel(/^API Name/).fill('Unsaved draft survives disconnect')
        const disconnected = await waitRequest('/api/provider-oauth/' + id, 'DELETE', () => page.getByRole('button', { name: 'Disconnect provider', exact: true }).click())
        assert.equal((await disconnected.json()).disconnected, true)
        await page.getByText(/Disconnected locally/).waitFor()
        assert.equal(await page.getByLabel(/^API Name/).inputValue(), 'Unsaved draft survives disconnect')
        if (model.variant !== 'buyer') {
          await page.getByRole('button', { name: 'Verify saved setup', exact: true }).waitFor()
          assert.equal(await page.getByRole('button', { name: 'Activate listing', exact: true }).isDisabled(), true)
        }
      }
      for (const response of responses) {
        for (const forbidden of ['encrypted_key', 'encrypted_tokens', 'browser-access-private-fixture', 'browser-refresh-private-fixture', 'browser-oauth-private', 'browser-oauth-replacement']) assert.ok(!response.includes(forbidden), forbidden)
      }
      assert.deepEqual(consoleErrors, [])
      serverEvidence = await (await page.request.get(base + '/fixture/evidence')).json()
      assert.equal(serverEvidence.settled, 0)
      await page.screenshot({ path: `${evidenceDir}/browser-${model.type}-${model.variant ?? 'default'}.png`, fullPage: true })
      results.push({ type: model.type, variant: model.variant ?? 'default', passed: true, ...serverEvidence })
      console.log('PASS browser', model.type, model.variant ?? '')
    } catch (error) {
      await page.screenshot({ path: `${evidenceDir}/browser-failure.png`, fullPage: true })
      results.push({ type: model.type, variant: model.variant ?? 'default', passed: false, error: String(error), consoleErrors,
        evidence: await (await page.request.get(base + '/fixture/evidence')).json() })
      throw error
    } finally { await context.close() }
  }
  // Accepted request ceiling: visible guidance, local preflight, server 413,
  // retained credentials/drafts, and successful recovery after reducing input.
  const context = await browser.newContext()
  const page = await context.newPage()
  let rejectNext = false
  let rejectMethod = 'PATCH'
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== base) throw new Error('External browser network forbidden')
    if (rejectNext && route.request().method() === rejectMethod) {
      rejectNext = false
      return route.fulfill({ status: 413, contentType: 'application/json', body: '{"error":"edge body too large"}' })
    }
    return route.continue()
  })
  const message = 'Listing request exceeds the 64 KiB limit.'
  try {
    await page.goto(base)
    await page.getByLabel(/^Endpoint URL/).fill('https://provider.example/data')
    await page.getByLabel(/^API Name/).fill('Preserved create draft')
    await page.getByLabel(/^Description/).fill('Synthetic body-limit test')
    await page.getByLabel(/^Example Response/).fill('x'.repeat(70000))
    const beforeCreate = await (await page.request.get(base + '/fixture/evidence')).json()
    await page.getByRole('button', { name: 'Analyze', exact: true }).click()
    await page.getByText(message, { exact: false }).waitFor()
    assert.equal(await page.getByLabel(/^Example Response/).inputValue(), 'x'.repeat(70000))
    assert.equal((await (await page.request.get(base + '/fixture/evidence')).json()).requests.length, beforeCreate.requests.length)

    await page.getByLabel(/^Example Response/).fill('{}')
    const analyzed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/ai/score')
    await page.getByRole('button', { name: 'Analyze', exact: true }).click()
    assert.equal((await (await analyzed).json()).endpoint_verified, true)
    await page.getByLabel(/^Example Response/).fill('x'.repeat(70000))
    const beforePublish = await (await page.request.get(base + '/fixture/evidence')).json()
    await page.getByRole('button', { name: 'Publish API', exact: true }).click()
    await page.getByText(message, { exact: false }).waitFor()
    assert.equal((await (await page.request.get(base + '/fixture/evidence')).json()).requests.length, beforePublish.requests.length)
    await page.getByLabel(/^Example Response/).fill('{}')
    rejectNext = true; rejectMethod = 'POST'
    await page.getByRole('button', { name: 'Publish API', exact: true }).click()
    await page.getByText(message, { exact: false }).waitFor()
    assert.equal(await page.getByLabel(/^API Name/).inputValue(), 'Preserved create draft')
    rejectMethod = 'PATCH'

    const id = beforeCreate.listings[0].id
    await page.goto(base + '/?edit=' + id)
    await page.getByRole('button', { name: 'Save changes', exact: true }).waitFor()
    // The final auth fixture is now PKCE; explicitly select the static bundle under test.
    await page.getByLabel(/^Authentication/).selectOption('headers')
    const credential = bundle({ headers: [{ name: 'X-Private-Key', value: 'browser-retained-private' }] })
    await page.locator('input[type=password]').fill(credential)
    await page.getByLabel(/^Example Response/).fill('😀'.repeat(17000))
    const beforeEdit = await (await page.request.get(base + '/fixture/evidence')).json()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.getByText(message, { exact: false }).waitFor()
    assert.equal(await page.locator('input[type=password]').inputValue(), credential)
    assert.equal((await (await page.request.get(base + '/fixture/evidence')).json()).requests.length, beforeEdit.requests.length)

    await page.getByLabel(/^Example Response/).fill('{}')
    rejectNext = true
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.getByText(message, { exact: false }).waitFor()
    assert.equal(await page.locator('input[type=password]').inputValue(), credential)
    assert.equal(await page.getByLabel(/^Example Response/).inputValue(), '{}')
    const saved = page.waitForResponse(r => r.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    const savedResponse = await saved
    assert.equal(savedResponse.status(), 200, await savedResponse.text())
    await page.waitForFunction(() => document.querySelector('input[type=password]').value === '')
    await page.screenshot({ path: `${evidenceDir}/browser-size-handling.png`, fullPage: true })
    results.push({ type: 'body-limit-ui', passed: true, scenarios: ['analysis preflight', 'Create preflight', 'Create server 413 keeps draft', 'Edit UTF-8 preflight before proof', 'Edit server 413 keeps draft', 'reduced input saves'] })
    console.log('PASS browser Create/Edit 64 KiB preflight, server 413, retained draft and recovery')
  } finally { await context.close() }
} finally {
  await writeFile(`${evidenceDir}/browser-results.json`, JSON.stringify({ browser: browser.version(), results }, null, 2))
  await browser.close()
}
console.log(`${models.length} Chromium Seller auth flows and six accepted-limit scenarios passed`)
