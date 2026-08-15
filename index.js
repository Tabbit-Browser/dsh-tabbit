import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createDownloadJob, detectTabbit } from './installer.js'

const PROVIDER_NAME = 'tabbit-browser-bundled-skill'
const SKILL_NAME = 'tabbit-browser'
const SKILL_DESCRIPTION = 'Control the user\'s Tabbit Browser through its Browser-owned, task-isolated Playwright CLI and runtime helpers. Use for Tabbit browser automation, website interaction, extraction, QA, and benchmarks, including stable-browser version checks, runtime-process checks, and background installer download when Tabbit is absent or outdated; never silently fall back to another browser automation backend.'
const SKILL_URL = new URL('./skills/tabbit-browser/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('./skills/tabbit-browser/', import.meta.url)),
}
const INVOCATION = { modelInvocable: true, userInvocable: true }

// DSH reserves rank 600 for skills shipped inside a package.
const BUNDLED_SKILL_RANK = 600

const candidate = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_URL,
}

const provider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([candidate]),
  async get(selected) {
    if (selected.name !== SKILL_NAME) return undefined
    const source = await readFile(SKILL_URL, 'utf8')
    return {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      invocation: INVOCATION,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: RESOURCE_BASE,
      path: fileURLToPath(SKILL_URL),
      content: stripFrontmatter(source),
    }
  },
}

function stripFrontmatter(source) {
  if (!source.startsWith('---\n')) return source
  const end = source.indexOf('\n---\n', 4)
  return end === -1 ? source : source.slice(end + 5)
}

export const name = 'tabbit-browser'
export const inject = ['skills', 'tools', 'jobs']

export function apply(ctx) {
  ctx.skills.registerProvider(() => provider)
  registerInstallerTool(ctx)
}

function registerInstallerTool(ctx) {
  const activeJobs = new WeakMap()

  ctx.tools.register({
    name: 'tabbit_browser_install',
    description: 'Check stable Tabbit editions, require version 1.9.0 or newer, and verify the tabbit-cli runtime process. Download the region-appropriate installer in the background when Tabbit is missing or outdated; otherwise report when the browser must be restarted once.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['ready', 'restart-required', 'background'],
          },
          message: { type: 'string' },
          jobId: { type: 'string' },
          cliReady: { type: 'boolean' },
          minimumVersion: { type: 'string' },
          playwrightProcessRunning: { type: 'boolean' },
          playwrightInstanceCount: { type: 'integer' },
          playwrightRuntimeAmbiguous: { type: 'boolean' },
          installations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                edition: { type: 'string', enum: ['international', 'domestic'] },
                channel: { type: 'string', const: 'stable' },
                path: { type: 'string' },
                executable: { type: 'string' },
                version: { type: 'string' },
                bundleId: { type: 'string' },
                registryKey: { type: 'string' },
              },
              required: ['name', 'edition', 'channel'],
              additionalProperties: false,
            },
          },
        },
        required: ['status', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const owner = exec.agent
      const existingJobId = owner ? activeJobs.get(owner) : undefined
      if (existingJobId) {
        try {
          const snapshot = ctx.jobs.get(existingJobId, owner)
          if (snapshot.status === 'running' || snapshot.status === 'stopping') {
            return {
              status: 'background',
              message: `Environment check failed: a Tabbit installer download is already running as ${existingJobId}.`,
              jobId: String(existingJobId),
            }
          }
        } catch {
          activeJobs.delete(owner)
        }
      }

      const detected = await detectTabbit()
      if (detected.recommendation === 'ready') {
        const versions = detected.supportedInstallations
          .map(item => `${item.name} ${item.version}`)
          .join(', ')
        const instanceNote = detected.playwrightRuntimeAmbiguous
          ? ` Multiple Tabbit instances are running (${detected.playwrightInstanceCount}); set TABBIT_PLAYWRIGHT_INSTANCE before invoking tabbit-cli.`
          : ''
        return {
          status: 'ready',
          message: `Environment check passed. Tabbit is ready${versions ? ` (${versions})` : ''}.${instanceNote}`,
          cliReady: detected.cliReady,
          minimumVersion: detected.minimumVersion,
          playwrightProcessRunning: detected.playwrightProcessRunning,
          playwrightInstanceCount: detected.playwrightInstanceCount,
          playwrightRuntimeAmbiguous: detected.playwrightRuntimeAmbiguous,
          installations: detected.installations,
        }
      }
      if (detected.recommendation === 'restart-required') {
        const versions = detected.supportedInstallations
          .map(item => `${item.name} ${item.version}`)
          .join(', ')
        return {
          status: 'restart-required',
          message: `Environment check failed: ${versions} meets the minimum version ${detected.minimumVersion}, but the tabbit-cli Runtime is not running. Please restart Tabbit Browser once before using browser automation.`,
          cliReady: detected.cliReady,
          minimumVersion: detected.minimumVersion,
          playwrightProcessRunning: false,
          playwrightInstanceCount: detected.playwrightInstanceCount,
          playwrightRuntimeAmbiguous: detected.playwrightRuntimeAmbiguous,
          installations: detected.installations,
        }
      }

      const downloadReason = detected.installations.length === 0
        ? 'No stable Tabbit edition is installed.'
        : `Installed stable Tabbit version(s) do not meet the minimum ${detected.minimumVersion}: ${detected.installations.map(item => `${item.name} ${item.version ?? 'unknown'}`).join(', ')}.`

      let jobId
      jobId = ctx.jobs.start({
        kind: 'tabbit-installer',
        label: 'Download the region-appropriate Tabbit installer',
        outputLimitBytes: 16 * 1024,
        owner,
        run: () => createDownloadJob({
          onSettled: () => {
            if (owner && activeJobs.get(owner) === jobId) activeJobs.delete(owner)
          },
        }),
      })
      if (owner) activeJobs.set(owner, jobId)
      return {
        status: 'background',
        message: `Environment check failed: ${downloadReason} Started the region-appropriate Tabbit installer download as ${jobId}. DSH will report progress and notify you when the installer is ready.`,
        jobId: String(jobId),
        cliReady: detected.cliReady,
        minimumVersion: detected.minimumVersion,
        playwrightProcessRunning: false,
        playwrightInstanceCount: detected.playwrightInstanceCount,
        playwrightRuntimeAmbiguous: detected.playwrightRuntimeAmbiguous,
        installations: detected.installations,
      }
    },
  })
}
