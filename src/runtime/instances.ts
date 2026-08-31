/*
 * ============================================================================
 * 文件职责：读取 Tabbit「实例注册表」（instance registry）
 * ============================================================================
 *
 * 背景知识：一台机器上可以同时装多个 Tabbit Browser（比如正式版 + Dev 版 +
 * 国内版）。每个安装好的浏览器在首次启动时会写一条注册记录，【两平台不同构】
 * （均以 tab-browser 源码 local_agent_host_integration_manager.cc 为准）：
 *
 * macOS/Linux：`~/.local/share/tabbit-playwright/instances/<16位大写hex>.instance`
 * 三行纯文本：
 *     第 1 行：固定魔法串（见下面 REGISTRY_MAGIC），防止误读无关文件；
 *     第 2 行：该实例自带 CLI 可执行文件的绝对路径；
 *     第 3 行：该实例 endpoint.json 的绝对路径——【浏览器只在自己的
 *             Runtime Service 正在运行时才会创建这个文件，退出即删】。
 *             所以"endpoint 文件当前存在" == "这个实例在线"。
 * 新版浏览器（2026-08 起）还会在旁边写一个同名 `.product` 档案（两行：
 * 魔法串 + 产品名，如 "Tabbit Browser Dev"）——比从 CLI 路径猜应用名可靠，
 * 有就优先用它做展示名。
 *
 * Windows：`%LOCALAPPDATA%\Tabbit\LocalAgent\instances\<16位大写hex>.json`
 * （C++ 侧 BuildWindowsInstanceRecord 写出的 JSON，DACL 保护）：
 *     {version:1, instanceId, product, cliPath, endpointPath, browserPath,
 *      userDataDir}
 * 产品名直接在记录里，没有 .product 旁档；在线判定同样看 endpointPath
 * 文件是否存在。注意所有产品共用同一个注册表目录（launcher 也固定装在
 * %LOCALAPPDATA%\Tabbit\LocalAgent\bin\，不随产品名变化）。
 *
 * launcher 外壳脚本（新名 `tabbit-cli`，旧名 `tabbit-playwright`，见
 * defaultLauncherPath 的说明）自己也读这个注册表来决定把命令转发
 * 给哪个实例。我们为什么还要【自己再解析一遍】而不是只依赖外壳的报错？
 *   1. `/tabbit-info` 诊断命令要能列出所有实例给用户看；
 *   2. 选择无歧义时（只有一个在线实例）可以自动选中，用户零配置；
 *   3. 有歧义时能抛出带完整实例清单的、可操作的错误信息。
 * 本文件的校验规则刻意与外壳脚本保持一致，避免"我们认、外壳不认"的分裂。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

/* 一个已注册的 Tabbit 实例（解析注册文件的结果）。 */
export interface TabbitInstance {
  /* 16 位大写十六进制实例 id（就是注册文件名去掉 .instance 后缀）。 */
  id: string;
  /* 该实例自带 CLI 的绝对路径。 */
  cliPath: string;
  /* endpoint.json 的绝对路径。 */
  endpointPath: string;
  /* 是否在线。判定依据：endpoint 文件当前是否存在（浏览器只在 Runtime Service 运行期间发布它）。 */
  online: boolean;
  /* 给人看的应用名：优先 .product 档案里浏览器写的产品名，否则从 CLI 路径里的 xxx.app 包名推导。 */
  appName: string;
}

/* 注册文件必须以这行魔法串开头，否则视为无关文件跳过。 */
const REGISTRY_MAGIC = '# tabbit-playwright instance managed by Tabbit Browser';
/* .product 档案的首行魔法串（第二行是产品名）。 */
const PRODUCT_MAGIC = '# tabbit-playwright product managed by Tabbit Browser';
/* 合法实例 id 的形状：恰好 16 位大写十六进制。 */
const INSTANCE_ID_PATTERN = /^[0-9A-F]{16}$/u;

/* POSIX 注册表目录的默认位置。 */
export function defaultRegistryDir(): string {
  return join(homedir(), '.local', 'share', 'tabbit-playwright', 'instances');
}

/* Windows 注册表目录的默认位置（= 原生 CLI 目录的上一级 + instances）。 */
export function defaultWindowsRegistryDir({
  env = process.env,
  userHome = homedir(),
}: { env?: NodeJS.ProcessEnv; userHome?: string } = {}): string {
  const base = env.LOCALAPPDATA || join(userHome, 'AppData', 'Local');
  return join(base, 'Tabbit', 'LocalAgent', 'instances');
}

