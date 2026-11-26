// 用 DSH_TABBIT_TEST_HOST 指向已安装 DSH 的 package.json，可在同一测试上切换发布渠道。
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mentions from '../lib/mentions/index.js'
import * as webConfig from '../lib/web-config/index.js'

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

test('the real web service keeps host and custom search routes while Tabbit serves fetch', async t => {
  const host = createRequire(anchor)
  const { Context } = host('@deepseek-ai/cordis')
  const { WebRuntime } = host('@deepseek-ai/dsh-web')
  const { loadProfile, composeEntries } = host('@deepseek-ai/dsh-app-boot')
  const { interpolate } = host('@deepseek-ai/cordis-plugin-loader')

  // 清除本机的搜索覆盖，单独验证环境变量与显式 profile 的优先级。
  const savedProvider = process.env.DSH_WEB_SEARCH_PROVIDER
  delete process.env.DSH_WEB_SEARCH_PROVIDER
  t.after(() => {
    if (savedProvider === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
    else process.env.DSH_WEB_SEARCH_PROVIDER = savedProvider
  })
  const home = await mkdtemp(join(tmpdir(), 'tabbit-search-profile-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const name = 'routing-test'
  const dir = join(home, 'profiles', name)
  const modules = join(dir, 'node_modules')
  await mkdir(modules, { recursive: true })
  await symlink(fileURLToPath(new URL('..', import.meta.url)), join(modules, 'dsh-tabbit'), process.platform === 'win32' ? 'junction' : 'dir')
  const custom = join(modules, 'custom-search')
  await mkdir(custom)
  await writeFile(join(custom, 'package.json'), JSON.stringify({
    name: 'custom-search', version: '1.0.0', dsh: { bundle: { patch: './patch.yml' } },
  }))

  // 上游基座、第三方 bundle、用户最高优先级分别走真实的组合逻辑。
  const base = '@deepseek-ai/dsh-base'
  async function webRow(bundles, patch = []) {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, dsh: { profile: { bundles } } }))
    const profile = loadProfile('dsh', name, anchor, home)
    return composeEntries([...profile.layers.map(layer => layer.patches), patch]).find(row => row.id === 'web')
  }
  const baseRow = await webRow([base])
  assert.ok(baseRow, 'host must include its actual base bundle')
  const customId = 'custom-search'
  await writeFile(join(custom, 'patch.yml'), "- id: web\n  config:\n    searchProvider: !!js \"'custom-search'\"\n")

  const setups = [
    { bundles: [base, 'dsh-tabbit'], expected: baseRow.config?.searchProvider, fetch: 'tabbit-browser' },
    { bundles: [base, 'dsh-tabbit'], expected: baseRow.config?.searchProvider, env: customId, fetch: 'tabbit-browser' },
    { bundles: [base, customId, 'dsh-tabbit'], expected: customId, fetch: 'tabbit-browser' },
    { bundles: [base, 'dsh-tabbit', customId], expected: customId, fetch: undefined },
    { bundles: [base, 'dsh-tabbit'], patch: [{ id: 'web', config: { searchProvider: customId, fetchProvider: 'http' } }], expected: customId, fetch: 'http' },
  ]
  for (const setup of setups) {
    if (setup.env) process.env.DSH_WEB_SEARCH_PROVIDER = setup.env
    else delete process.env.DSH_WEB_SEARCH_PROVIDER
    const ctx = new Context()
    try {
      ctx.provide('profileContext', { dir, name, home, installAnchor: anchor })
      await ctx.plugin(webConfig).await()
      const row = await webRow(setup.bundles, setup.patch)
      const config = interpolate(ctx, row.config)
      assert.equal(config.searchProvider, setup.expected)
      assert.equal(config.fetchProvider, setup.fetch)
      await ctx.plugin(WebRuntime, config).await()
      for (const id of ['deepseek-official', 'deepseek-search-api', customId]) {
        ctx.web.registerSearchProvider({ id, available: () => true, search: async () => ({ provider: id, sources: [] }) })
      }
      for (const llmProvider of ['deepseek-official', 'deepseek-account', 'external']) {
        const expected = setup.expected ?? setup.env ?? (llmProvider === 'external' ? 'deepseek-search-api' : 'deepseek-official')
        const result = await ctx.web.search({ query: 'routing test', llmProvider })
        assert.equal(result.provider, expected)
      }
      if (config.fetchProvider) {
        for (const id of ['tabbit-browser', 'http']) {
          ctx.web.registerFetchProvider({ id, available: () => true, fetch: async () => ({ provider: id }) })
        }
        assert.equal((await ctx.web.fetch({ url: 'https://example.org' })).provider, config.fetchProvider)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  }
})
