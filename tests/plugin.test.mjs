import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../index.js'

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
  assert.match(candidates[0].resourceBase.path, /skills\/tabbit-browser\/$/)

  const skill = await provider.get(candidates[0])
  assert.equal(skill.name, 'tabbit-browser')
  assert.match(skill.content, /^# Tabbit Browser/m)
  assert.doesNotMatch(skill.content, /^---$/m)
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.match(skill.path, /skills\/tabbit-browser\/SKILL\.md$/)
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