/*
 * launcher 外壳的默认安装位置。浏览器新版本（2026-08 起）注册的名字是
 * `tabbit-cli`（加固版外壳：校验属主/权限、读 .product 档案、优先选择
 * 「浏览器进程还活着」的实例），旧名 `tabbit-playwright` 一段时间内并存但
 * 已被官方弃用——且旧壳在多实例机器上无法自动选实例（直接报错要求设环境
 * 变量），新壳能自动选中活跃实例。选择顺序：
 *   - Windows：%LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe
 *     （原生可执行文件，浏览器安装时布置）；
 *   - 其它平台：~/.local/bin/tabbit-cli 存在就用；否则回退旧名
 *     tabbit-playwright；两个都不存在时返回新名——让"launcher 缺失"的
 *     报错信息指向当前正确的安装路径。
 * 参数可注入（platform/env/userHome）仅为单元测试；生产调用一律无参。
 */
export function defaultLauncherPath({
  platform = process.platform,
  env = process.env,
  userHome = homedir(),
}: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; userHome?: string } = {}): string {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(userHome, 'AppData', 'Local');
    return join(base, 'Tabbit', 'LocalAgent', 'bin', 'tabbit-cli.exe');
  }
  const modern = join(userHome, '.local', 'bin', 'tabbit-cli');
  if (existsSync(modern)) return modern;
  const legacy = join(userHome, '.local', 'bin', 'tabbit-playwright');
  if (existsSync(legacy)) return legacy;
  return modern;
}

/*
 * 从 CLI 路径里提取应用名：macOS 上路径通常形如
 * `/Applications/Tabbit Browser.app/Contents/.../cli`，取 `.app` 那段；
 * 匹配不到就退化为文件名。仅用于展示，不参与任何逻辑判断。
 */
