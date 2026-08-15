import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024
export const MINIMUM_TABBIT_VERSION = '1.9.0'
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'www.tabbit.com',
  'pkg.tabbit.com',
  'releases.tabbit.com',
  'www.tabbit.ai',
  'pkg.tabbit.ai',
  'releases.tabbit.ai',
])

const INSTALLER_ORIGINS = {
  domestic: 'https://www.tabbit.com',
  international: 'https://www.tabbit.ai',
}

const DOWNLOADS = {
  'win32:x64': {
    platform: 'windows',
    arch: 'x86_64',
    extension: '.exe',
    fallbackName: 'Tabbit Browser Installer.exe',
  },
  'darwin:arm64': {
    platform: 'mac',
    arch: 'ARM_64',
    extension: '.dmg',
    fallbackName: 'Tabbit Browser Installer ARM64.dmg',
  },
  'darwin:x64': {
    platform: 'mac',
    arch: 'x86_64',
    extension: '.dmg',
    fallbackName: 'Tabbit Browser Installer Intel.dmg',
  },
}

const MAC_APPLICATIONS = [
  {
    name: 'Tabbit',
    bundleId: 'com.tabbit-ai.Tabbit',
    edition: 'international',
    channel: 'stable',
  },
  {
    name: 'Tabbit Browser',
    bundleId: 'com.tab-browser.Tabbit',
    edition: 'domestic',
    channel: 'stable',
  },
]

const WINDOWS_DISPLAY_NAMES = new Map([
  ['Tabbit', { edition: 'international', channel: 'stable' }],
  ['Tabbit Browser', { edition: 'domestic', channel: 'stable' }],
])

export function normalizeRegionCode(value) {
  const locale = String(value ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .split('@', 1)[0]
  if (/^[a-z]{2}$/i.test(locale)) return locale.toUpperCase()
  return locale.match(/(?:_|-)([a-z]{2})$/i)?.[1].toUpperCase()
}

export function detectSystemRegion({
  platform = process.platform,
  run = spawnSync,
} = {}) {
  if (platform === 'darwin') {
    const result = run('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], {
      encoding: 'utf8',
    })
    return result.status === 0 ? normalizeRegionCode(result.stdout) : undefined
  }

  if (platform === 'win32') {
    const script = '([System.Globalization.RegionInfo]::new((Get-WinHomeLocation).GeoId)).TwoLetterISORegionName'
    const result = run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true },
    )
    return result.status === 0 ? normalizeRegionCode(result.stdout) : undefined
  }

  return undefined
}

export function installerDistributionForRegion(regionCode) {
  return normalizeRegionCode(regionCode) === 'CN' ? 'domestic' : 'international'
}

export function installerUrl(spec, distribution = 'international') {
  const origin = INSTALLER_ORIGINS[distribution]
  if (!origin) throw new Error(`Unknown Tabbit installer distribution: ${distribution}.`)
  const query = new URLSearchParams({
    platform: spec.platform,
    arch: spec.arch,
    tab_brand: 'dshr',
    utm_source: 'dsh',
  })
  return `${origin}/api/v0/upgrade/installer?${query}`
}

export function detectPlatformSpec({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  run = spawnSync,
} = {}) {
  let nativeArch = arch

  if (platform === 'darwin' && arch === 'x64') {
    const result = run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], {
      encoding: 'utf8',
    })
    if (result.status === 0 && result.stdout.trim() === '1') nativeArch = 'arm64'
  }

  if (platform === 'win32') {
    const reported = String(
      env.PROCESSOR_ARCHITEW6432 ?? env.PROCESSOR_ARCHITECTURE ?? arch,
    ).toLowerCase()
    nativeArch = reported === 'amd64' || reported === 'x86_64' ? 'x64' : arch
  }

  const spec = DOWNLOADS[`${platform}:${nativeArch}`]
  if (!spec) {
    throw new Error(`Tabbit Browser installer is unavailable for ${platform}/${nativeArch}.`)
  }
  return { ...spec }
}

