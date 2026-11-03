// 验证宿主真实所有者契约，避免宽松 mock 掩盖参数类型不兼容。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import semver from 'semver'
import { registerInstallerTool } from '../lib/installer/index.js'
import { apply } from '../lib/core/index.js'

for (const legacy of [false, true]) {
  test(`background download uses ${legacy ? 'legacy Agent' : 'session ID'} ownership`, async () => {
    const agent = { id: 'session-1' }
    const expected = legacy ? agent : agent.id
    let starts = 0
    let lookups = 0
    let tool
    const jobs = {
      ...(legacy ? { onJobDone() {} } : { events: {} }),
      start(spec) {
        assert.equal(spec.owner, starts === 1 ? undefined : expected)
        starts++
        return 'download-1'
      },
      get(id, caller) {
        assert.equal(id, 'download-1')
        assert.equal(caller, expected)
        lookups++
        return { status: 'running' }
      },
    }
    registerInstallerTool({ tools: { register(value) { tool = value } }, jobs }, {
      detect: async () => ({ installations: [], supportedInstallations: [] }),
    })
    const first = await tool.execute({}, { agent })
    assert.equal(first.jobId, 'download-1')
    const second = await tool.execute({}, { agent })
    assert.match(second.message, /already running/)
    assert.equal(starts, 1)
    assert.equal(lookups, 1)
    // 无 Agent 的调用仍作为无主任务注册。
    assert.equal((await tool.execute({}, {})).jobId, 'download-1')
  })
}

test('peer ranges accept supported DSH prereleases and preserve the host floor', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    for (const version of ['0.1.1-rc.2', '0.1.2-alpha.1', '0.1.3-alpha.1', '0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.2']) {
      assert.ok(semver.satisfies(version, range), `${name} must accept ${version}`)
    }
    for (const version of ['0.1.0', '0.1.1-rc.1', '0.1.2-alpha.0']) {
      assert.ok(!semver.satisfies(version, range), `${name} must reject ${version}`)
    }
  }
})

test('core does not subscribe to the commands service', () => {
  const dependencies = []
  apply({
    settings: { register: () => ({ get: () => ({}) }) },
    provide() {}, on() {}, effect() {}, logger: { warn() {}, info() {} },
    inject(names) { dependencies.push(...names) },
  })
  assert.ok(!dependencies.includes('commands'))
})
