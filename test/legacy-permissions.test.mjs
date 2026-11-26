import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { apply, Config, SETTINGS_SCHEMA } from '../lib/core/index.js'
import * as permissions from '../lib/permissions/index.js'

test('the service reads old restrictions during migration and prefers an explicit new setting', async t => {
  const home = await mkdtemp(fileURLToPath(new URL('./.migration-', import.meta.url)))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, 'settings.yaml.imported'), 'tabbit:\n  pageAccess: never\n  intranetFetch: ask\n  launcherPath: /测试/浏览器\n', 'utf8')
  const pending = Promise.withResolvers()
  const persisted = Promise.withResolvers()
  const user = { intranetFetch: 'always' }
  let service
  const live = SETTINGS_SCHEMA(user)
  const config = Object.fromEntries(Object.keys(live).map(key => [key, { get: () => live[key] }]))
  const ctx = {
    get: key => key === 'profileContext' ? { home, dir: home } : undefined,
    fiber: { entry: { options: { config: user } } },
    root: { loader: { await: () => pending.promise } },
    settings: {
      describe: () => [{ ns: 'tabbit-browser', user, revision: 1 }],
      async update(_ns, patch) {
        assert.deepEqual(patch, { pageAccess: 'never', launcherPath: '/测试/浏览器' })
        Object.assign(live, patch)
        persisted.resolve()
      },
    },
    provide(key, value) { if (key === 'tabbit') service = value },
    logger: { info() {}, warn() {} },
    effect() {}, on() {}, inject() {},
  }
  await apply(ctx, config)
  const initial = service.currentSettings()
  pending.resolve()
  await persisted.promise
  assert.equal(initial.pageAccess, 'never')
  assert.equal(initial.launcherPath, '/测试/浏览器')
  assert.equal(initial.intranetFetch, 'always')
  assert.equal(service.currentSettings().pageAccess, 'never')
})

test('old defaults preserve explicit newer settings defined by a whole config expression', async t => {
  const home = await mkdtemp(fileURLToPath(new URL('./.migration-js-', import.meta.url)))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, 'settings.yaml.imported'), 'tabbit:\n  pageAccess: always\n  intranetFetch: never\n', 'utf8')
  let service
  const configured = { pageAccess: 'never' }
  const ctx = {
    get: key => key === 'profileContext' ? { home, dir: home } : undefined,
    fiber: { entry: {
      options: { config: { __jsExpr: "({ pageAccess: 'never' })" } },
      evaluate: () => configured,
    } },
    root: { loader: { await: () => new Promise(() => {}) } },
    settings: {},
    provide(key, value) { if (key === 'tabbit') service = value },
    logger: { info() {}, warn() {} },
    effect() {}, on() {}, inject() {},
  }
  await apply(ctx, SETTINGS_SCHEMA(configured))
  assert.equal(service.currentSettings().pageAccess, 'never')
  assert.equal(service.currentSettings().intranetFetch, 'never')
})

test('a fresh profile allows the first page and intranet calls without an approval channel', async t => {
  const home = await mkdtemp(fileURLToPath(new URL('./.fresh-profile-', import.meta.url)))
  t.after(() => rm(home, { recursive: true, force: true }))
  let tabbit
  const ctx = {
    get: key => key === 'profileContext' ? { home, dir: home } : undefined,
    settings: {},
    provide(key, value) { if (key === 'tabbit') tabbit = value },
    logger: { info() {}, warn() {} },
    effect() {}, on() {}, inject() {},
  }
  await apply(ctx, Config({}))
  let beforeTool
  permissions.apply({
    tabbit, get: () => undefined,
    on(event, handler) { if (event === 'tools/pre-execute') beforeTool = handler },
  })
  const session = { id: 'new-session', session: {} }
  for (const [name, args] of [['tabbit_browser', {}], ['web_fetch', { url: 'http://127.0.0.1/' }]]) {
    const result = await beforeTool({ name, arguments: args, callId: name, agent: session }, () => 'allowed')
    assert.equal(result, 'allowed')
  }
})
