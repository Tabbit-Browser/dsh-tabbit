import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import {
  createDownloadJob,
  detectMacInstallations,
  detectPlatformSpec,
  detectSystemRegion,
  detectTabbit,
  detectWindowsInstallations,
  downloadInstaller,
  installerDistributionForRegion,
  installerUrl,
  isVersionAtLeast,
  normalizeRegionCode,
  parseUnixProcessList,
  parseWindowsProcessList,
  parseWindowsUninstallRegistry,
  summarizeTabbitRuntime,
} from '../installer.js'

test('maps supported platforms and detects Apple Silicon under Rosetta', () => {
  assert.deepEqual(
    detectPlatformSpec({ platform: 'darwin', arch: 'arm64' }),
    {
      platform: 'mac',
      arch: 'ARM_64',
      extension: '.dmg',
      fallbackName: 'Tabbit Browser Installer ARM64.dmg',
    },
  )
  assert.equal(
    detectPlatformSpec({
      platform: 'darwin',
      arch: 'x64',
      run: () => ({ status: 0, stdout: '1\n' }),
    }).arch,
    'ARM_64',
  )
  assert.equal(
    detectPlatformSpec({
      platform: 'win32',
      arch: 'ia32',
      env: { PROCESSOR_ARCHITEW6432: 'AMD64' },
    }).arch,
    'x86_64',
  )
  assert.throws(
    () => detectPlatformSpec({ platform: 'win32', arch: 'arm64', env: {} }),
    /unavailable/,
  )
})

test('selects domestic and international DSH installer endpoints by region', () => {
  const spec = { platform: 'mac', arch: 'ARM_64' }
  const domestic = new URL(installerUrl(spec, installerDistributionForRegion('CN')))
  const international = new URL(installerUrl(spec, installerDistributionForRegion('US')))

  assert.equal(domestic.origin, 'https://www.tabbit.com')
  assert.equal(international.origin, 'https://www.tabbit.ai')
  assert.equal(international.searchParams.get('platform'), 'mac')
  assert.equal(international.searchParams.get('arch'), 'ARM_64')
  assert.equal(international.searchParams.get('tab_brand'), 'dshr')
  assert.equal(international.searchParams.get('utm_source'), 'dsh')
  assert.equal(installerDistributionForRegion(undefined), 'international')
})

test('reads the configured region through the macOS and Windows system APIs', () => {
  assert.equal(normalizeRegionCode('zh-Hans_CN'), 'CN')
  assert.equal(normalizeRegionCode('en-US'), 'US')
  assert.equal(normalizeRegionCode('zh'), 'ZH')

  const macCommands = []
  assert.equal(detectSystemRegion({
    platform: 'darwin',
    run(command, args) {
      macCommands.push([command, args])
      return { status: 0, stdout: 'zh-Hans_CN\n' }
    },
  }), 'CN')
  assert.deepEqual(macCommands[0], ['/usr/bin/defaults', ['read', '-g', 'AppleLocale']])

  const windowsCommands = []
  assert.equal(detectSystemRegion({
    platform: 'win32',
    run(command, args) {
      windowsCommands.push([command, args])
      return { status: 0, stdout: 'US\r\n' }
    },
  }), 'US')
  assert.equal(windowsCommands[0][0], 'powershell.exe')
  assert.match(windowsCommands[0][1].at(-1), /Get-WinHomeLocation/)
})

test('macOS detection recognizes only stable domestic and international apps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tabbit-detect-'))
  const userHome = join(root, 'home')
  const applications = join(userHome, 'Applications')
  const bundles = new Map([
    ['Tabbit.app', 'com.tabbit-ai.Tabbit'],
    ['Tabbit Browser.app', 'com.tab-browser.Tabbit'],
    ['Tabbit Dev.app', 'com.tabbit-ai.Tabbit.dev'],
    ['Tabbit Browser Dev.app', 'com.tab-browser.Tabbit.dev'],
  ])
  try {
    for (const name of bundles.keys()) {
      const directory = join(applications, name, 'Contents')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'Info.plist'), 'fixture')
    }
    const run = (_command, args) => {
      const appName = basename(join(args.at(-1), '..', '..'))
      const key = args[1]
      if (key === 'CFBundleIdentifier') return { status: 0, stdout: bundles.get(appName) ?? '' }
      if (key === 'CFBundleShortVersionString') return { status: 0, stdout: '1.2.3' }
      return { status: 1, stdout: '' }
    }
    const found = await detectMacInstallations({ userHome, run })
    assert.deepEqual(found.map(item => item.name).sort(), ['Tabbit', 'Tabbit Browser'])
    assert.ok(found.every(item => item.channel === 'stable'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows uninstall parsing ignores development builds', () => {
  const output = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Tabbit
    DisplayName    REG_SZ    Tabbit
    DisplayVersion    REG_SZ    1.9.18.0
    InstallLocation    REG_SZ    C:\Users\User\AppData\Local\Tabbit
    DisplayIcon    REG_SZ    "C:\Users\User\AppData\Local\Tabbit\Application\Tabbit.exe",0

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\TabbitBrowser
    DisplayName    REG_SZ    Tabbit Browser
    DisplayVersion    REG_SZ    1.9.18.0
    InstallLocation    REG_SZ    C:\Users\User\AppData\Local\Tabbit Browser

HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\TabbitDev
    DisplayName    REG_SZ    Tabbit Dev
    InstallLocation    REG_SZ    C:\Users\User\AppData\Local\Tabbit Dev
`
  const found = parseWindowsUninstallRegistry(output)
  assert.deepEqual(found.map(item => item.name), ['Tabbit', 'Tabbit Browser'])
  assert.ok(found.every(item => item.channel === 'stable'))
  assert.equal(found[0].executable, String.raw`C:\Users\User\AppData\Local\Tabbit\Application\Tabbit.exe`)
})

test('uses targeted Windows uninstall keys before the recursive fallback', () => {
  const calls = []
  const output = String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Tabbit Browser
    DisplayName    REG_SZ    Tabbit Browser
    DisplayVersion    REG_SZ    1.9.22.0
    InstallLocation    REG_SZ    C:\Tabbit Browser
`
  const found = detectWindowsInstallations({
    run(_command, args) {
      calls.push(args)
      return args[1].endsWith('Tabbit Browser') && args.at(-1) === '/reg:64'
        ? { status: 0, stdout: output }
        : { status: 1, stdout: '' }
    },
  })

  assert.deepEqual(found.map(item => item.name), ['Tabbit Browser'])
  assert.equal(calls.some(args => args.includes('/s')), false)
})

