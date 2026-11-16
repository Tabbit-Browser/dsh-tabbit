// Tabbit CLI launcher 底层调用（lib/runtime/cli.js）的单元测试。
//
// 用一个假 launcher（node 脚本）逐条镜像真 CLI 的输出契约（见 cli.ts 文件头）：
// - 成功：stdout 一个 JSON 值、退出码 0；
// - 应用层失败：stderr 一行 JSON {"ok":false,"error":{name,code,message}}；
// - 外壳层失败：stderr 纯文本、退出码 69；
// - 页面代码求值失败：真因 JSON 在上、退出码 70（issue #29 实测：
// runCli 只解码 stderr 时这类失败只剩裸 CLI_FAILED + 退出码，无从自查）。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { chmod, mkdtemp, rm, writeFile} from 'node:fs/promises'
import { tmpdir} from 'node:os'
import { join} from 'node:path'

import { runCli} from '../lib/runtime/cli.js'
import { TabbitCliError} from '../lib/runtime/errors.js'

/*
* 假 launcher：先把 stdin 读到 EOF（真 launcher 的契约），再按环境变量
* FAKE_CLI_SCENARIO 选择一种输出形态。runCli 会把当前进程 env 复制给子进程，
* 所以测试用 process.env 切换场景即可，不需要为每个场景写一份脚本。
*/
const FAKE_LAUNCHER = `#!/usr/bin/env node
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk})
process.stdin.on('end', () => {
const scenario = process.env.FAKE_CLI_SCENARIO
const done = (code) => { process.exitCode = code}
if (scenario === 'ok') {
process.stdout.write(JSON.stringify({ hello: 'world'}), () => done(0))
} else if (scenario === 'stdout-error-json') {
process.stdout.write(JSON.stringify({
error: { name: 'TypeError', code: 'REQUEST_FAILED', message: "Cannot read properties of undefined (reading 'url')"},
}), () => done(70))
} else if (scenario === 'stdout-envelope') {
process.stdout.write(JSON.stringify({
status: 'failed', error: 'page exploded while evaluating', errorCode: 'REQUEST_FAILED',
}), () => done(70))
} else if (scenario === 'stdout-plain') {
process.stdout.write('weird failure with no structure at all', () => done(70))
} else if (scenario === 'stderr-json') {
process.stderr.write(JSON.stringify({
ok: false, error: { name: 'Error', code: 'TASK_TIMEOUT', message: 'Task timed out'},
}), () => done(70))
} else if (scenario === 'stderr-plain-69') {
process.stderr.write('multiple Tabbit instances found; set TABBIT_PLAYWRIGHT_INSTANCE', () => done(69))
} else {
process.stderr.write('unknown scenario', () => done(1))
}
})
`

/* 模块加载时就把假 launcher 落盘（顶层 await 先于所有测试执行）。 */
const fakeDir = await mkdtemp(join(tmpdir(), 'dsh-tabbit-cli-'))
const launcherPath = join(fakeDir, 'fake-tabbit-cli.mjs')
await writeFile(launcherPath, FAKE_LAUNCHER, 'utf8')
await chmod(launcherPath, 0o755)
after(() => rm(fakeDir, { recursive: true, force: true }))

/* 跑一次假调用并返回抛出的 TabbitCliError；不抛错就让测试失败。 */
async function runExpectingError(scenario) {
process.env.FAKE_CLI_SCENARIO = scenario
try {
await runCli(['nodejs'], 'return 1', { launcherPath, timeoutMs: 10_000})
} catch (error) {
assert.ok(error instanceof TabbitCliError, `expected TabbitCliError, got ${error}`)
return error
} finally {
delete process.env.FAKE_CLI_SCENARIO
}
assert.fail(`scenario ${scenario} should have thrown`)
}

test('成功路径：stdout 的 JSON 值原样返回', async () => {
process.env.FAKE_CLI_SCENARIO = 'ok'
try {
const value = await runCli(['nodejs'], 'return 1', { launcherPath, timeoutMs: 10_000})
assert.deepEqual(value, { hello: 'world'})
} finally {
delete process.env.FAKE_CLI_SCENARIO
}
})

test('stdout 错误 JSON（退出码 70）：真因的 code/message 被透出，而不是裸 CLI_FAILED', async () => {
const error = await runExpectingError('stdout-error-json')
assert.equal(error.code, 'REQUEST_FAILED')
assert.equal(error.kind, 'app')
assert.match(error.message, /Cannot read properties of undefined/)
assert.equal(error.exitCode, 70)
assert.match(error.stdoutRaw, /TypeError/)
})

test('stdout 失败信封（退出码 70）：字符串 error 与 errorCode 被透出', async () => {
const error = await runExpectingError('stdout-envelope')
assert.equal(error.code, 'REQUEST_FAILED')
assert.match(error.message, /page exploded while evaluating/)
assert.equal(error.exitCode, 70)
})

test('stdout 非 JSON（退出码 70）：CLI_FAILED 的信息里带上 stdout 原文摘录供自查', async () => {
const error = await runExpectingError('stdout-plain')
assert.equal(error.code, 'CLI_FAILED')
assert.match(error.message, /weird failure with no structure/)
assert.match(error.stdoutRaw, /weird failure with no structure/)
})

test('stderr 错误 JSON（既有路径）：分类与 code 不变', async () => {
const error = await runExpectingError('stderr-json')
assert.equal(error.code, 'TASK_TIMEOUT')
assert.equal(error.kind, 'timeout')
assert.match(error.message, /Task timed out/)
})

test('stderr 纯文本 + 退出码 69（既有路径）：仍归为实例选择问题', async () => {
const error = await runExpectingError('stderr-plain-69')
assert.equal(error.code, 'INSTANCE_SELECTION')
assert.equal(error.kind, 'instance-selection')
})
