// 验证宿主真实所有者契约，避免宽松 mock 掩盖参数类型不兼容。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
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

test('host packages are shared without version constraints or npm auto-installation', async () => {
  const { dependencies, peerDependencies, peerDependenciesMeta } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  for (const name of ['cordis', 'dsh-llm', 'dsh-settings', 'dsh-tools', 'dsh-web', 'schemastery']) {
    assert.ok(Object.hasOwn(peerDependencies, `@deepseek-ai/${name}`), `${name} must be shared with DSH`)
  }
  for (const [name, range] of Object.entries(peerDependencies)) {
    assert.equal(range, '*', `${name} must accept the host's version`)
    assert.equal(dependencies[name], undefined, `${name} must come from the host`)
    assert.equal(peerDependenciesMeta[name]?.optional, true, `npm must not auto-install ${name}`)
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
