import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrateLegacySettings } from '../lib/core/legacy-settings.js'

for (const modern of [false, true]) {
  test(`migrates legacy settings once with the ${modern ? 'symbol' : 'legacy'} Cordis root`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'tabbit-legacy-'))
    const profile = await mkdtemp(join(tmpdir(), 'tabbit-profile-'))
    t.after(() => Promise.all([home, profile].map(path => rm(path, { recursive: true, force: true }))))
    await writeFile(join(home, 'settings.yaml.imported'), [
      'tabbit:',
      '  instance: ABCDEF0123456789',
      '  launcherPath: /tmp/tabbit cli',
      '  pageAccess: always',
      '  intranetFetch: never',
      '',
    ].join('\n'))
    const updates = []
    const ctx = {
      get: name => name === 'profileContext' ? { home, dir: profile } : undefined,
      [modern ? Symbol.for('cordis.root') : 'root']: { loader: { await: async () => {} } },
      settings: {
        describe: () => [{ ns: 'tabbit-browser', user: { pageAccess: 'never' }, revision: 7 }],
        update: async (...args) => { updates.push(args) },
      },
    }
    if (modern) Object.defineProperty(ctx, 'root', { get() { throw new Error('removed Cordis API') } })
    await migrateLegacySettings(ctx)
    await migrateLegacySettings(ctx)
    assert.deepEqual(updates, [[
      'tabbit-browser',
      { instance: 'ABCDEF0123456789', launcherPath: '/tmp/tabbit cli', intranetFetch: 'never' },
      7,
    ]])
    assert.equal(await readFile(join(profile, '.dsh-tabbit-settings-migrated'), 'utf8'), 'migrated\n')
  })
}