test('falls back to recursive Windows uninstall scans for generated keys', () => {
  const calls = []
  const output = String.raw`HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\{generated}
    DisplayName    REG_SZ    Tabbit
    DisplayVersion    REG_SZ    1.9.22.0
    InstallLocation    REG_SZ    C:\Tabbit
`
  const found = detectWindowsInstallations({
    run(_command, args) {
      calls.push(args)
      return args.includes('/s')
        ? { status: 0, stdout: output }
        : { status: 1, stdout: '' }
    },
  })

  assert.deepEqual(found.map(item => item.name), ['Tabbit'])
  assert.equal(calls.some(args => args.includes('/s')), true)
})

test('compares Tabbit versions against 1.9.0 numerically', () => {
  assert.equal(isVersionAtLeast('1.9.0', '1.9.0'), true)
  assert.equal(isVersionAtLeast('1.9.18.0', '1.9.0'), true)
  assert.equal(isVersionAtLeast('1.10.0', '1.9.0'), true)
  assert.equal(isVersionAtLeast('1.8.19.0', '1.9.0'), false)
  assert.equal(isVersionAtLeast(undefined, '1.9.0'), false)
})

test('recognizes only persistent Browser Runtime Service processes', () => {
  const unix = parseUnixProcessList(`
    101 node /opt/tabbit/runtime/browser-runtime-service.mjs
    102 Tabbit /Applications/Tabbit.app/Contents/MacOS/Tabbit
    103 tabbit-cli /Users/user/.local/bin/tabbit-cli tasks
    104 node /opt/tabbit/runtime/nodejs-playwright-runtime.mjs
    105 node /tmp/something-else.mjs
  `)
  assert.deepEqual(unix, [
    { pid: 101, name: 'node' },
    { pid: 104, name: 'node' },
  ])

  const windows = parseWindowsProcessList(JSON.stringify([
    {
      ProcessId: 201,
      Name: 'node.exe',
      CommandLine: String.raw`"C:\Tabbit\node.exe" "C:\Tabbit\runtime\browser-runtime-service.mjs" --browser-transport="{}"`,
    },
    { ProcessId: 202, Name: 'Tabbit.exe', CommandLine: String.raw`C:\Tabbit\Tabbit.exe` },
    { ProcessId: 203, Name: 'tabbit-cli.exe', CommandLine: String.raw`C:\Tabbit\tabbit-cli.exe tasks` },
    { ProcessId: 204, Name: 'tabbit-playwright-cli.exe', CommandLine: String.raw`C:\Tabbit\tabbit-playwright-cli.exe tasks` },
  ]))
  assert.deepEqual(windows, [{ pid: 201, name: 'node.exe' }])
})

test('treats multiple runtime processes as running but ambiguous', () => {
  assert.deepEqual(
    summarizeTabbitRuntime([{ pid: 101 }, { pid: 102 }, { pid: 103 }]),
    { instanceCount: 3, running: true, ambiguous: true },
  )
  assert.deepEqual(
    summarizeTabbitRuntime([]),
    { instanceCount: 0, running: false, ambiguous: false },
  )
})