async function exists(path, mode = constants.F_OK) {
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

function readPlistValue(plistPath, key, run = spawnSync) {
  const result = run(
    '/usr/bin/plutil',
    ['-extract', key, 'raw', '-o', '-', plistPath],
    { encoding: 'utf8' },
  )
  return result.status === 0 ? result.stdout.trim() : undefined
}

export async function detectMacInstallations({
  userHome = homedir(),
  run = spawnSync,
} = {}) {
  const roots = ['/Applications', join(userHome, 'Applications')]
  const installations = []
  const seenBundleIds = new Set()

  for (const app of MAC_APPLICATIONS) {
    for (const root of roots) {
      const path = join(root, `${app.name}.app`)
      const plistPath = join(path, 'Contents', 'Info.plist')
      if (!(await exists(plistPath))) continue
      const actualBundleId = readPlistValue(plistPath, 'CFBundleIdentifier', run)
      if (actualBundleId !== app.bundleId || seenBundleIds.has(app.bundleId)) continue
      const version = readPlistValue(plistPath, 'CFBundleShortVersionString', run)
      installations.push({
        ...app,
        path,
        ...(version ? { version } : {}),
      })
      seenBundleIds.add(app.bundleId)
    }
  }

  return installations
}

export function parseWindowsUninstallRegistry(output) {
  const installations = []
  let record = undefined

  const commit = () => {
    if (!record) return
    const identity = WINDOWS_DISPLAY_NAMES.get(record.DisplayName)
    if (!identity) return
    const icon = record.DisplayIcon
      ?.replace(/,\s*-?\d+$/, '')
      .replace(/^"(.*)"$/, '$1')
    installations.push({
      name: record.DisplayName,
      ...identity,
      ...(record.InstallLocation || icon ? { path: record.InstallLocation || icon } : {}),
      ...(icon ? { executable: icon } : {}),
      ...(record.DisplayVersion ? { version: record.DisplayVersion } : {}),
      registryKey: record.registryKey,
    })
  }

  for (const line of String(output).split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      commit()
      record = { registryKey: line.trim() }
      continue
    }
    if (!record) continue
    const match = line.match(/^\s+(DisplayName|DisplayVersion|InstallLocation|DisplayIcon)\s+REG_\w+\s+(.*)$/i)
    if (match) record[match[1]] = match[2].trim()
  }
  commit()
  return installations
}

