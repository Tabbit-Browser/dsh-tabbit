// bundle 补丁层与包清单的一致性测试：补丁行名必须是可解析的模块说明符
// （0.2.1/0.2.2 世代曾因行名写成不存在的包名导致 fresh install 全挂，
// 0.2.3 修复——这组测试防止同类回归）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/* 抠出补丁里所有插件行的 name（跳过注释行）。 */
function patchRowNames(source) {
  return source
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .map(line => line.match(/^\s+name:\s+(\S+)\s*$/)?.[1])
    .filter(Boolean)
}

test('every patch row name resolves through the published package exports', () => {
  const names = patchRowNames(patch)
  assert.ok(names.length >= 6, `expected at least 6 plugin rows, found ${names.length}`)
  for (const name of names) {
    assert.ok(
      name === pkg.name || name.startsWith(`${pkg.name}/`),
      `patch row "${name}" does not belong to package ${pkg.name}`,
    )
    const exportKey = name === pkg.name ? '.' : `./${name.slice(pkg.name.length + 1)}`
    assert.ok(pkg.exports[exportKey], `patch row "${name}" has no matching export "${exportKey}"`)
  }
})

test('the bare package-name row exists for dsh-web client discovery', () => {
  // dsh-web 的客户端模块扫描只解析【裸包名】行——靠它发现 package.json 的
  // dsh.client 字段并服务 client/client.js（@tab 提及前端）。
  assert.ok(patchRowNames(patch).includes(pkg.name))
})

test('package name matches the published loader entry', () => {
  assert.equal(pkg.name, 'dsh-tabbit')
  assert.doesNotMatch(patch, /name:\s+tabbit-browser\s*$/m)
})

test('the web row inherits host config and only overrides the registered fetch provider', async () => {
  const webRow = patch.slice(patch.lastIndexOf('\n- id: web\n'))
  const providerSource = await readFile(new URL('../src/web-fetch/index.ts', import.meta.url), 'utf8')
  const providerId = providerSource.match(/readonly id = '([^']+)'/)?.[1]
  assert.ok(providerId)
  assert.match(webRow, /searchProvider: !!js ctx\.tabbitInheritedSearchProvider\(ctx\)/)
  assert.ok(webRow.includes(`fetchProvider: ${providerId}`))
})
