import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 1500
const CHANGELOG_MAX_CHARS = 500
const DEFAULT_RELEASE_URL = 'https://api.github.com/repos/Tabbit-Browser/dsh-plugin/releases/latest'
const PACKAGE_URL = new URL('./package.json', import.meta.url)

let cachedLocalVersion

function numericVersion(version) {
  const match = String(version ?? '').trim().match(/^v?(\d+(?:\.\d+)*)/i)
  return match ? match[1].split('.').map(Number) : undefined
}

export function compareVersions(left, right) {
  const leftParts = numericVersion(left)
  const rightParts = numericVersion(right)
  if (!leftParts || !rightParts) return undefined
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0
    const b = rightParts[index] ?? 0
    if (a !== b) return a > b ? 1 : -1
  }
  return 0
}

export function flattenChangelog(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export function truncateChangelog(text) {
  const value = flattenChangelog(text)
  if (value.length <= CHANGELOG_MAX_CHARS) return value
  return `${value.slice(0, CHANGELOG_MAX_CHARS - 1).trimEnd()}…`
}

export function parseLatestRelease(payload) {
  const version = numericVersion(payload?.tag_name)?.join('.')
  if (!version) throw new Error('Latest release payload has no usable tag_name.')
  return { version, changelog: truncateChangelog(payload.body) }
}

export function defaultCacheFile(env = process.env, platform = process.platform) {
  const base = env.XDG_CACHE_HOME
    || (platform === 'win32'
      ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : undefined)
    || join(homedir(), '.cache')
  return join(base, 'tabbit-dsh', 'update-check.json')
}

export async function readLocalVersion() {
  if (cachedLocalVersion !== undefined) return cachedLocalVersion ?? undefined
  try {
    const parsed = JSON.parse(await readFile(PACKAGE_URL, 'utf8'))
    cachedLocalVersion = typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    cachedLocalVersion = null
  }
  return cachedLocalVersion ?? undefined
}

export async function readCachedCheck(cacheFile) {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeCachedCheck(cacheFile, state) {
  await mkdir(dirname(cacheFile), { recursive: true })
  await writeFile(cacheFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export async function fetchLatestRelease({
  url = process.env.TABBIT_PLUGIN_UPDATE_URL || DEFAULT_RELEASE_URL,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error(`Update check failed with HTTP ${response.status}.`)
    return parseLatestRelease(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

function isRecent(timestamp, now) {
  return typeof timestamp === 'number' && now - timestamp < DAY_MS
}

export function summarizeUpdate({
  currentVersion,
  latestVersion,
  changelog,
  dismissedVersion,
}) {
  if (!currentVersion || !latestVersion) return { status: 'unknown', currentVersion }
  if (compareVersions(latestVersion, currentVersion) !== 1 || latestVersion === dismissedVersion) {
    return { status: 'current', currentVersion, latestVersion }
  }
  return { status: 'update-available', currentVersion, latestVersion, changelog }
}

function summaryFromCache(currentVersion, cached) {
  return summarizeUpdate({
    currentVersion,
    latestVersion: cached.latestVersion,
    changelog: cached.changelog,
    dismissedVersion: cached.dismissedVersion,
  })
}

async function fetchAndCacheRelease({ currentVersion, cached, cacheFile, now, fetchRelease }) {
  const state = { ...cached, lastAttemptAt: now }
  try {
    const release = await fetchRelease()
    state.checkedAt = now
    state.latestVersion = release.version
    state.changelog = release.changelog
  } catch {
    // Keep lastAttemptAt so the failure stays silent for a day before retrying.
  }
  try {
    await writeCachedCheck(cacheFile, state)
  } catch {
    // A read-only cache must not break the check itself.
  }
  return summaryFromCache(currentVersion, state)
}

export async function checkPluginUpdate({
  now = Date.now(),
  cacheFile = defaultCacheFile(),
  fetchRelease = fetchLatestRelease,
  readVersion = readLocalVersion,
  force = false,
} = {}) {
  const currentVersion = await readVersion()
  const cached = await readCachedCheck(cacheFile)
  if (!force) {
    if (isRecent(cached.checkedAt, now) && cached.latestVersion) {
      return summaryFromCache(currentVersion, cached)
    }
    if (isRecent(cached.lastAttemptAt, now)) {
      return { status: 'unknown', currentVersion }
    }
  }
  return fetchAndCacheRelease({ currentVersion, cached, cacheFile, now, fetchRelease })
}

export async function dismissUpdate(version, {
  cacheFile = defaultCacheFile(),
} = {}) {
  const cached = await readCachedCheck(cacheFile)
  const state = { ...cached, dismissedVersion: String(version ?? '').trim() }
  await writeCachedCheck(cacheFile, state)
  return state
}
