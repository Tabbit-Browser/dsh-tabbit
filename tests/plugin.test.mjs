import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, describeCliSandbox, inject, name, registerInstallerTool } from '../index.js'

test('diagnoses the platform-specific CLI sandbox requirement', () => {
  assert.deepEqual(describeCliSandbox('win32'), {
    cliSandboxMode: 'default',
    cliSandboxReason: 'Invoke tabbit-cli normally. Only if its Runtime connection probe returns BROWSER_RUNTIME_UNAVAILABLE while Tabbit Browser and the Runtime process are detected, ask the user to change the current DSH session to Full Permission and stop the task.',
  })
  assert.deepEqual(describeCliSandbox('darwin'), {
    cliSandboxMode: 'default',
    cliSandboxReason: 'The default DSH sandbox mode can invoke tabbit-cli on this platform.',
  })
})

test('registers one bundled tabbit-browser skill', async () => {
  let factory
  let tool
  const ctx = {
    skills: {
      registerProvider(value) {
        factory = value
        return () => {}
      },
    },
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    jobs: {},
  }

  apply(ctx)

  assert.equal(name, 'tabbit-browser')
  assert.deepEqual(inject, ['skills', 'tools', 'jobs'])
  assert.equal(typeof factory, 'function')
  assert.equal(tool.name, 'tabbit_browser_install')
  assert.deepEqual(
    tool.output.schema.properties.status.enum,
    ['ready', 'restart-required', 'background'],
  )
  assert.deepEqual(
    tool.output.schema.properties.cliSandboxMode.enum,
    ['default', 'danger-full-access'],
  )
  assert.equal(tool.parameters.properties.refresh.type, 'boolean')
  assert.match(tool.description, /session-scoped CLI connection probe/)

  const provider = factory({})
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'tabbit-browser')
  assert.equal(candidates[0].source, 'bundled')
  assert.equal(candidates[0].rank, 600)
  assert.deepEqual(candidates[0].invocation, {
    modelInvocable: true,
    userInvocable: true,
  })
  assert.match(candidates[0].resourceBase.path, /skills[\\/]tabbit-browser[\\/]$/)

  const skill = await provider.get(candidates[0])
  assert.equal(skill.name, 'tabbit-browser')
  assert.match(skill.content, /^# Tabbit Browser/m)
  assert.match(skill.content, /Do not ask for Full Permission before a real CLI\s+connection failure/)
  assert.match(skill.content, /normal `tabbit-cli tasks`\s+connection probe/)
  assert.match(skill.content, /ask the user to change the current DSH session permission to Full Permission,\s+then stop the task/)
  assert.doesNotMatch(skill.content, /\/permission danger-full-access/)
  assert.doesNotMatch(skill.content, /sandbox_permissions/)
  assert.doesNotMatch(skill.content, /permission control/i)
  assert.doesNotMatch(skill.content, /^---$/m)
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.match(skill.path, /skills[\\/]tabbit-browser[\\/]SKILL\.md$/)
})

test('caches successful Browser and Runtime-process detection for the whole agent session', async () => {
  let tool
  let checks = 0
  registerInstallerTool({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    jobs: {},
  }, {
    hostPlatform: 'win32',
    async detect() {
      checks += 1
      return {
        platform: 'win32',
        recommendation: 'ready',
        minimumVersion: '1.9.0',
        cliReady: true,
        playwrightProcessRunning: true,
        playwrightInstanceCount: 1,
        playwrightRuntimeAmbiguous: false,
        installations: [],
        supportedInstallations: [],
      }
    },
  })

  const agent = {}
  const first = await tool.execute({}, { agent })
  const second = await tool.execute({}, { agent })
  const refreshed = await tool.execute({ refresh: true }, { agent })

  assert.equal(checks, 2)
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.match(second.message, /Runtime-process detection reused this session's result/)
  assert.equal(refreshed.cached, false)
})

test('does not load an unrelated candidate', async () => {
  let factory
  apply({
    skills: {
      registerProvider(value) {
        factory = value
        return () => {}
      },
    },
    tools: { register() {} },
    jobs: {},
  })

  const provider = factory({})
  assert.equal(await provider.get({ name: 'other-skill' }), undefined)
})