test('Windows readiness requires the public launcher under LOCALAPPDATA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tabbit-windows-preflight-'))
  const localAppData = join(root, 'redirected-local-app-data')
  const launcher = join(localAppData, 'Tabbit', 'LocalAgent', 'bin', 'tabbit-cli.exe')
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(launcher, 'launcher')

  let cimScript = ''
  const run = (command, args) => {
    if (command === 'reg.exe') {
      return {
        status: 0,
        stdout: String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Tabbit
    DisplayName    REG_SZ    Tabbit
    DisplayVersion    REG_SZ    1.9.22.0
    InstallLocation    REG_SZ    C:\Tabbit
`,
      }
    }
    if (command === 'powershell.exe' && args.at(-1).includes('Get-CimInstance')) {
      cimScript = args.at(-1)
      return {
        status: 0,
        stdout: JSON.stringify({
          ProcessId: 301,
          Name: 'node.exe',
          CommandLine: String.raw`"C:\Tabbit\node.exe" "C:\Tabbit\runtime\browser-runtime-service.mjs" --browser-transport="{}"`,
        }),
      }
    }
    return { status: 1, stdout: '' }
  }

  try {
    const ready = await detectTabbit({
      platform: 'win32',
      userHome: join(root, 'profile'),
      env: { LOCALAPPDATA: localAppData },
      run,
    })
    assert.equal(ready.cliPath, launcher)
    assert.equal(ready.playwrightProcessRunning, true)
    assert.equal(ready.recommendation, 'ready')
    assert.match(cimScript, /Get-CimInstance Win32_Process -Filter/)
    assert.match(cimScript, /browser-runtime-service\.mjs/)

    const missingLauncher = await detectTabbit({
      platform: 'win32',
      userHome: join(root, 'profile'),
      env: { LOCALAPPDATA: join(root, 'missing-local-app-data') },
      run,
    })
    assert.equal(missingLauncher.cliReady, false)
    assert.equal(missingLauncher.playwrightProcessRunning, true)
    assert.equal(missingLauncher.recommendation, 'restart-required')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('requires a supported stable version before checking the runtime process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tabbit-preflight-'))
  const userHome = join(root, 'home')
  const contents = join(userHome, 'Applications', 'Tabbit.app', 'Contents')
  const launcher = join(userHome, '.local', 'bin', 'tabbit-cli')
  await mkdir(contents, { recursive: true })
  await writeFile(join(contents, 'Info.plist'), 'fixture')
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(launcher, 'launcher')
  await chmod(launcher, 0o700)

  let version = '1.8.19.0'
  let processChecks = 0
  const run = (command, args) => {
    if (command === '/usr/bin/plutil') {
      const appName = basename(join(args.at(-1), '..', '..'))
      if (appName !== 'Tabbit.app') return { status: 1, stdout: '' }
      return args[1] === 'CFBundleIdentifier'
        ? { status: 0, stdout: 'com.tabbit-ai.Tabbit' }
        : { status: 0, stdout: version }
    }
    if (command === 'ps') {
      processChecks += 1
      return { status: 0, stdout: '42 node /opt/runtime/nodejs-playwright-runtime.mjs\n' }
    }
    return { status: 1, stdout: '' }
  }

  try {
    const outdated = await detectTabbit({ platform: 'darwin', userHome, run })
    assert.equal(outdated.recommendation, 'download')
    assert.equal(processChecks, 0)

    version = '1.9.0'
    const ready = await detectTabbit({ platform: 'darwin', userHome, run })
    assert.equal(ready.recommendation, 'ready')
    assert.equal(ready.playwrightProcessRunning, true)

    const restart = await detectTabbit({
      platform: 'darwin',
      userHome,
      run(command, args) {
        const result = run(command, args)
        return command === 'ps' ? { status: 0, stdout: '' } : result
      },
    })
    assert.equal(restart.recommendation, 'restart-required')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function fakeResponse(bytes, {
  url = 'https://pkg.tabbit.com/Tabbit.exe',
  filename = 'Tabbit Browser.exe',
} = {}) {
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename="${filename}"`,
    }),
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes.subarray(0, 2)
        yield bytes.subarray(2)
      },
    },
  }
}

test('downloads, verifies, and atomically exposes a Windows installer', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'tabbit-download-'))
  try {
    const bytes = Buffer.from('MZfake-signed-installer')
    const progress = []
    const result = await downloadInstaller({
      outputDirectory,
      fetchImpl: async () => fakeResponse(bytes),
      platformOptions: { platform: 'win32', arch: 'x64', env: {} },
      onProgress: value => progress.push(value),
    })
    assert.equal(result.path, join(outputDirectory, 'Tabbit Browser.exe'))
    assert.deepEqual(await readFile(result.path), bytes)
    assert.equal(progress.at(-1).percent, 100)
    assert.equal(result.distribution, 'international')
    assert.equal(result.region, 'unknown')
    assert.match(result.sourceUrl, /^https:\/\/www\.tabbit\.ai\//)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

test('background job reports the final installer path', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'tabbit-job-'))
  try {
    const job = createDownloadJob({
      outputDirectory,
      fetchImpl: async () => fakeResponse(Buffer.from('MZjob-installer')),
      platformOptions: { platform: 'win32', arch: 'x64', env: {} },
    })
    const outcome = await job.done
    assert.equal(outcome.status, 'completed')
    assert.match(job.readOutput(), /TABBIT_INSTALLER_READY/)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})
