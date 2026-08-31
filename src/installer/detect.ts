/*
 * ============================================================================
 * 文件职责：稳定版 Tabbit 的安装检测 + 地区/平台/下载目标推导
 * ============================================================================
 *
 * 回答四个问题（全是"读系统信息"，无副作用）：
 *  1. 机器上装了哪些稳定版 Tabbit？什么版本？
 *       macOS：读 .app 包里的 Info.plist（plutil 命令）；
 *       Windows：读卸载注册表（reg.exe query）。
 *  2. 版本达标吗？（最低 1.9.0，isVersionAtLeast 做数字段比较）
 *  3. 用户在哪个地区？（决定下国际版 tabbit.ai 还是国内版 tabbit.com）
 *  4. 该下哪个安装包？（平台/CPU 架构 → .dmg/.exe 的下载 URL）
 *
 * 出处：自 github:Tabbit-Browser/dsh-tabbit（本包 npm 0.2.x 世代）的
 * installer.js 移植。Runtime Service 可达性有两路信号，强弱有别：
 *  - 【主信号】launcher 实例注册表的 endpoint 文件——只在服务真正运行期间
 *    存在（见 ../runtime/instances.ts 的 listInstances()），精确且便宜；
 *  - 【降级信号】进程列表匹配（ps / Get-CimInstance 找
 *    browser-runtime-service.mjs / nodejs-playwright-runtime.mjs）——又慢
 *    又粗，但不依赖注册表目录。保留它是为 Windows：注册表目录在 Windows 上
 *    的位置未经真机确认，注册表读不到时进程探测是唯一可用的在线判据。
 * 组合逻辑在调用方（installer/index.ts）：注册表有在线实例即 ready；
 * 注册表空时才落到进程探测。本模块自身只提供"读系统信息"的原料。
 *
 * 可测性设计：所有会碰系统的函数都接受可注入的 run/platform/env 参数
 * （默认用真系统），单元测试喂假数据就能全覆盖，不需要真装 Tabbit。
 */
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* 支持的最低稳定版版本。 */
export const MINIMUM_TABBIT_VERSION = '1.9.0';

export type InstallerPlatform = 'mac' | 'windows';
export type InstallerArch = 'ARM_64' | 'x86_64';
/* 版本线：international=国际版（tabbit.ai），domestic=国内版（tabbit.com）。 */
export type TabbitEdition = 'international' | 'domestic';
export type InstallerDistribution = 'international' | 'domestic';

/* 一个平台/架构组合对应的安装包规格。 */
export interface PlatformSpec {
  platform: InstallerPlatform;
  arch: InstallerArch;
  extension: '.dmg' | '.exe';
  /* 服务器没给出文件名时的兜底名。 */
  fallbackName: string;
}

/* 检测到的一处 Tabbit 安装。 */
export interface DetectedInstallation {
  name: string;
  edition: TabbitEdition;
  channel: 'stable';
  path?: string;
  executable?: string;
  version?: string;
  bundleId?: string;
  registryKey?: string;
}

/* 外部命令执行的抽象（可注入假实现做测试）。 */
interface RunResult {
  status: number | null;
  stdout: string;
}
type RunFn = (command: string, args: string[]) => RunResult;

/* 默认实现：spawnSync 同步执行（检测场景低频短命令，同步最简单）。 */
const defaultRun: RunFn = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '' };
};

/* 两条发行线的官网源。 */
const INSTALLER_ORIGINS: Record<InstallerDistribution, string> = {
  domestic: 'https://www.tabbit.com',
  international: 'https://www.tabbit.ai',
};

/* "平台:架构" → 安装包规格。不在表里的组合（如 Linux）不支持。 */
const DOWNLOADS: Record<string, PlatformSpec> = {
  'win32:x64': { platform: 'windows', arch: 'x86_64', extension: '.exe', fallbackName: 'Tabbit Browser Installer.exe' },
  'darwin:arm64': { platform: 'mac', arch: 'ARM_64', extension: '.dmg', fallbackName: 'Tabbit Browser Installer ARM64.dmg' },
  'darwin:x64': { platform: 'mac', arch: 'x86_64', extension: '.dmg', fallbackName: 'Tabbit Browser Installer Intel.dmg' },
};

