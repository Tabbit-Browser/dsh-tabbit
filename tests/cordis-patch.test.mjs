import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

test('cordis.patch.yml references the published package name', async () => {
  const source = await readFile(
    new URL('../cordis.patch.yml', import.meta.url),
    'utf8',
  )
  assert.match(source, /name:\s+dsh-tabbit/)
  assert.doesNotMatch(source, /name:\s+tabbit-browser/)
})

test('package name matches the loader entry', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  assert.equal(pkg.name, 'dsh-tabbit')
})
