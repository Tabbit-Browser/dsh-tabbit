# tabbit-browser for DeepSeek Harness

[English](README.md) | **简体中文**

![Tabbit Browser for DeepSeek Harness](tabbit-for-dsh.png?v=2)

这是一个为 DeepSeek Harness（DSH）打造的插件。安装后，DSH 中的 Agent 获得控制 Tabbit 浏览器的能力：通过 `tabbit-cli`——Tabbit 浏览器自带的、任务隔离的 Playwright CLI——操作真实网页、复用真实登录态，完成网页自动化、信息提取、QA 与基准测试等任务。

## 插件内容

| 组件 | 说明 |
| ---- | ---- |
| `tabbit-browser` skill | 浏览器自动化工作指南：持久化任务空间、locator 与等待、截图、回执与恢复。随插件安装自动发现和加载，无需单独安装。模型通过 `skill({ name: "tabbit-browser" })` 或 `/tabbit-browser` 加载。 |
| `tabbit_browser_install` 工具 | 环境预检：检测已安装的正式版 Tabbit、要求版本 ≥ `1.9.0`、检查 `tabbit-cli` 常驻运行时；未安装或版本过低时，创建 DSH 后台任务按地区下载对应安装包。 |
| `tabbit_plugin_update` 工具 | 插件更新检查：每天至多一次对比本地插件版本与 GitHub 最新 Release，离线失败时静默跳过，并可记录用户已拒绝的版本。存在新版本时，skill 会附带更新提示加载，展示新版本的新增功能。 |

## 安装

### 1. 检查并安装 DeepSeek Harness

先检查本地是否已经安装 DSH：

```sh
dsh --version
```

如果命令能够正常输出版本号，直接进入下一步。如果提示找不到命令，请根据操作系统安装。

#### macOS

安装 Node.js 20 或更高版本，然后安装 DSH：

```sh
brew install node
npm install -g @deepseek-ai/dsh
```

#### Windows

在 PowerShell 中安装 Node.js LTS：

```powershell
winget install OpenJS.NodeJS.LTS
```

安装完成后重新打开 PowerShell，再安装 DSH：

```powershell
npm install -g @deepseek-ai/dsh
```

安装后再次运行 `dsh --version`，确认 DSH 可以正常使用。

### 2. 安装 tabbit-browser 插件

```sh
dsh plugin --profile web add github:Tabbit-Browser/dsh-plugin
```

### 3. 启动 DSH

```sh
dsh web
```

## 工作原理

安装插件后，bundle 会自动加载 Skill Provider，模型可通过 `skill({ name: "tabbit-browser" })` 或 `/tabbit-browser` 加载说明。在任务中的第一次浏览器操作之前，skill 会先调用 `tabbit_browser_install` 做环境预检：

- **`ready`** — 已安装 `1.9.0` 或更高版本的正式版 Tabbit 且运行时正在运行，Agent 继续通过 `tabbit-cli` 操作浏览器。
- **`restart-required`** — 已安装的版本达标，但 `tabbit-cli` 常驻运行时未运行，提示用户重启一次 Tabbit 浏览器。
- **`background`** — 未安装任何正式版，或版本低于 `1.9.0`；工具会创建 DSH 后台任务，读取系统地区（macOS 读取系统地区，Windows 调用系统地区 API），中国大陆下载国内正式版安装包，其他地区或无法识别地区时下载国际正式版安装包；自动选择对应的 Windows x64、macOS Apple Silicon 或 macOS Intel 包，保存到用户的 `Downloads` 目录，下载过程会输出进度，完成后 DSH 会通知安装包的绝对路径。

环境检查还会：

- 多个 Tabbit 实例同时运行时，仍判定 Runtime 可用；模型根据 CLI 提示设置 `TABBIT_PLAYWRIGHT_INSTANCE`，不会把实例选择歧义误报为 Runtime 未运行。
- 诊断当前平台调用 CLI 所需的 DSH sandbox mode；Windows 返回 `cliSandboxMode: danger-full-access`，其他平台返回 `default`。
- 按 Agent session 缓存成功的环境检查；仅在 Runtime/launcher 失败或安装变化后通过 `refresh: true` 主动失效并重新检查。

## 前提

- 需要 `1.9.0` 或更高版本的正式版 Tabbit 浏览器。国际版 `Tabbit` 和国内版 `Tabbit Browser` 均支持，安装任意一个即可；如果未安装或版本过低，插件会自动下载对应安装包。
- 当前 DSH profile 已提供 `ctx.skills`、`ctx.tools`、`ctx.jobs` 以及对应模型工具。
- `dsh-tool-jobs` 已为当前 Agent 提供后台任务控制和完成通知。
- 当前 DSH profile 已提供运行在 Tabbit Browser 所在宿主机的 Bash/Shell 工具。
- Shell 的执行环境可以访问 Browser-owned Runtime Service。
- Windows 上 DSH 的 `read-only` 与 `workspace-write` 限制令牌无法写入 Runtime 命名管道。Skill 先正常执行 `tabbit-cli tasks` 连接探测；成功时完全不询问权限。仅当 Browser、launcher 和 Runtime 进程均已检测到但连接返回 `BROWSER_RUNTIME_UNAVAILABLE` 时，才要求用户把当前 DSH 会话切换到 Full Permission，并立即停止当前任务，不重试或继续浏览器操作。

## 行为说明与限制

- 中国大陆使用 `tabbit.com` 国内版下载源，其他地区使用 `tabbit.ai` 国际版下载源。
- 后台下载会输出进度，完成后通知安装包的绝对路径，但不会自动打开 `.dmg` 或 `.exe`。
- 不会检测开发版。
- 不提供 `tabbit_browser_evaluate` 等原生浏览器工具。

如果 DSH 的 Bash 运行在 E2B、远程容器或无法访问本机 GUI Browser 的沙箱中，本 Skill 不会使 Tabbit 自动化变得可用。

## 开发验证

```sh
npm test
npm pack --dry-run
```

## 许可证

MIT