/* macOS 上要找的两个应用（按 bundleId 精确认证，不能光看目录名——重命名的假目录不算）。 */
const MAC_APPLICATIONS: ReadonlyArray<{ name: string; bundleId: string; edition: TabbitEdition; channel: 'stable' }> = [
  { name: 'Tabbit', bundleId: 'com.tabbit-ai.Tabbit', edition: 'international', channel: 'stable' },
  { name: 'Tabbit Browser', bundleId: 'com.tab-browser.Tabbit', edition: 'domestic', channel: 'stable' },
];

/* Windows 上按卸载表 DisplayName 认的两个名字。 */
const WINDOWS_DISPLAY_NAMES = new Map<string, { edition: TabbitEdition; channel: 'stable' }>([
  ['Tabbit', { edition: 'international', channel: 'stable' }],
  ['Tabbit Browser', { edition: 'domestic', channel: 'stable' }],
]);

/*
 * 把各种乱七八糟的 locale 写法归一成两位国家码（大写）：
 *   "zh_CN" / "zh-CN" / "'en_US'" / "zh_CN@calendar=..." → CN / US
 *   已经是纯两位码（"CN"）就直接大写返回。
 * 解析不出返回 undefined。
 */
export function normalizeRegionCode(value: unknown): string | undefined {
  const locale = String(value ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '') // 去掉包裹引号
    .split('@', 1)[0] ?? ''; // 去掉 @ 后面的修饰（日历等）
  if (/^[a-z]{2}$/i.test(locale)) return locale.toUpperCase();
  return locale.match(/(?:_|-)([a-z]{2})$/i)?.[1]?.toUpperCase();
}

/*
 * 探测系统地区：
 *   macOS  → `defaults read -g AppleLocale`（如 zh_CN）；
 *   Windows → PowerShell 读 Get-WinHomeLocation 的 GeoId 转两位国家码。
 * 探测不到 → undefined（下游按国际版处理）。
 */
export function detectSystemRegion({
  platform = process.platform,
  run = defaultRun,
}: { platform?: NodeJS.Platform; run?: RunFn } = {}): string | undefined {
  if (platform === 'darwin') {
    const result = run('/usr/bin/defaults', ['read', '-g', 'AppleLocale']);
    return result.status === 0 ? normalizeRegionCode(result.stdout) : undefined;
  }
  if (platform === 'win32') {
    const script = '([System.Globalization.RegionInfo]::new((Get-WinHomeLocation).GeoId)).TwoLetterISORegionName';
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return result.status === 0 ? normalizeRegionCode(result.stdout) : undefined;
  }
  return undefined;
}

/* 地区 → 发行线：只有 CN 走国内版，其余（含未知）都走国际版。 */
export function installerDistributionForRegion(regionCode: string | undefined): InstallerDistribution {
  return normalizeRegionCode(regionCode) === 'CN' ? 'domestic' : 'international';
}

/* 拼安装器下载 URL（官方 upgrade API + 平台/架构参数 + 来源标记）。 */
export function installerUrl(spec: PlatformSpec, distribution: InstallerDistribution = 'international'): string {
  const origin = INSTALLER_ORIGINS[distribution];
  const query = new URLSearchParams({
    platform: spec.platform,
    arch: spec.arch,
    // tab_brand 是下载统计侧的归因标识，沿用 0.2.x 世代已在线上使用的
    // 'dshr'（换值会把同一渠道的统计切成两段）。
    tab_brand: 'dshr',
    utm_source: 'dsh',
  });
  return `${origin}/api/v0/upgrade/installer?${query}`;
}

/*
 * 推导本机应下载的安装包规格。两个"报的架构不等于真架构"的坑要修正：
 *  - macOS：x64 版 Node 跑在 Apple Silicon 的 Rosetta 转译层下时，
 *    process.arch 谎报 x64。用 `sysctl hw.optional.arm64` 问硬件真话
 *    （返回 1 = 实为 ARM 芯片，应下 ARM64 包）。
 *  - Windows：32 位进程跑在 64 位系统上时看 PROCESSOR_ARCHITEW6432
 *    环境变量拿到真实架构。
 * 不支持的组合（Linux 等）直接抛错。
 */
