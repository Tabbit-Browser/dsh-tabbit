# tabbit-browser

这是一个 Tabbit 浏览器为 Deepseek Harness 提供的一个 plugins。你可以在 Deepseek Harness 中安装这个插件，给  Deepseek Harness 提供控制 Tabbit 浏览器的能力。

## 安装与启动

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

安装插件后，bundle 会自动加载 Skill Provider，模型可通过
`skill({ name: "tabbit-browser" })` 或 `/tabbit-browser` 加载说明。Skill 会检查国内或
国际正式版、要求至少一个版本达到 `1.9.0`，并检查 `tabbit-cli` 常驻运行时。
没有安装或版本过低时，模型会直接创建 DSH 后台任务：macOS 读取系统地区，Windows
调用系统地区 API；中国大陆下载国内正式版，其他地区或无法识别地区时下载国际正式版。
安装包会保存到用户的 `Downloads` 目录，任务完成后 DSH 会通知安装包路径。

## 前提

- 必须安装 `1.9.0` 或更高版本的正式版 Tabbit 浏览器。国际版 `Tabbit` 和国内版
  `Tabbit Browser` 均支持，安装任意一个即可。
- 当前 DSH profile 已提供 `ctx.skills`、`ctx.tools`、`ctx.jobs` 以及对应模型工具。
- `dsh-tool-jobs` 已为当前 Agent 提供后台任务控制和完成通知。
- 当前 DSH profile 已提供运行在 Tabbit Browser 所在宿主机的 Bash/Shell 工具。
- Shell 的执行环境可以访问 Browser-owned Runtime Service。

## 范围

本包负责：

- 随插件安装自动发现和加载 `tabbit-browser` Skill，无需单独安装 Skill。
- 检测国际正式版 `Tabbit` 和国内正式版 `Tabbit Browser`。
- 要求任一正式版版本不低于 `1.9.0`。
- 检查 `tabbit-cli` 常驻运行时；未运行时提醒用户重启一次 Tabbit。
- 在两者均未安装或所有正式版版本过低时，通过 `ctx.jobs` 后台下载适配系统地区的正式版安装包。
- 中国大陆使用 `tabbit.com` 国内版下载源，其他地区使用 `tabbit.ai` 国际版下载源。
- 输出下载进度，完成后通知安装包绝对路径。

它不会检测开发版，不会自动打开 `.dmg` 或 `.exe`，也不提供
`tabbit_browser_evaluate` 等原生浏览器工具。

如果 DSH 的 Bash 运行在 E2B、远程容器或无法访问本机 GUI Browser 的沙箱中，本 Skill
不会使 Tabbit 自动化变得可用。

## 开发验证

```sh
npm test
npm pack --dry-run
```
