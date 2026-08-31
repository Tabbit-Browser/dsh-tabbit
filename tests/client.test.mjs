// client/client.js（web 客户端插件）的冒烟测试：模拟宿主的 ModuleLoader
// 装载协议取出工厂，用假 React 驱动 apply，验证 @tab 输入源与 tabbit-status
// 聊天节点的注册物形状、事件匹配、视图节点构造和渲染器输出。假 React 只
// 记录 createElement 调用树，不做真实 DOM。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/* 装载一次 client.js 并返回其模块导出（require 只认平台词 'react'）。 */
function loadClient(fakeReact) {
  globalThis.window = { __ModuleLoader__: { load: (handoff) => { globalThis.__handoff = handoff } } }
  eval(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'))
  return globalThis.__handoff.factory((spec) => {
    if (spec === 'react') return fakeReact
    throw new Error(`unexpected require: ${spec}`)
  })
}

/* 三个宿主服务的最小假件：记录注册物，形状对齐各自服务契约。 */
function mockServices({ registeredNodes, slotRegistrations, sources }) {
  return {
    get(name) {
      if (name === 'inputTriggers') {
        return { registerSource: (source) => { sources.push(source); return () => {} } }
      }
      if (name === 'uiConversation') {
        return { events: { register: (definition) => { registeredNodes.push(definition); return () => {} } } }
      }
      if (name === 'slots') {
        return {
          inject: (slot, callback) => { slotRegistrations.push({ slot, callback }); return () => {} },
          register: (spec, view) => ({ spec, view }),
        }
      }
      throw new Error(`unexpected service: ${name}`)
    },
    effect(fn) { const cleanup = fn(); return () => cleanup?.() },
  }
}

test('registers the @tab source and the tabbit-status chat node', () => {
  const fakeReact = { createElement: (type, props, ...children) => ({ type, props, children }), useState: () => [false, () => {}] }
  const client = loadClient(fakeReact)
  assert.equal(client.name, 'dsh-tabbit-client')
  assert.deepEqual(client.inject, ['inputTriggers', 'uiConversation', 'slots'])

  const registeredNodes = []
  const slotRegistrations = []
  const sources = []
  client.apply(mockServices({ registeredNodes, slotRegistrations, sources }))

  assert.equal(sources.length, 1)
  assert.equal(registeredNodes.length, 1)
  assert.equal(slotRegistrations.length, 1)

  const node = registeredNodes[0]
  assert.equal(node.kind, 'tabbit-status')
  assert.equal(node.target, 'chat')

  // match：只认 tabbit/status；单事件业务，event.seq 即节点身份。
  assert.equal(node.match({ type: 'command/run', data: {} }), null)
  assert.deepEqual(
    node.match({ type: 'tabbit/status', seq: 7, data: { conclusion: 'c', report: 'r' } }),
    { id: '7', role: 'start' },
  )

  // start/buildViewNode：整值载荷透传为 state，锚点与 location 取自事件。
  const start = { event: { type: 'tabbit/status', seq: 7, data: { conclusion: 'c', report: 'r' } }, location: { kind: 'session' } }
  assert.deepEqual(node.start(undefined, start), { conclusion: 'c', report: 'r' })
  const view = node.buildViewNode({ key: 'k1', id: '7', state: start.event.data, start })
  assert.equal(view.kind, 'tabbit-status')
  assert.equal(view.anchorSeq, 7)
  assert.equal(view.location.kind, 'session')
  assert.equal(view.visibility, 'visible')

  // 渲染器：keyed 插槽声明 + 组件能渲染出卡片结构。
  assert.equal(slotRegistrations[0].slot, 'conversation.chat.node')
  const seat = slotRegistrations[0].callback()
  assert.equal(seat.spec.key, 'tabbit-status')
})

test('renders the status card with a language-following details toggle', () => {
  const fakeReact = { createElement: (type, props, ...children) => ({ type, props, children }), useState: () => [false, () => {}] }
  const client = loadClient(fakeReact)
  const seat = (() => {
    const slotRegistrations = []
    client.apply(mockServices({
      registeredNodes: [], slotRegistrations, sources: [],
    }))
    return slotRegistrations[0].callback()
  })()

  // 中文结论（⚠️ 前缀）：卡片描边转警示色、按钮文案跟随中文。
  const zh = seat.view({ node: { data: { conclusion: '⚠️ 未找到 Tabbit 浏览器', report: 'instances: none registered' } } })
  assert.equal(zh.type, 'div')
  assert.equal(zh.props.style.borderColor, '#d4a72c')
  assert.equal(zh.children[0].children[0], '⚠️ 未找到 Tabbit 浏览器')
  assert.equal(zh.children[1].type, 'button')
  assert.equal(zh.children[1].children[0].startsWith('明细'), true)

  // 英文结论：默认描边、按钮文案英文。
  const en = seat.view({ node: { data: { conclusion: '✅ Tabbit integration OK', report: 'instances: 1' } } })
  assert.notEqual(en.props.style.borderColor, '#d4a72c')
  assert.equal(en.children[1].children[0].startsWith('details'), true)
})
