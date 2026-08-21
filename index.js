import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createDownloadJob, detectTabbit } from './installer.js'
import { checkPluginUpdate, dismissUpdate } from './update-check.js'

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

export function formatUpdateNotice({ currentVersion, latestVersion, changelog }) {
  return [
    `> **Plugin update available**: tabbit-browser ${latestVersion} (installed ${currentVersion}).`,
    changelog ? `> New in ${latestVersion}: ${changelog}` : null,
    '> Show the offered version and these changes to the user, then ask whether to update now.',
    '> If they agree, tell them to rerun the install command below over the current install and restart the DSH session afterwards:',
    '> ```bash',
    '> dsh plugin --profile web add github:Tabbit-Browser/dsh-plugin',
    '> ```',
    `> If they decline, call \`tabbit_plugin_update\` with \`dismiss: "${latestVersion}"\`, then continue the task.`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function prependUpdateNotice(content, checkUpdate) {
  let update
  try {
    update = await checkUpdate()
  } catch {
    return content
  }
  if (update?.status !== 'update-available') return content
  return `${formatUpdateNotice(update)}\n\n${content}`
}

export function createSkillProvider({ checkUpdate = checkPluginUpdate } = {}) {
  return {
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
        content: await prependUpdateNotice(stripFrontmatter(source), checkUpdate),
      }
    },
  }
}

function stripFrontmatter(source) {
  if (!source.startsWith('---\n')) return source
  const end = source.indexOf('\n---\n', 4)
  return end === -1 ? source : source.slice(end + 5)
}

export const name = 'tabbit-browser'
export const inject = ['skills', 'tools', 'jobs']

export function describeCliSandbox(platform = process.platform) {
  if (platform === 'win32') {
    return {
      cliSandboxMode: 'default',
      cliSandboxReason: 'Invoke tabbit-cli normally. Only if its Runtime connection probe returns BROWSER_RUNTIME_UNAVAILABLE while Tabbit Browser and the Runtime process are detected, ask the user to change the current DSH session to Full Permission and stop the task.',
    }
  }
  return {
    cliSandboxMode: 'default',
    cliSandboxReason: 'The default DSH sandbox mode can invoke tabbit-cli on this platform.',
  }
}

function withCliSandboxGuidance(message, platform) {
  const diagnosis = describeCliSandbox(platform)
  return {
    ...diagnosis,
    message,
  }
}

export function apply(ctx, options = {}) {
  ctx.skills.registerProvider(() => createSkillProvider(options))
  registerInstallerTool(ctx)
  registerUpdateTool(ctx, options)
}

function messageForUpdate(update) {
  if (update.status === 'update-available') {
    const changes = update.changelog || 'see the release notes'
    return `tabbit-browser ${update.latestVersion} is available (installed ${update.currentVersion}). New in this version: ${changes}. Ask the user whether to update now.`
  }
  if (update.status === 'current') {
    return `The tabbit-browser plugin is up to date (${update.currentVersion}).`
  }
  return 'Could not determine the latest tabbit-browser plugin version. The check stays silent for a day before retrying.'
}

