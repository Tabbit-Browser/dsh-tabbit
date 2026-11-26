import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, SETTINGS_SCHEMA, TabbitService } from '../lib/core/index.js'
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

test('a default-allowed call grants nothing when a session changes to ask', async () => {
  let settings = SETTINGS_SCHEMA({})
  const tabbit = new TabbitService(() => settings)
  const handlers = new Map()
  apply({
    on: (event, callback) => handlers.set(event, callback),
    get: key => key === 'approval' ? { overrideOf: () => undefined } : undefined,
    tabbit,
  })
  const exec = { name: 'tabbit_browser', arguments: {}, callId: 'first', agent: { id: 'session', session: {} } }
  const run = callId => handlers.get('tools/pre-execute')({ ...exec, callId }, () => 'allowed')
  const finish = (callId, result) => handlers.get('tools/result')({ ...exec, callId }, result)
  assert.equal(await run('first'), 'allowed')
  finish('first', { isError: false })
  settings = SETTINGS_SCHEMA({ pageAccess: 'ask' })
  assert.equal((await run('second')).kind, 'ask')
  finish('second', { isError: true })
  assert.equal((await run('third')).kind, 'ask')
  finish('third', { isError: false, value: { status: 'failed' } })
  assert.equal((await run('fourth')).kind, 'ask')
  finish('fourth', { isError: false, value: { status: 'succeeded' } })
  assert.equal(await run('fifth'), 'allowed')
})

test('only the effective Full access preset bypasses ask, and explicit never still denies', async () => {
  let preset = 'auto'
  let settings = SETTINGS_SCHEMA({ pageAccess: 'ask', intranetFetch: 'ask' })
  const handlers = new Map()
  apply({
    on: (event, callback) => handlers.set(event, callback),
    get(key) {
      if (key === 'approval') return { overrideOf: () => 'never' }
      if (key === 'permissionPresets') return { current: () => preset }
    },
    tabbit: new TabbitService(() => settings),
  })
  const run = (name, args = {}) => handlers.get('tools/pre-execute')(
    { name, arguments: args, callId: 'probe', agent: { id: 'session', session: {} } }, () => 'allowed',
  )
  assert.equal((await run('tabbit_browser')).kind, 'ask')
  assert.equal((await run('web_fetch', { url: 'http://127.0.0.1/' })).kind, 'ask')
  preset = 'custom'
  assert.equal((await run('tabbit_browser')).kind, 'ask')
  preset = 'danger-full-access'
  assert.equal(await run('tabbit_browser'), 'allowed')
  settings = SETTINGS_SCHEMA({ pageAccess: 'never' })
  assert.equal((await run('tabbit_browser')).kind, 'deny')
})

test('approvals for one session never grant a different session with the same tool call id', async () => {
  const tabbit = new TabbitService(() => SETTINGS_SCHEMA({ pageAccess: 'ask' }))
  const handlers = new Map()
  apply({ on: (event, callback) => handlers.set(event, callback), get: key => key === 'approval' ? {} : undefined, tabbit })
  const call = id => ({ name: 'tabbit_browser', arguments: {}, callId: 'call-0', agent: { id, session: {} } })
  for (const id of ['first-session', 'second-session']) {
    assert.equal((await handlers.get('tools/pre-execute')(call(id), () => 'allowed')).kind, 'ask')
  }
  handlers.get('tools/result')(call('first-session'), { isError: false })
  handlers.get('tools/result')(call('second-session'), { isError: true })
  assert.equal(tabbit.hasPageAccessGrant('first-session'), true)
  assert.equal(tabbit.hasPageAccessGrant('second-session'), false)
})
