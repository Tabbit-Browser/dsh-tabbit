import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TabbitCliError, TabbitClient } from '../lib/runtime/client.js'
import { apply as applyBrowserTool } from '../lib/tool-browser/index.js'

const instanceId = 'AAAA0000BBBB1111'
const taskId = 'task-' + randomUUID()
const json = value => JSON.stringify('b64:' + Buffer.from(JSON.stringify(value), 'utf8').toString('base64'))

test('Tabbit 1.22 results on disk retain Chinese text and obey the read limit', async t => {
  const dir = await mkdtemp(fileURLToPath(new URL('./.receipt-', import.meta.url)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const client = new TabbitClient({ instanceId })
  client.listInstances = () => [{ id: instanceId, online: true, endpointPath: join(dir, 'endpoint.json') }]
  const artifactDir = join(dir, 'Runtime', 'artifacts', taskId)
  await mkdir(artifactDir, { recursive: true })
  const path = join(artifactDir, 'result-' + randomUUID() + '.json')
  const value = { text: '测试正文'.repeat(3000) }
  const data = json(value)
  await writeFile(path, data, 'utf8')
  client.invoke = async ([command]) => {
    assert.equal(command, 'nodejs')
    return { status: 'succeeded', task: { taskId, taskName: 'probe' }, result: { path, byteLength: data.length, mimeType: 'application/json' } }
  }
  const request = { task: 'probe', code: 'return 1' }
  assert.equal((await client.evaluate(request)).result.value?.text.length, value.text.length)
  const limited = await client.evaluate({ ...request, maxResultBytes: 512 })
  assert.equal(limited.result.truncated, true)
  assert.match(limited.result.rawText, /测试正文/u)

  const privateFile = join(dir, 'outside.json')
  await writeFile(privateFile, data, 'utf8')
  client.invoke = async () => ({ status: 'succeeded', result: { path: privateFile, byteLength: data.length } })
  await assert.rejects(client.evaluate(request), { code: 'BAD_RESULT_FILE' })
  if (process.platform !== 'win32') {
    const link = join(artifactDir, 'result-' + randomUUID() + '.json')
    await symlink(privateFile, link)
    client.invoke = async () => ({ status: 'succeeded', result: { path: link, byteLength: data.length } })
    await assert.rejects(client.evaluate(request), { code: 'BAD_RESULT_FILE' })
  }
})

test('Tabbit 1.22 claim and finish retry only the rejected legacy option', async () => {
  const client = new TabbitClient()
  const commands = []
  client.invoke = async argv => {
    commands.push(argv)
    if (argv.includes('--tab')) {
      throw new TabbitCliError({
        kind: 'request-failed', code: 'CLI_INVALID_ARGUMENT',
        message: 'Unknown option or argument "--tab". Use --claim tab:<id>.\nUsage: tabbit-cli claim --task <name> --claim tab:<id>|group:<id> [--claim ...]',
      })
    }
    if (argv.includes('--keep')) {
      throw new TabbitCliError({
        kind: 'request-failed', code: 'CLI_INVALID_ARGUMENT',
        message: 'Unknown option or argument "--keep". Accepted options: --task, --discard.\nUsage: tabbit-cli finish --task <name> [--discard]',
      })
    }
    return { groupId: 17, ownedPageCount: 3 }
  }
  assert.deepEqual(await client.claimTabs('probe', [17, 18]), { groupId: '17', ownedPageCount: 3 })
  await client.finishTask('probe', { keep: true })
  assert.deepEqual(commands, [
    ['claim', '--task', 'probe', '--tab', '17', '--tab', '18'],
    ['claim', '--task', 'probe', '--claim', 'tab:17', '--claim', 'tab:18'],
    ['finish', '--task', 'probe', '--keep'],
    ['finish', '--task', 'probe'],
  ])
})

test('an expired browser task can be recreated with the requested tabs', async () => {
  let tool
  let request
  applyBrowserTool({
    tools: { register(value) { tool = value } },
    tabbit: {
      sessionTasks: () => ['probe'],
      rememberSessionTask() {},
      client: () => ({
        async claimTabs() {
          throw new TabbitCliError({ kind: 'request-failed', code: 'REQUEST_FAILED', message: 'Unknown task name: probe' })
        },
        resolvedInstanceId: () => instanceId,
        async evaluate(input) {
          request = input
          return { status: 'succeeded', result: { value: 1 }, notes: [] }
        },
      }),
    },
  })
  const result = await tool.execute({ task: 'probe', code: 'return 1', claim_tabs: [17] }, { agent: { id: 'session' } })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(request.claimTabs, [17])
})
