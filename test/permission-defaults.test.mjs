import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, SETTINGS_SCHEMA } from '../lib/core/index.js'
import { apply } from '../lib/permissions/index.js'

// 分别验证旧 settings 和新版 volatile Config 的真实缺省值都能通过工具执行钩子。
for (const [name, read] of [
  ['legacy settings', input => SETTINGS_SCHEMA(input)],
  ['volatile config', input => Object.fromEntries(Object.entries(Config(input)).map(([k, v]) => [k, v.get()]))],
]) {
  test(name + ' allows the first Tabbit call by default and respects explicit policies', async () => {
    let settings = read({})
    let preExecute
    apply({
      on(event, callback) { if (event === 'tools/pre-execute') preExecute = callback },
      get: () => ({ overrideOf: () => undefined }),
      tabbit: { currentSettings: () => settings, hasPageAccessGrant: () => false, hasIntranetGrant: () => false },
    })
    const run = (name, args = {}) => preExecute({ name, arguments: args, callId: 'first', agent: { id: 'new-session' } }, () => 'allowed')
    const local = { url: 'http://127.0.0.1/' }
    assert.equal(await run('tabbit_browser'), 'allowed')
    assert.equal(await run('web_fetch', local), 'allowed')
    for (const mode of ['ask', 'never']) {
      const expected = mode === 'ask' ? 'ask' : 'deny'
      settings = read({ pageAccess: mode })
      assert.equal((await run('tabbit_browser')).kind, expected)
      settings = read({ intranetFetch: mode })
      assert.equal((await run('web_fetch', local)).kind, expected)
    }
  })
}
