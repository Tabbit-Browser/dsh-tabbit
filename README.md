# tabbit-browser for DeepSeek Harness

**English** | [简体中文](README.zh-CN.md)

![Tabbit Browser for DeepSeek Harness](tabbit-for-dsh.png?v=2)

A plugin for DeepSeek Harness (DSH) that gives the agent control over your Tabbit Browser: real pages, real login state, and real interactions, driven through `tabbit-cli` — the task-isolated Playwright CLI owned by the browser itself. Use it for web automation, information extraction, QA, and benchmarks.

## What you get

| Component | Description |
| --------- | ----------- |
| `tabbit-browser` skill | The working guide for browser automation: persistent task spaces, locators and waits, screenshots, receipts and recovery. Discovered and loaded automatically with the plugin — no separate skill install. The model loads it via `skill({ name: "tabbit-browser" })` or `/tabbit-browser`. |
| `tabbit_browser_install` tool | Environment preflight: detects installed stable Tabbit editions, requires version `1.9.0` or newer, and verifies the `tabbit-cli` resident runtime. When Tabbit is missing or outdated, it starts a DSH background job that downloads the region-appropriate installer. |
| `tabbit_plugin_update` tool | Plugin update check: compares the installed plugin version with the published changelog at most once a day, silently skips offline failures, and records a version the user declined. When a newer release exists, the skill loads with an update notice showing what the new version added. |

## Installation

### 1. Check or install DeepSeek Harness

Check whether DSH is already installed:

```sh
dsh --version
```

If the command prints a version number, continue to the next step. If it is not found, install it for your operating system.

#### macOS

Install Node.js 20 or newer, then install DSH:

```sh
brew install node
npm install -g @deepseek-ai/dsh
```

#### Windows

Install Node.js LTS in PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Reopen PowerShell after the installation, then install DSH:

```powershell
npm install -g @deepseek-ai/dsh
```

Run `dsh --version` again to confirm DSH works.

### 2. Install the tabbit-browser plugin

```sh
dsh plugin --profile web add github:Tabbit-Browser/dsh-plugin
```

### 3. Start DSH

```sh
dsh web
```

## How it works

After installation, the bundle automatically registers its skill provider. The model loads the skill via `skill({ name: "tabbit-browser" })` or `/tabbit-browser`. Before the first browser operation in a task, the skill calls `tabbit_browser_install`:

- **`ready`** — a stable Tabbit edition at `1.9.0` or newer is installed and the runtime is running; the agent continues with the `tabbit-cli` workflow.
- **`restart-required`** — the installed version is sufficient, but the `tabbit-cli` runtime is not running; the user is asked to restart Tabbit Browser once.
- **`background`** — no stable edition is installed, or none reaches `1.9.0`; the tool starts a DSH background job that reads the operating system's configured region (macOS reads the system locale, Windows calls the system region API) and downloads the matching stable installer: the domestic build from `tabbit.com` for mainland China, or the international build from `tabbit.ai` for every other or unknown region. It selects the right Windows x64, macOS Apple Silicon, or macOS Intel package, saves it to the user's `Downloads` folder, reports download progress, and notifies the absolute installer path on completion.

The environment check also:

- Treats the runtime as available when multiple Tabbit instances are running; the agent sets `TABBIT_PLAYWRIGHT_INSTANCE` from the CLI's hint instead of reporting the instance ambiguity as an unavailable runtime.
- Diagnoses the DSH sandbox mode required to invoke the CLI on the current platform: Windows reports `cliSandboxMode: danger-full-access`, other platforms report `default`.
- Caches a successful environment check per agent session and re-checks only after a Runtime/launcher failure or an installation change, via `refresh: true`.

## Requirements

- A stable Tabbit Browser at version `1.9.0` or newer: either the international `Tabbit` or the domestic `Tabbit Browser` — installing either one is enough. If it is missing or outdated, the plugin downloads the installer for you.
- The current DSH profile provides `ctx.skills`, `ctx.tools`, and `ctx.jobs` together with the corresponding model tools.
- `dsh-tool-jobs` provides background job control and completion notifications for the current agent.
- The current DSH profile provides a Bash/Shell tool running on the same host machine as Tabbit Browser.
- The shell's execution environment can reach the Browser-owned Runtime Service.
- On Windows, DSH's `read-only` and `workspace-write` restricted tokens cannot write to the Runtime named pipe. The skill first runs the normal `tabbit-cli tasks` connection probe and requests no permission at all when it succeeds. Only when the Browser, launcher, and Runtime processes are all detected but the connection returns `BROWSER_RUNTIME_UNAVAILABLE` does it ask the user to switch the current DSH session to Full Permission — and it then stops the task immediately, without retrying or continuing browser operations.

## Notes and limitations

- Mainland China uses the domestic `tabbit.com` download source; all other regions use the international `tabbit.ai` source.
- The background download reports progress and notifies the absolute installer path when it finishes. It never opens the `.dmg`/`.exe` automatically.
- Development builds are not detected.
- The plugin does not provide native browser tools such as `tabbit_browser_evaluate`.
- If DSH's Bash runs in a sandbox such as E2B or a remote container that cannot access the local GUI browser, this skill cannot make Tabbit automation work there.

## Development

```sh
npm test
npm pack --dry-run
```

## License

MIT
