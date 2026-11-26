// 用 DSH_TABBIT_TEST_HOST 指向已安装 DSH 的 package.json，可在同一测试上切换发布渠道。
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as mentions from '../lib/mentions/index.js'

// 完整开发检出使用同一份 CLI；npm 宿主可从实际链接的 dsh-web 包定位。
function hostAnchor() {
  if (process.env.DSH_TABBIT_TEST_HOST) return process.env.DSH_TABBIT_TEST_HOST
  const checkout = new URL('../.dsh-harness/apps/cli/package.json', import.meta.url)
  if (existsSync(checkout)) return fileURLToPath(checkout)
  return createRequire(realpathSync(new URL(import.meta.resolve('@deepseek-ai/dsh-web')))).resolve('@deepseek-ai/dsh/package.json')
}
const anchor = hostAnchor()

test('the real web server releases every mention route on each unload', async t => {
  const host = createRequire(anchor)
  const { Context } = host('@deepseek-ai/cordis')
  const { WebServer } = host('@deepseek-ai/dsh-host-webserver')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('tabbit', {})
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()

  const paths = ['/tabbit/mention/tabs', '/tabbit/tabs', '/tabbit/mention/extract', '/tabbit/instance-hint']
  for (let cycle = 0; cycle < 3; cycle++) {
    const mounted = ctx.plugin(mentions)
    await mounted.await()
    for (const path of paths) {
      assert.throws(() => ctx.webServer.register({ kind: 'exact', path, handler() {} }), /duplicate/)
    }
    await mounted.dispose()
    for (const path of paths) {
      const release = ctx.webServer.register({ kind: 'exact', path, handler() {} })
      release()
    }
  }
})

test('real Cordis composes search overrides and Tabbit fetch defaults without profileContext', async t => {
  const host = createRequire(anchor)
  const { Context } = host('@deepseek-ai/cordis')
  const { Loader } = host('@deepseek-ai/cordis-plugin-loader')
  const { Include, applyEntryPatches, parseEntryYaml, entryListSchema } = host('@deepseek-ai/cordis-plugin-include')
  const parsePatch = parseEntryYaml ?? (text => host('js-yaml').load(text, { schema: entryListSchema }))

  for (const key of ['DSH_WEB_SEARCH_PROVIDER', 'DSH_WEB_FETCH_PROVIDER']) {
    const original = process.env[key]
    delete process.env[key]
    t.after(() => {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    })
  }
  const dir = await mkdtemp(fileURLToPath(new URL('./.web-config-', import.meta.url)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const base = parsePatch(await readFile(host.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8'))
  const composed = applyEntryPatches([], base)
  const baseRow = (Array.isArray(composed) ? composed : composed.data).find(row => row.id === 'web')
  assert.ok(baseRow)
  const webModule = pathToFileURL(host.resolve('@deepseek-ai/dsh-web')).href
  const tabbit = parsePatch(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const defaults = tabbit.flatMap(patch => {
    if (patch.id === 'web') return [patch]
    const insert = patch.insert?.find(row => row.id === 'tabbit-web-config')
    return insert ? [{ insert: [{ ...insert, name: new URL('../lib/web-config/index.js', import.meta.url).href }] }] : []
  })
  const customId = 'custom-search'
  const custom = { id: 'web', config: { searchProvider: { __jsExpr: "'custom-search'" } } }
  const setups = [
    { patches: defaults, search: baseRow.config?.searchProvider, fetch: 'tabbit-browser' },
    { patches: defaults, search: baseRow.config?.searchProvider, env: customId, fetch: 'tabbit-browser' },
    { patches: [custom, ...defaults], search: customId, fetch: 'tabbit-browser' },
    { patches: [...defaults, custom], search: customId, fetch: 'tabbit-browser' },
    {
      patches: [...defaults, { id: 'web', config: { __jsExpr: "const provider = 'custom-search'; ({ searchProvider: provider })" } }],
      search: customId, fetch: 'tabbit-browser',
    },
    { patches: [...defaults, { id: 'web', config: { searchProvider: customId, fetchProvider: 'http' } }], search: customId, fetch: 'http' },
    { patches: [{ id: 'web', config: { fetchProvider: 'custom-fetch' } }, ...defaults], fetch: 'custom-fetch' },
    { patches: defaults, search: baseRow.config?.searchProvider, fetchEnv: 'custom-fetch', fetch: 'custom-fetch' },
  ]
  for (const [index, setup] of setups.entries()) {
    if (setup.env) process.env.DSH_WEB_SEARCH_PROVIDER = setup.env
    else delete process.env.DSH_WEB_SEARCH_PROVIDER
    if (setup.fetchEnv) process.env.DSH_WEB_FETCH_PROVIDER = setup.fetchEnv
    else delete process.env.DSH_WEB_FETCH_PROVIDER
    const ctx = new Context()
    try {
      await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
      await ctx.plugin(Include, {
        path: pathToFileURL(join(dir, `case-${index}.yml`)).href,
        initial: [{ ...baseRow, name: webModule }],
        patches: setup.patches,
      }).await()
      await ctx.loader.await()
      assert.ok(ctx.web, `web service did not start in setup ${index}`)
      for (const id of ['deepseek-official', 'deepseek-search-api', customId]) {
        ctx.web.registerSearchProvider({ id, available: () => true, search: async () => ({ provider: id, sources: [] }) })
      }
      if (setup.search !== undefined || setup.env !== undefined || !baseRow.config?.searchProvider) {
        for (const llmProvider of ['deepseek-official', 'deepseek-account', 'external']) {
          const expected = setup.search ?? setup.env ?? (llmProvider === 'external' ? 'deepseek-search-api' : 'deepseek-official')
          assert.equal((await ctx.web.search({ query: 'routing test', llmProvider })).provider, expected, `search setup ${index}`)
        }
      }
      for (const id of ['tabbit-browser', 'http', 'custom-fetch']) {
        ctx.web.registerFetchProvider({ id, available: () => true, fetch: async () => ({ provider: id }) })
      }
      assert.equal((await ctx.web.fetch({ url: 'https://example.org' })).provider, setup.fetch, `fetch setup ${index}`)
    } finally {
      await ctx.fiber.dispose()
    }
  }
})
