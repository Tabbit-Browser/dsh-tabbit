// 插件注册层的单元测试：installer/update 两个工具（经 DI 假件驱动三态与
// 会话缓存）+ core 的随包 skill provider。自 0.2.x 世代的测试改造而来。
import assert from 'node:assert/strict'
import test from 'node:test'
import * as installer from '../lib/installer/index.js'
import { skillProvider } from '../lib/core/index.js'

const SUPPORTED = {
  installations: [{ name: 'Tabbit', edition: 'international', channel: 'stable', version: '1.9.2' }],
  supportedInstallations: [{ name: 'Tabbit', edition: 'international', channel: 'stable', version: '1.9.2' }],
}

function mockCtx({ tabbit = {}, jobs = {} } = {}) {
  const tools = []
  return {
    tools: { register: value => { tools.push(value); return () => {} } },
    jobs,
    tabbit,
    registered: tools,
  }
}

test('exposes the cordis plugin contract and registers both tools', () => {
  assert.equal(installer.name, 'tabbit-installer')
  assert.deepEqual(installer.inject, ['tools', 'jobs', 'tabbit'])

  const ctx = mockCtx()
  installer.apply(ctx)
  assert.deepEqual(
    ctx.registered.map(tool => tool.name).sort(),
    ['tabbit_browser_install', 'tabbit_plugin_update'],
  )
  assert.ok(ctx.registered.every(tool => typeof tool.execute === 'function'))
})

test('caches a ready environment check per agent session', async () => {
  let checks = 0
  const ctx = mockCtx({
    tabbit: {
      // launcher 存在性用真实文件系统检查（existsSync）——拿本进程的 node
      // 可执行文件当"已注册的 launcher"，永远存在。
      launcherPath: () => process.execPath,
      instances: () => [{ id: 'A'.repeat(16), online: true, appName: 'Tabbit', cliPath: '', endpointPath: '' }],
    },
  })
  installer.registerInstallerTool(ctx, {
    detect: async () => {
      checks += 1
      return SUPPORTED
    },
  })
  const tool = ctx.registered[0]

  const agent = {}
  const first = await tool.execute({}, { agent })
  const second = await tool.execute({}, { agent })
  const refreshed = await tool.execute({ refresh: true }, { agent })

  assert.equal(checks, 2)
  assert.equal(first.status, 'ready')
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.match(second.message, /Reused this session's cached environment check/)
  assert.equal(refreshed.cached, false)
})

test('falls back to runtime-process detection when the instance registry is empty', async () => {
  const makeCtx = () => mockCtx({
    tabbit: { launcherPath: () => process.execPath, instances: () => [] },
  })

  const readyCtx = makeCtx()
  installer.registerInstallerTool(readyCtx, {
    detect: async () => SUPPORTED,
    detectRuntime: () => [{ pid: 301, name: 'node.exe' }],
  })
  const ready = await readyCtx.registered[0].execute({}, { agent: {} })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.runtimeProcessCount, 1)

  const restartCtx = makeCtx()
  installer.registerInstallerTool(restartCtx, {
    detect: async () => SUPPORTED,
    detectRuntime: () => [],
  })
  const restart = await restartCtx.registered[0].execute({}, { agent: {} })
  assert.equal(restart.status, 'restart-required')
  assert.match(restart.message, /Runtime Service is not reachable/)
})

test('starts one background download when no supported Tabbit is installed', async () => {
  const startCalls = []
  let jobStatus = 'running'
  const ctx = mockCtx({
    tabbit: { launcherPath: () => process.execPath, instances: () => [] },
    jobs: {
      start(options) {
        startCalls.push(options)
        return 'job-1'
      },
      get: () => ({ status: jobStatus }),
    },
  })
  installer.registerInstallerTool(ctx, {
    detect: async () => ({ installations: [], supportedInstallations: [] }),
  })
  const tool = ctx.registered[0]

  const agent = {}
  const first = await tool.execute({}, { agent })
  assert.equal(first.status, 'background')
  assert.equal(first.jobId, 'job-1')
  assert.match(first.message, /No stable Tabbit edition is installed\./)
  assert.equal(startCalls.length, 1)
  assert.equal(startCalls[0].kind, 'tabbit-installer')

  // 下载还在跑：不重复起第二单。
  const second = await tool.execute({}, { agent })
  assert.equal(second.status, 'background')
  assert.match(second.message, /already running as job-1/)
  assert.equal(startCalls.length, 1)
})