export function detectPlatformSpec({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  run = defaultRun,
}: { platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv; run?: RunFn } = {}): PlatformSpec {
  let nativeArch = arch;

  if (platform === 'darwin' && arch === 'x64') {
    const result = run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']);
    if (result.status === 0 && result.stdout.trim() === '1') nativeArch = 'arm64';
  }

  if (platform === 'win32') {
    const reported = String(env.PROCESSOR_ARCHITEW6432 ?? env.PROCESSOR_ARCHITECTURE ?? arch).toLowerCase();
    nativeArch = reported === 'amd64' || reported === 'x86_64' ? 'x64' : arch;
  }

  const spec = DOWNLOADS[`${platform}:${nativeArch}`];
  if (!spec) throw new Error(`Tabbit Browser installer is unavailable for ${platform}/${nativeArch}.`);
  return { ...spec };
}

/* access() 的布尔化封装（存在返回 true，不存在不抛错返回 false）。 */
async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/* 用 macOS 自带的 plutil 从 Info.plist 里抽一个键的值（-o - 输出到 stdout）。 */
function readPlistValue(plistPath: string, key: string, run: RunFn): string | undefined {
  const result = run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/*
 * macOS 安装检测：在 /Applications 和 ~/Applications 两个根下找目标 .app。
 * 认证三步：Info.plist 存在 → CFBundleIdentifier 与预期完全一致（防重名假
 * 目录冒充）→ 读 CFBundleShortVersionString 拿版本。seenBundleIds 去重
 * （两个根都装了同一应用时只记第一处）。
 */
export async function detectMacInstallations({
  userHome = homedir(),
  run = defaultRun,
}: { userHome?: string; run?: RunFn } = {}): Promise<DetectedInstallation[]> {
  const roots = ['/Applications', join(userHome, 'Applications')];
  const installations: DetectedInstallation[] = [];
  const seenBundleIds = new Set<string>();

  for (const app of MAC_APPLICATIONS) {
    for (const root of roots) {
      const path = join(root, `${app.name}.app`);
      const plistPath = join(path, 'Contents', 'Info.plist');
      if (!(await exists(plistPath))) continue;
      const actualBundleId = readPlistValue(plistPath, 'CFBundleIdentifier', run);
      if (actualBundleId !== app.bundleId || seenBundleIds.has(app.bundleId)) continue;
      const version = readPlistValue(plistPath, 'CFBundleShortVersionString', run);
      installations.push({ ...app, path, ...(version ? { version } : {}) });
      seenBundleIds.add(app.bundleId);
    }
  }
  return installations;
}

/*
 * 解析 `reg.exe query` 的文本输出（Windows 卸载注册表）。输出形如：
 *   HKEY_LOCAL_MACHINE\...\Uninstall\Tabbit
 *       DisplayName    REG_SZ    Tabbit
 *       DisplayVersion REG_SZ    1.9.2
 *       ...
 * 状态机式逐行扫：见到 HKEY_ 开头行 = 新记录开始（先提交上一条）；
 * 缩进行按 "键 REG_类型 值" 抽字段。commit 时只认 DisplayName 在白名单里的；
 * DisplayIcon 常带 ",索引" 后缀和包裹引号，清理后当可执行文件路径用。
 * 导出仅为可单测（纯文本进、结构出）。
 */
export function parseWindowsUninstallRegistry(output: string): DetectedInstallation[] {
  const installations: DetectedInstallation[] = [];
  let record: Record<string, string> | undefined;

  const commit = () => {
    if (!record) return;
    const identity = WINDOWS_DISPLAY_NAMES.get(record.DisplayName ?? '');
    if (!identity) return;
    const icon = record.DisplayIcon?.replace(/,\s*-?\d+$/, '').replace(/^"(.*)"$/, '$1');
    installations.push({
      name: record.DisplayName ?? '',
      ...identity,
      ...(record.InstallLocation || icon ? { path: record.InstallLocation || icon } : {}),
      ...(icon ? { executable: icon } : {}),
      ...(record.DisplayVersion ? { version: record.DisplayVersion } : {}),
      ...(record.registryKey ? { registryKey: record.registryKey } : {}),
    });
  };

  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      commit();
      record = { registryKey: line.trim() };
      continue;
    }
    if (!record) continue;
    const match = line.match(/^\s+(DisplayName|DisplayVersion|InstallLocation|DisplayIcon)\s+REG_\w+\s+(.*)$/i);
    if (match?.[1] !== undefined && match[2] !== undefined) record[match[1]] = match[2].trim();
  }
  commit();
  return installations;
}

