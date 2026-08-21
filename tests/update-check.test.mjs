import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkPluginUpdate,
  compareVersions,
  dismissUpdate,
  parseLatestChangelog,
  readCachedCheck,
  summarizeUpdate,
  truncateChangelog,
} from '../update-check.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

async function withCacheFile(run) {
  const dir = await mkdtemp(join(tmpdir(), 'tabbit-update-check-'))
  try {
    await run(join(dir, 'update-check.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function releaseFeed(version, changelog = 'Plugin update.') {
  let fetches = 0
  const fetchRelease = async () => {
    fetches += 1
    return { version, changelog }
  }
  return { fetchRelease, count: () => fetches }
}

test('compares dotted numeric versions', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
  assert.equal(compareVersions('v0.2.1', '0.2.0'), 1)
  assert.equal(compareVersions('0.2', '0.2.1'), -1)
  assert.equal(compareVersions('garbage', '0.2.0'), undefined)
})

test('flattens and truncates release notes', () => {
  assert.equal(truncateChangelog('  added   update\n\nchecks  '), 'added update checks')
  const long = truncateChangelog('x'.repeat(600))
  assert.equal(long.length, 500)
  assert.ok(long.endsWith('…'))
})

test('parses the newest version section from the changelog', () => {
  const markdown = [
    '# Changelog',
    '',
    '## 0.3.0',
    '',
    '- Added update',
    '  checks.',
    '',
    '## 0.2.0',
    '',
    '- Older release.',
  ].join('\n')
  assert.deepEqual(
    parseLatestChangelog(markdown),
    { version: '0.3.0', changelog: '- Added update checks.' },
  )
  assert.deepEqual(
    parseLatestChangelog('## v0.3.0\n\nOnly section.\n'),
    { version: '0.3.0', changelog: 'Only section.' },
  )
  assert.throws(() => parseLatestChangelog('# No version headings'), /heading/)
})

test('summarizes the update state', () => {
  assert.equal(summarizeUpdate({ currentVersion: '0.2.0' }).status, 'unknown')
  assert.equal(summarizeUpdate({ latestVersion: '0.3.0' }).status, 'unknown')
  assert.equal(
    summarizeUpdate({ currentVersion: '0.3.0', latestVersion: '0.3.0' }).status,
    'current',
  )
  assert.equal(
    summarizeUpdate({
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      dismissedVersion: '0.3.0',
    }).status,
    'current',
  )
  const available = summarizeUpdate({
    currentVersion: '0.2.0',
    latestVersion: '0.3.0',
    changelog: 'New things.',
  })
  assert.equal(available.status, 'update-available')
  assert.equal(available.changelog, 'New things.')
})

test('reuses a fresh successful check without any request', async () => {
  await withCacheFile(async cacheFile => {
    const feed = releaseFeed('0.3.0')
    const first = await checkPluginUpdate({
      now: 1_000_000,
      cacheFile,
      fetchRelease: feed.fetchRelease,
      readVersion: async () => '0.2.0',
    })
    const second = await checkPluginUpdate({
      now: 1_000_000 + DAY_MS - 1,
      cacheFile,
      fetchRelease: feed.fetchRelease,
      readVersion: async () => '0.2.0',
    })
    assert.equal(first.status, 'update-available')
    assert.equal(second.status, 'update-available')
    assert.equal(feed.count(), 1)
    const state = await readCachedCheck(cacheFile)
    assert.equal(state.latestVersion, '0.3.0')
    assert.equal(state.checkedAt, 1_000_000)
  })
})

test('checks again one day after a successful check', async () => {
  await withCacheFile(async cacheFile => {
    const feed = releaseFeed('0.3.0')
    const options = {
      cacheFile,
      fetchRelease: feed.fetchRelease,
      readVersion: async () => '0.2.0',
    }
    await checkPluginUpdate({ ...options, now: 1_000_000 })
    await checkPluginUpdate({ ...options, now: 1_000_000 + DAY_MS })
    assert.equal(feed.count(), 2)
  })
})

test('backs off silently for a day after a failed check', async () => {
  await withCacheFile(async cacheFile => {
    let fetches = 0
    const fetchRelease = async () => {
      fetches += 1
      throw new Error('offline')
    }
    const options = {
      fetchRelease,
      readVersion: async () => '0.2.0',
      cacheFile,
    }
    const failed = await checkPluginUpdate({ ...options, now: 1_000_000 })
    const backedOff = await checkPluginUpdate({ ...options, now: 1_000_000 + DAY_MS - 1 })
    assert.equal(failed.status, 'unknown')
    assert.equal(backedOff.status, 'unknown')
    assert.equal(fetches, 1)
    const retried = await checkPluginUpdate({ ...options, now: 1_000_000 + DAY_MS })
    assert.equal(fetches, 2)
    assert.equal(retried.status, 'unknown')
  })
})

test('reports current for a dismissed or already-installed release', async () => {
  await withCacheFile(async cacheFile => {
    const feed = releaseFeed('0.2.0', 'Same version.')
    const result = await checkPluginUpdate({
      now: 1_000_000,
      cacheFile,
      fetchRelease: feed.fetchRelease,
      readVersion: async () => '0.2.0',
    })
    assert.equal(result.status, 'current')
  })

  await withCacheFile(async cacheFile => {
    const feed = releaseFeed('0.3.0')
    await checkPluginUpdate({
      now: 1_000_000,
      cacheFile,
      fetchRelease: feed.fetchRelease,
      readVersion: async () => '0.2.0',
    })
    await dismissUpdate('0.3.0', { cacheFile })
    const afterDismiss = await checkPluginUpdate({
      now: 1_000_000 + 1,
      cacheFile,
      fetchRelease: feed.fetchRelease,
      readVersion: async () => '0.2.0',
    })
    assert.equal(afterDismiss.status, 'current')
    const state = await readCachedCheck(cacheFile)
    assert.equal(state.dismissedVersion, '0.3.0')
    assert.equal(state.latestVersion, '0.3.0')
  })
})

test('force skips the daily cache and rechecks immediately', async () => {
  await withCacheFile(async cacheFile => {
    const feed = releaseFeed('0.3.0')
    const options = {
      cacheFile,
      fetchRelease: feed.fetchRelease,
      readVersion: async () => '0.2.0',
    }
    await checkPluginUpdate({ ...options, now: 1_000_000 })
    await checkPluginUpdate({ ...options, now: 1_000_000 + 1, force: true })
    assert.equal(feed.count(), 2)
  })
})