test('records a declined version through the update tool', async () => {
  const dismissed = []
  const ctx = mockCtx()
  installer.registerUpdateTool(ctx, {
    checkUpdate: async () => ({ status: 'current', currentVersion: '0.3.0' }),
    dismiss: async version => { dismissed.push(version) },
    env: {},
  })
  const tool = ctx.registered[0]

  const result = await tool.execute({ dismiss: '0.4.0' }, {})
  assert.equal(result.status, 'dismissed')
  assert.equal(result.dismissedVersion, '0.4.0')
  assert.deepEqual(dismissed, ['0.4.0'])
})

test('reports the update state and honors refresh through the update tool', async () => {
  const calls = []
  const ctx = mockCtx()
  installer.registerUpdateTool(ctx, {
    checkUpdate: async options => {
      calls.push(options)
      return {
        status: 'update-available',
        currentVersion: '0.3.0',
        latestVersion: '0.4.0',
        changelog: 'Added things.',
      }
    },
    dismiss: async () => ({}),
    env: {},
  })
  const tool = ctx.registered[0]

  const result = await tool.execute({ refresh: true }, {})
  assert.equal(result.status, 'update-available')
  assert.equal(result.latestVersion, '0.4.0')
  assert.match(result.message, /Ask the user whether to update now/)
  assert.deepEqual(calls, [{ force: true }])
})

test('the update tool defers to the browser for managed (preinstalled) copies', async () => {
  let checked = 0
  const ctx = mockCtx()
  installer.registerUpdateTool(ctx, {
    checkUpdate: async () => {
      checked += 1
      return { status: 'current', currentVersion: '0.3.0' }
    },
    dismiss: async () => ({}),
    env: { TABBIT_PLAYWRIGHT_INSTANCE: 'DB9322BEB5C4102A' },
  })
  const result = await ctx.registered[0].execute({ refresh: true }, {})
  assert.equal(result.status, 'browser-managed')
  assert.match(result.message, /managed by Tabbit Browser/)
  assert.equal(checked, 0)
})

test('serves one bundled tabbit skill from SKILL.md frontmatter', async () => {
  // 置托管环境变量让 get() 的更新检查短路（不读缓存、不发网络请求），
  // 保证本测试确定性；用完恢复。
  const saved = process.env.TABBIT_PLAYWRIGHT_INSTANCE
  process.env.TABBIT_PLAYWRIGHT_INSTANCE = 'TESTTESTTESTTEST'
  try {
    const candidates = await skillProvider.list()
    assert.equal(candidates.length, 1)
    const candidate = candidates[0]
    // 名字与浏览器共享 skill（~/.agents/skills/tabbit）相同是刻意的：
    // dsh 同名去重让共享版（user-agents 层/rank 500）优先，本包 rank 600
    // 的副本自动成为"没装/老浏览器"时的兜底。
    assert.equal(candidate.name, 'tabbit')
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.rank, 600)
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
    assert.match(candidate.description, /tabbit_browser/)
    assert.match(candidate.resourceBase.path, /skills[\\/]tabbit[\\/]$/)

    assert.equal(await skillProvider.get({ name: 'other-skill' }), undefined)

    const skill = await skillProvider.get({ name: 'tabbit' })
    assert.match(skill.content, /^# Tabbit Browser operation/m)
    assert.match(skill.content, /## Plugin updates/)
    assert.doesNotMatch(skill.content, /^---$/m)
    assert.doesNotMatch(skill.content, /Plugin update available/)
  } finally {
    if (saved === undefined) delete process.env.TABBIT_PLAYWRIGHT_INSTANCE
    else process.env.TABBIT_PLAYWRIGHT_INSTANCE = saved
  }
})