/*
 * Windows 安装检测：查 HKCU（当前用户）和 HKLM（本机）两个卸载表根，
 * 每个都查 64 位和 32 位注册表视图（/reg:64、/reg:32——32 位安装器写的键
 * 在 64 位视图里看不见，反之亦然）。
 * 两轮策略：先精确查两个已知子键名（快）；一无所获时降级为整根递归扫
 * （/s，慢但兜得住"安装技术生成随机卸载子键名"的情况）。
 */
export function detectWindowsInstallations({ run = defaultRun }: { run?: RunFn } = {}): DetectedInstallation[] {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const targetedKeys = roots.flatMap((root) => ['Tabbit', 'Tabbit Browser'].map((name) => `${root}\\${name}`));
  const installations: DetectedInstallation[] = [];
  const seen = new Set<string>();

  const collect = (output: string) => {
    for (const item of parseWindowsUninstallRegistry(output)) {
      const key = `${item.name}\0${item.path ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      installations.push(item);
    }
  };

  for (const key of targetedKeys) {
    for (const view of ['64', '32']) {
      const result = run('reg.exe', ['query', key, `/reg:${view}`]);
      if (result.status === 0) collect(result.stdout);
    }
  }
  if (installations.length > 0) return installations;

  // 兼容兜底：某些安装技术用生成式卸载子键名，well-known 键名查不到时
  // 保留整根广扫。
  for (const root of roots) {
    for (const view of ['64', '32']) {
      const result = run('reg.exe', ['query', root, '/s', `/reg:${view}`]);
      if (result.status === 0) collect(result.stdout);
    }
  }
  return installations;
}

/* "1.9.2" / "v1.9" → [1,9,2]；解析不出（空/乱格式）→ undefined。 */
function numericVersion(version: string | undefined): number[] | undefined {
  const match = String(version ?? '').trim().match(/^v?(\d+(?:\.\d+)*)/i);
  return match?.[1] !== undefined ? match[1].split('.').map(Number) : undefined;
}

/*
 * 版本达标判断：按数字段逐段比较（长度不齐的段补 0），
 * 任一方解析不出版本号一律算不达标（宁严勿松）。
 */
export function isVersionAtLeast(version: string | undefined, minimum: string = MINIMUM_TABBIT_VERSION): boolean {
  const actual = numericVersion(version);
  const required = numericVersion(minimum);
  if (!actual || !required) return false;
  const length = Math.max(actual.length, required.length);
  for (let index = 0; index < length; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export interface DetectedEnvironment {
  platform: NodeJS.Platform;
  minimumVersion: string;
  installations: DetectedInstallation[];
  supportedInstallations: DetectedInstallation[];
  recommendation: 'ready' | 'restart-required' | 'download';
}

/*
 * 检测总入口：按平台分派（其它平台返回空），并把结果分成
 * installations（所有找到的）和 supportedInstallations（版本达标的）两份。
 * 注意：这里只管"装没装/版本够不够"；"Runtime Service 通不通"由调用方
 * 拼 ctx.tabbit.launcherPath()/instances() 判断（理由见文件头）。
 */
export async function detectTabbitInstallations({
  platform = process.platform,
  userHome = homedir(),
  run = defaultRun,
  minimumVersion = MINIMUM_TABBIT_VERSION,
}: {
  platform?: NodeJS.Platform;
  userHome?: string;
  run?: RunFn;
  minimumVersion?: string;
} = {}): Promise<{ installations: DetectedInstallation[]; supportedInstallations: DetectedInstallation[] }> {
  const installations =
    platform === 'darwin'
      ? await detectMacInstallations({ userHome, run })
      : platform === 'win32'
        ? detectWindowsInstallations({ run })
        : [];
  const supportedInstallations = installations.filter((item) => isVersionAtLeast(item.version, minimumVersion));
  return { installations, supportedInstallations };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Runtime Service 进程探测（降级信号，用途与取舍见文件头）
 * ──────────────────────────────────────────────────────────────────────────── */

/* 探测到的一个 Runtime Service 进程。 */
export interface RuntimeProcess {
  pid: number;
  name: string;
}

/*
 * 判断一条进程记录是不是 Tabbit 的 Runtime Service 常驻进程。
 * 认两个入口脚本名（浏览器两代 Runtime 的常驻进程各叫一个）：
 *   browser-runtime-service.mjs / nodejs-playwright-runtime.mjs。
 * 匹配要求脚本名以路径分隔符/引号/空白开头、以结尾或引号/空白收尾——
 * 防止 "not-browser-runtime-service.mjs.bak" 之类的伪匹配；同时刻意
 * 【不】匹配 tabbit-cli 等短命 CLI 进程（那是每次调用起一个的客户端，
 * 不代表服务在跑）。
 */
function isTabbitRuntimeProcess(name: unknown, command: unknown): boolean {
  const value = `${String(name ?? '')} ${String(command ?? '')}`;
  return (
    /(?:^|[\\/"'\s])browser-runtime-service\.mjs(?=$|["'\s])/i.test(value) ||
    /(?:^|[\\/"'\s])nodejs-playwright-runtime\.mjs(?=$|["'\s])/i.test(value)
  );
}

/*
 * 解析 `ps -axo pid=,comm=,args=` 的输出（每行：pid 命令名 完整命令行）。
 * 导出仅为可单测（纯文本进、结构出）。
 */
export function parseUnixProcessList(output: string): RuntimeProcess[] {
  const processes: RuntimeProcess[] = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || !isTabbitRuntimeProcess(match[2], match[3])) continue;
    processes.push({ pid: Number(match[1]), name: match[2] ?? '' });
  }
  return processes;
}

/*
 * 解析 PowerShell `Get-CimInstance ... | ConvertTo-Json` 的输出。
 * ConvertTo-Json 的坑：结果只有一条时输出的是【单个对象】而非数组，要归一。
 */
export function parseWindowsProcessList(output: string): RuntimeProcess[] {
  if (!String(output).trim()) return [];
  let records: unknown;
  try {
    records = JSON.parse(output);
  } catch {
    return [];
  }
  const list = Array.isArray(records) ? records : [records];
  return list
    .filter((record): record is { ProcessId: unknown; Name?: unknown; CommandLine?: unknown } =>
      record !== null && typeof record === 'object' && isTabbitRuntimeProcess((record as { Name?: unknown }).Name, (record as { CommandLine?: unknown }).CommandLine),
    )
    .map((record) => ({ pid: Number(record.ProcessId), name: String(record.Name ?? '') }));
}

/*
 * 列出当前机器上的 Runtime Service 进程：
 *   Windows → PowerShell 查 Win32_Process（CommandLine LIKE 两个脚本名）；
 *   其它平台 → `ps -axo pid=,comm=,args=` 全量列表后正则筛。
 * 命令失败（status 非 0）一律返回空列表——降级信号探测不到就当没有。
 */
export function detectTabbitRuntimeProcesses({
  platform = process.platform,
  run = defaultRun,
}: { platform?: NodeJS.Platform; run?: RunFn } = {}): RuntimeProcess[] {
  if (platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%browser-runtime-service.mjs%' OR CommandLine LIKE '%nodejs-playwright-runtime.mjs%'" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return result.status === 0 ? parseWindowsProcessList(result.stdout) : [];
  }
  const result = run('ps', ['-axo', 'pid=,comm=,args=']);
  return result.status === 0 ? parseUnixProcessList(result.stdout) : [];
}

/*
 * 把进程列表归纳成"在不在跑/有没有歧义"：>1 个 Runtime 进程 = 多个 Tabbit
 * 实例同时在跑（每个实例一个常驻 Runtime），选实例可能有歧义——调用方
 * 据此提示用户设置 tabbit.instance。
 */
export function summarizeTabbitRuntime(processes: ReadonlyArray<RuntimeProcess>): {
  instanceCount: number;
  running: boolean;
  ambiguous: boolean;
} {
  const instanceCount = Array.isArray(processes) ? processes.length : 0;
  return { instanceCount, running: instanceCount > 0, ambiguous: instanceCount > 1 };
}