function deriveAppName(cliPath: string): string {
  const match = cliPath.match(/\/([^/]+\.app)\//u);
  if (match) return match[1].replace(/\.app$/u, '');
  return basename(cliPath);
}

/*
 * 读实例的 .product 档案（新版浏览器写的产品名，如 "Tabbit Browser Dev"）。
 * 档案缺失/魔法串不对/产品名为空 → undefined（回退到 deriveAppName）。
 */
function readProductName(registryDir: string, id: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(registryDir, `${id}.product`), 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  if (lines[0] !== PRODUCT_MAGIC) return undefined;
  const product = (lines[1] ?? '').trim();
  return product !== '' ? product : undefined;
}

/*
 * 列出所有合法的已注册实例（平台分派入口）。
 *
 * 有意用【同步】文件 API（readdirSync 等）：调用频率低、文件极小，同步读省去
 * 到处传 Promise 的复杂度，也让 core 层的 resolveExecutionInstance() 可以保持
 * 同步签名。
 *
 * 显式传了 registryDir 时按 POSIX 格式解析（历史签名，单元测试与诊断用）；
 * 不传时按当前平台选注册表：win32 走 JSON 记录，其余走 .instance 三行文本。
 */
export function listInstances(registryDir?: string): TabbitInstance[] {
  if (registryDir === undefined && process.platform === 'win32') return listInstancesWindows();
  return listInstancesPosix(registryDir ?? defaultRegistryDir());
}

/*
 * POSIX 注册表解析。每个候选文件要闯过 5 道校验（与 launcher 外壳一致），
 * 任何一道不过就整个跳过：
 *   1. 文件名以 .instance 结尾且去后缀后是 16 位大写 hex；
 *   2. 首行等于魔法串；
 *   3. 第 2、3 行都是绝对路径；
 *   4. CLI 路径确实存在且是普通文件；
 *   5. （不淘汰，只标记）endpoint 文件存在与否决定 online。
 */
export function listInstancesPosix(registryDir = defaultRegistryDir()): TabbitInstance[] {
  let names: string[];
  try {
    names = readdirSync(registryDir);
  } catch {
    // 目录不存在（从没装过 Tabbit）：返回空列表而不是抛错。
    return [];
  }
  const instances: TabbitInstance[] = [];
  for (const name of names) {
    if (!name.endsWith('.instance')) continue;
    const id = name.slice(0, -'.instance'.length);
    if (!INSTANCE_ID_PATTERN.test(id)) continue;
    let text: string;
    try {
      text = readFileSync(join(registryDir, name), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    if (lines[0] !== REGISTRY_MAGIC) continue;
    const cliPath = lines[1] ?? '';
    const endpointPath = lines[2] ?? '';
    if (!isAbsolute(cliPath) || !isAbsolute(endpointPath)) continue;
    let cliOk = false;
    try {
      cliOk = statSync(cliPath).isFile();
    } catch {
      continue;
    }
    if (!cliOk) continue;
    let online = false;
    try {
      online = statSync(endpointPath).isFile();
    } catch {
      online = false;
    }
    instances.push({ id, cliPath, endpointPath, online, appName: readProductName(registryDir, id) ?? deriveAppName(cliPath) });
  }
  // 按 id 排序，保证多次调用输出顺序稳定（诊断输出、错误信息里好对照）。
  instances.sort((a, b) => a.id.localeCompare(b.id));
  return instances;
}

/*
 * Windows 注册表解析。校验规则镜像 C++ 写入端（BuildWindowsInstanceRecord）：
 *   1. 文件名以 .json 结尾；
 *   2. 记录 version === 1；
 *   3. instanceId 是 16 位大写 hex 且与文件名一致（防止拷贝改名产生分裂身份）；
 *   4. cliPath/endpointPath 是非空字符串，cliPath 指向存在的普通文件；
 *   5. endpoint 文件存在与否决定 online（同 POSIX）。
 * 展示名优先记录里的 product 字段（Windows 没有 .product 旁档）。
 */
export function listInstancesWindows(registryDir = defaultWindowsRegistryDir()): TabbitInstance[] {
  let names: string[];
  try {
    names = readdirSync(registryDir);
  } catch {
    return [];
  }
  const instances: TabbitInstance[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let record: {
      version?: unknown;
      instanceId?: unknown;
      product?: unknown;
      cliPath?: unknown;
      endpointPath?: unknown;
    };
    try {
      record = JSON.parse(readFileSync(join(registryDir, name), 'utf8')) as typeof record;
    } catch {
      continue;
    }
    if (record.version !== 1) continue;
    const id = typeof record.instanceId === 'string' ? record.instanceId : '';
    if (!INSTANCE_ID_PATTERN.test(id) || `${id}.json` !== name) continue;
    const cliPath = typeof record.cliPath === 'string' ? record.cliPath : '';
    const endpointPath = typeof record.endpointPath === 'string' ? record.endpointPath : '';
    if (cliPath === '' || endpointPath === '') continue;
    let cliOk = false;
    try {
      cliOk = statSync(cliPath).isFile();
    } catch {
      continue;
    }
    if (!cliOk) continue;
    let online = false;
    try {
      online = statSync(endpointPath).isFile();
    } catch {
      online = false;
    }
    instances.push({
      id,
      cliPath,
      endpointPath,
      online,
      appName: typeof record.product === 'string' && record.product !== '' ? record.product : deriveAppName(cliPath),
    });
  }
  instances.sort((a, b) => a.id.localeCompare(b.id));
  return instances;
}

/*
 * 决定最终把哪个实例 id 通过环境变量 TABBIT_PLAYWRIGHT_INSTANCE 传给 launcher。
 * 消歧规则刻意镜像 launcher 外壳自己的规则：
 *
 *   - 显式指定（settings 配了 tabbit.instance）：必须在注册表里，否则抛出
 *     带可用实例清单的错误（帮用户发现是配错了 id 还是没装）；
 *   - 未指定：
 *       · 恰好 1 个在线实例 → 选它；
 *       · 0 个在线但总共只装了 1 个 → 选它（launcher 会自动把浏览器拉起来）；
 *       · 一个都没装 → 抛"请先安装并启动一次 Tabbit"；
 *       · 多个且无法定夺 → 抛带完整清单的引导错误，提示用户去 settings 里
 *         设置 tabbit.instance。
 *
 * 返回 undefined 的含义：不设置环境变量、裸调 launcher 也一定能成功的场景
 * （机器上只有一个实例时 launcher 自己就能选对）。
 */
export function resolveInstanceId(
  configured: string | undefined,
  instances: TabbitInstance[],
): string | undefined {
  if (configured) {
    const found = instances.find((instance) => instance.id === configured);
    if (!found) {
      const available = instances.map((instance) => `${instance.id} (${instance.appName})`).join(', ') || 'none';
      throw new Error(
        `Configured Tabbit instance ${configured} is not registered. Available instances: ${available}.`,
      );
    }
    return configured;
  }
  const online = instances.filter((instance) => instance.online);
  if (online.length === 1) return online[0].id;
  if (online.length === 0 && instances.length === 1) return instances[0].id;
  if (instances.length === 0) {
    throw new Error(
      'No Tabbit Browser instance is registered on this machine (missing ~/.local/share/tabbit-playwright/instances). Install and launch Tabbit Browser first.',
    );
  }
  const listing = instances
    .map((instance) => `${instance.id} (${instance.appName}${instance.online ? ', online' : ''})`)
    .join(', ');
  throw new Error(
    `Multiple Tabbit Browser instances are registered; set the "tabbit" settings key "instance" to one of: ${listing}.`,
  );
}