export function registerUpdateTool(ctx, {
  checkUpdate = checkPluginUpdate,
  dismiss = dismissUpdate,
} = {}) {
  ctx.tools.register({
    name: 'tabbit_plugin_update',
    description: 'Record that the user declined an offered tabbit-browser plugin version, or force a recheck of the latest plugin release. The skill already loads an update notice automatically when a newer version exists; call this tool only after the user declines an offered version, or after a plugin update or connectivity change.',
    parameters: {
      type: 'object',
      properties: {
        dismiss: {
          type: 'string',
          description: 'The offered version the user declined. The skill stops announcing this version; a newer release is announced again.',
        },
        refresh: {
          type: 'boolean',
          description: 'Skip the daily cache and the failure backoff and check the latest release again.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['current', 'update-available', 'unknown', 'dismissed'],
          },
          message: { type: 'string' },
          currentVersion: { type: 'string' },
          latestVersion: { type: 'string' },
          changelog: { type: 'string' },
          dismissedVersion: { type: 'string' },
        },
        required: ['status', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      if (args.dismiss) {
        await dismiss(args.dismiss)
        return {
          status: 'dismissed',
          message: `Recorded that the user declined tabbit-browser ${args.dismiss}. The skill will stop announcing this version; a newer release will be announced again.`,
          dismissedVersion: args.dismiss,
        }
      }
      const update = await checkUpdate({ force: args.refresh === true })
      return {
        status: update.status,
        message: messageForUpdate(update),
        currentVersion: update.currentVersion,
        ...(update.latestVersion ? { latestVersion: update.latestVersion } : {}),
        ...(update.changelog ? { changelog: update.changelog } : {}),
      }
    },
  })
}

export function registerInstallerTool(ctx, {
  detect = detectTabbit,
  hostPlatform = process.platform,
} = {}) {
  const activeJobs = new WeakMap()
  const readyByOwner = new WeakMap()

  ctx.tools.register({
    name: 'tabbit_browser_install',
    description: 'Check stable Tabbit editions, require version 1.9.0 or newer, verify the tabbit-cli launcher and Runtime process, and diagnose how to perform the session-scoped CLI connection probe. A successful detection result is cached for the calling agent session; set refresh only after a Runtime/launcher failure or installation change. Download the region-appropriate installer in the background when Tabbit is missing or outdated; otherwise report when the browser must be restarted once.',
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Discard this agent session\'s cached ready result and run every environment check again. Use only after a Runtime/launcher failure or installation change.',
        },
      },
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
          cached: { type: 'boolean' },
          jobId: { type: 'string' },
          cliReady: { type: 'boolean' },
          cliSandboxMode: {
            type: 'string',
            enum: ['default', 'danger-full-access'],
          },
          cliSandboxReason: { type: 'string' },
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
        required: ['status', 'message', 'cached', 'cliSandboxMode', 'cliSandboxReason'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args = {}, exec) {
      const owner = exec.agent
      if (owner && args.refresh === true) readyByOwner.delete(owner)
      if (owner && args.refresh !== true) {
        const cached = readyByOwner.get(owner)
        if (cached) {
          return {
            ...cached,
            cached: true,
            message: 'Browser installation and Runtime-process detection reused this session\'s result. Run the normal tabbit-cli tasks connection probe to finish the environment check.',
          }
        }
      }
      const existingJobId = owner ? activeJobs.get(owner) : undefined
      if (existingJobId) {
        try {
          const snapshot = ctx.jobs.get(existingJobId, owner)
          if (snapshot.status === 'running' || snapshot.status === 'stopping') {
            return {
              status: 'background',
              ...withCliSandboxGuidance(`Environment check failed: a Tabbit installer download is already running as ${existingJobId}.`, hostPlatform),
              cached: false,
              jobId: String(existingJobId),
            }
          }
        } catch {
          activeJobs.delete(owner)
        }
      }

      const detected = await detect()
      if (detected.recommendation === 'ready') {
        const versions = detected.supportedInstallations
          .map(item => `${item.name} ${item.version}`)
          .join(', ')
        const instanceNote = detected.playwrightRuntimeAmbiguous
          ? ` Multiple Tabbit instances are running (${detected.playwrightInstanceCount}); set TABBIT_PLAYWRIGHT_INSTANCE before invoking tabbit-cli.`
          : ''
        const result = {
          status: 'ready',
          ...withCliSandboxGuidance(`Browser installation and Runtime-process detection passed${versions ? ` (${versions})` : ''}.${instanceNote} Run the normal tabbit-cli tasks connection probe to finish the environment check.`, detected.platform),
          cached: false,
          cliReady: detected.cliReady,
          minimumVersion: detected.minimumVersion,
          playwrightProcessRunning: detected.playwrightProcessRunning,
          playwrightInstanceCount: detected.playwrightInstanceCount,
          playwrightRuntimeAmbiguous: detected.playwrightRuntimeAmbiguous,
          installations: detected.installations,
        }
        if (owner) readyByOwner.set(owner, result)
        return result
      }
      if (detected.recommendation === 'restart-required') {
        const versions = detected.supportedInstallations
          .map(item => `${item.name} ${item.version}`)
          .join(', ')
        return {
          status: 'restart-required',
          ...withCliSandboxGuidance(`Environment check failed: ${versions} meets the minimum version ${detected.minimumVersion}, but the tabbit-cli Runtime is not running. Please restart Tabbit Browser once before using browser automation.`, detected.platform),
          cached: false,
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
        ...withCliSandboxGuidance(`Environment check failed: ${downloadReason} Started the region-appropriate Tabbit installer download as ${jobId}. DSH will report progress and notify you when the installer is ready.`, detected.platform),
        cached: false,
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