export function detectWindowsInstallations({ run = spawnSync } = {}) {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const installations = []
  const seen = new Set()

  for (const root of roots) {
    for (const view of ['64', '32']) {
      const result = run('reg.exe', ['query', root, '/s', `/reg:${view}`], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
      if (result.status !== 0) continue
      for (const item of parseWindowsUninstallRegistry(result.stdout)) {
        const key = `${item.name}\0${item.path ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        installations.push(item)
      }
    }
  }
  return installations
}

async function detectCli(userHome = homedir(), platform = process.platform) {
  const candidates = platform === 'win32'
    ? [
        join(userHome, '.local', 'bin', 'tabbit-cli.cmd'),
        join(userHome, '.local', 'bin', 'tabbit-cli.exe'),
        join(userHome, '.local', 'bin', 'tabbit-cli'),
      ]
    : [join(userHome, '.local', 'bin', 'tabbit-cli')]

  for (const path of candidates) {
    if (await exists(path, platform === 'win32' ? constants.F_OK : constants.X_OK)) {
      return { ready: true, path }
    }
  }
  return { ready: false }
}

function numericVersion(version) {
  const match = String(version ?? '').trim().match(/^v?(\d+(?:\.\d+)*)/i)
  return match ? match[1].split('.').map(Number) : undefined
}

export function isVersionAtLeast(version, minimum = MINIMUM_TABBIT_VERSION) {
  const actual = numericVersion(version)
  const required = numericVersion(minimum)
  if (!actual || !required) return false
  const length = Math.max(actual.length, required.length)
  for (let index = 0; index < length; index += 1) {
    const left = actual[index] ?? 0
    const right = required[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}

function isTabbitRuntimeProcess(name, command) {
  const value = `${name ?? ''} ${command ?? ''}`
  return /(?:^|[\\/\s])tabbit-cli(?:\.cmd|\.exe)?(?:\s|$)/i.test(value)
    || /(?:^|[\\/\s])nodejs-playwright-runtime\.mjs(?:\s|$)/i.test(value)
}

export function parseUnixProcessList(output) {
  const processes = []
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/)
    if (!match || !isTabbitRuntimeProcess(match[2], match[3])) continue
    processes.push({ pid: Number(match[1]), name: match[2] })
  }
  return processes
}

export function parseWindowsProcessList(output) {
  if (!String(output).trim()) return []
  let records
  try {
    records = JSON.parse(output)
  } catch {
    return []
  }
  if (!Array.isArray(records)) records = [records]
  return records
    .filter(record => isTabbitRuntimeProcess(record.Name, record.CommandLine))
    .map(record => ({
      pid: Number(record.ProcessId),
      name: String(record.Name ?? ''),
    }))
}

export function detectTabbitPlaywrightProcesses({
  platform = process.platform,
  run = spawnSync,
} = {}) {
  if (platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return result.status === 0 ? parseWindowsProcessList(result.stdout) : []
  }

  const result = run('ps', ['-axo', 'pid=,comm=,args='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return result.status === 0 ? parseUnixProcessList(result.stdout) : []
}

export function summarizeTabbitRuntime(playwrightProcesses) {
  const instanceCount = Array.isArray(playwrightProcesses) ? playwrightProcesses.length : 0
  return {
    instanceCount,
    running: instanceCount > 0,
    ambiguous: instanceCount > 1,
  }
}

export async function detectTabbit({
  platform = process.platform,
  userHome = homedir(),
  run = spawnSync,
  minimumVersion = MINIMUM_TABBIT_VERSION,
} = {}) {
  const installations = platform === 'darwin'
    ? await detectMacInstallations({ userHome, run })
    : platform === 'win32'
      ? detectWindowsInstallations({ run })
      : []
  const cli = await detectCli(userHome, platform)
  const supportedInstallations = installations.filter(item => (
    isVersionAtLeast(item.version, minimumVersion)
  ))
  const playwrightProcesses = supportedInstallations.length > 0
    ? detectTabbitPlaywrightProcesses({ platform, run })
    : []
  const runtime = summarizeTabbitRuntime(playwrightProcesses)
  const recommendation = supportedInstallations.length === 0
    ? 'download'
    : runtime.running
      ? 'ready'
      : 'restart-required'
  return {
    platform,
    minimumVersion,
    cliReady: cli.ready,
    cliPath: cli.path,
    installations,
    supportedInstallations,
    playwrightProcessRunning: runtime.running,
    playwrightInstanceCount: runtime.instanceCount,
    playwrightRuntimeAmbiguous: runtime.ambiguous,
    playwrightProcesses,
    recommendation,
  }
}

function filenameFromResponse(response, spec) {
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  let candidate
  try {
    candidate = encoded ? decodeURIComponent(encoded) : plain
  } catch {
    candidate = plain
  }
  if (!candidate) {
    try {
      candidate = decodeURIComponent(basename(new URL(response.url).pathname))
    } catch {
      candidate = undefined
    }
  }
  const safe = basename(candidate || spec.fallbackName)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
  return safe.toLowerCase().endsWith(spec.extension) ? safe : spec.fallbackName
}

async function uniqueDestination(directory, filename) {
  const extensionIndex = filename.toLowerCase().lastIndexOf('.')
  const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : ''
  for (let index = 0; index < 1000; index += 1) {
    const candidate = join(directory, index === 0 ? filename : `${stem} (${index})${extension}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('Could not allocate a unique installer filename.')
}

async function verifyInstaller(path, spec, bytes) {
  const handle = await open(path, 'r')
  try {
    if (spec.extension === '.exe') {
      const header = Buffer.alloc(2)
      await handle.read(header, 0, 2, 0)
      if (header.toString('ascii') !== 'MZ') throw new Error('Downloaded file is not a Windows executable.')
      return
    }
    const trailer = Buffer.alloc(Math.min(512, bytes))
    await handle.read(trailer, 0, trailer.length, Math.max(0, bytes - trailer.length))
    if (trailer.subarray(0, 4).toString('ascii') !== 'koly') {
      throw new Error('Downloaded file is not a valid DMG image.')
    }
  } finally {
    await handle.close()
  }
}

export async function downloadInstaller({
  signal,
  onProgress = () => {},
  outputDirectory = join(homedir(), 'Downloads'),
  fetchImpl = fetch,
  platformOptions,
} = {}) {
  const spec = detectPlatformSpec(platformOptions)
  const regionCode = detectSystemRegion(platformOptions)
  const distribution = installerDistributionForRegion(regionCode)
  const sourceUrl = installerUrl(spec, distribution)
  await mkdir(outputDirectory, { recursive: true })

  const response = await fetchImpl(sourceUrl, { redirect: 'follow', signal })
  if (!response.ok || !response.body) throw new Error(`Installer download failed with HTTP ${response.status}.`)
  const finalUrl = new URL(response.url || sourceUrl)
  if (finalUrl.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
    throw new Error(`Installer redirected to an untrusted host: ${finalUrl.hostname || finalUrl.href}`)
  }

  const expectedBytes = Number(response.headers.get('content-length')) || undefined
  if (expectedBytes && expectedBytes > MAX_INSTALLER_BYTES) throw new Error('Installer exceeds the 1 GiB safety limit.')
  const filename = filenameFromResponse(response, spec)
  const destination = await uniqueDestination(outputDirectory, filename)
  const partial = `${destination}.${process.pid}.${Date.now()}.part`
  const handle = await open(partial, 'wx', 0o600)
  let receivedBytes = 0
  let lastPercent = -1
  let lastReportAt = 0

  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw signal.reason ?? new Error('Download cancelled.')
      receivedBytes += chunk.byteLength
      if (receivedBytes > MAX_INSTALLER_BYTES) throw new Error('Installer exceeds the 1 GiB safety limit.')
      await handle.write(chunk)

      const now = Date.now()
      const percent = expectedBytes ? Math.floor((receivedBytes / expectedBytes) * 100) : undefined
      if ((percent !== undefined && percent > lastPercent) || now - lastReportAt >= 1000) {
        lastPercent = percent ?? lastPercent
        lastReportAt = now
        onProgress({ receivedBytes, expectedBytes, percent })
      }
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(partial, { force: true })
    throw error
  }
  await handle.close()

  try {
    if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
      throw new Error(`Installer download was incomplete: received ${receivedBytes} of ${expectedBytes} bytes.`)
    }
    await verifyInstaller(partial, spec, receivedBytes)
    await rename(partial, destination)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }

  return {
    path: destination,
    bytes: receivedBytes,
    platform: spec.platform,
    arch: spec.arch,
    region: regionCode ?? 'unknown',
    distribution,
    sourceUrl,
  }
}

export function createDownloadJob(options = {}) {
  const controller = new AbortController()
  let pendingOutput = ''
  const append = (line) => {
    pendingOutput += `${line}\n`
  }
  const formatProgress = ({ receivedBytes, expectedBytes, percent }) => {
    append(`TABBIT_DOWNLOAD_PROGRESS ${JSON.stringify({ receivedBytes, expectedBytes, percent })}`)
  }

  const done = downloadInstaller({
    ...options,
    signal: controller.signal,
    onProgress: formatProgress,
  }).then(result => {
    append(`TABBIT_INSTALLER_READY ${JSON.stringify(result)}`)
    return { status: 'completed', detail: `installer saved to ${result.path}` }
  }).catch(error => {
    if (controller.signal.aborted) {
      append('Tabbit Browser installer download was cancelled.')
      return { status: 'killed', detail: 'download cancelled' }
    }
    append(`Tabbit Browser installer download failed: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 'failed', detail: 'download failed' }
  }).finally(() => options.onSettled?.())

  return {
    cancel: reason => controller.abort(new Error(reason || 'Download cancelled.')),
    done,
    readOutput() {
      const output = pendingOutput
      pendingOutput = ''
      return output
    },
  }
}
