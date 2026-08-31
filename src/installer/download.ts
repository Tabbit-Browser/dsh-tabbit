/*
 * ============================================================================
 * 文件职责：安装器的后台下载（安全加固版的"下载一个文件"）
 * ============================================================================
 *
 * 自 github:Tabbit-Browser/dsh-plugin 的 installer.js 移植。看似只是下载，
 * 但落到用户磁盘上的是一个【将要被双击运行的浏览器安装包】，所以做了一整套
 * 防御（每条都对应一种真实风险）：
 *
 *  - 域名白名单：重定向链的【最终 URL】必须是 https 且落在 tabbit.com/
 *    tabbit.ai 系主机上——防 CDN/短链被劫持后把"安装包"重定向到恶意主机；
 *  - 体积上限 1 GiB：Content-Length 和实际累计字节双重检查——防被灌爆磁盘；
 *  - 原子写入：先写 `目标名.<pid>.<时间戳>.part` 临时文件（'wx' 独占创建 +
 *    0o600 仅本人可读写），全部校验通过后才 rename 成正式名——保证
 *    Downloads 里出现的正式文件名【要么不存在、要么就是完整校验过的】，
 *    绝无半截文件；任何失败路径都删 .part 不留垃圾；
 *  - 完整性校验：收到的字节数必须等于 Content-Length（防截断）；
 *  - 魔数（magic bytes）签名校验：.exe 开头必须是 'MZ'（Windows PE 格式），
 *    .dmg 结尾 512 字节内必须有 'koly'（DMG 结尾块签名）——防服务器返回
 *    错误页/HTML 却顶着安装包文件名落盘；
 *  - 文件名清洗：Content-Disposition 给的文件名先 basename 掐掉路径部分
 *    （防 ../../ 路径穿越），再滤掉控制字符和 Windows 保留字符，扩展名
 *    对不上就直接用兜底名；
 *  - 重名避让：已存在同名文件时用 "名字 (1).ext" 递增，绝不覆盖用户已有文件。
 */
import { constants } from 'node:fs';
import { access, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  detectPlatformSpec,
  detectSystemRegion,
  installerDistributionForRegion,
  installerUrl,
  type InstallerDistribution,
  type PlatformSpec,
} from './detect.js';

/* 安装包体积安全上限：1 GiB。 */
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
/* 最终下载 URL 允许落在的主机白名单（两条发行线的官网/包/发布域）。 */
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'www.tabbit.com',
  'pkg.tabbit.com',
  'releases.tabbit.com',
  'www.tabbit.ai',
  'pkg.tabbit.ai',
  'releases.tabbit.ai',
]);

/* 进度回调的载荷（expectedBytes 未知时 percent 也为 undefined）。 */
export interface DownloadProgress {
  receivedBytes: number;
  expectedBytes: number | undefined;
  percent: number | undefined;
}

/* 下载成功的结果描述。 */
export interface DownloadResult {
  path: string;
  bytes: number;
  platform: PlatformSpec['platform'];
  arch: PlatformSpec['arch'];
  region: string;
  distribution: InstallerDistribution;
  sourceUrl: string;
}

export interface DownloadInstallerOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  /* 保存目录，默认 ~/Downloads。 */
  outputDirectory?: string;
  /* 可注入的 fetch 实现（测试用），默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /* 透传给 detect.ts 的平台探测参数（测试用）。 */
  platformOptions?: Parameters<typeof detectPlatformSpec>[0] & Parameters<typeof detectSystemRegion>[0];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* 文件名里要清洗掉的字符：Windows 保留字符（<>:"/\|?*）+ 控制字符（0x00-0x1f）。 */
const CONTROL_OR_RESERVED_CHARS = new RegExp(
  '[<>:"/\\\\|?*]|[\\x00-\\x1f]',
  'g',
);

/*
 * 从 HTTP 响应决定保存文件名。优先级：
 *   1. Content-Disposition 的 filename*=UTF-8''（RFC 5987 编码格式，可带中文）；
 *   2. Content-Disposition 的普通 filename=；
 *   3. 最终 URL 路径的最后一段；
 *   4. 平台规格里的兜底名。
 * 拿到候选后：basename 掐路径（防穿越）→ 清洗保留/控制字符 →
 * 扩展名必须匹配平台预期（.dmg/.exe），否则整个放弃用兜底名。
 */
function filenameFromResponse(response: Response, spec: PlatformSpec): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate: string | undefined;
  try {
    candidate = encoded ? decodeURIComponent(encoded) : plain;
  } catch {
    candidate = plain;
  }
  if (!candidate) {
    try {
      candidate = decodeURIComponent(basename(new URL(response.url).pathname));
    } catch {
      candidate = undefined;
    }
  }
  const safe = basename(candidate || spec.fallbackName)
    .replace(CONTROL_OR_RESERVED_CHARS, '_')
    .trim();
  return safe.toLowerCase().endsWith(spec.extension) ? safe : spec.fallbackName;
}

/* 重名避让：目标已存在就试 "名字 (1).ext"、"名字 (2).ext"……最多 1000 次。 */
async function uniqueDestination(directory: string, filename: string): Promise<string> {
  const extensionIndex = filename.toLowerCase().lastIndexOf('.');
  const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : '';
  for (let index = 0; index < 1000; index += 1) {
    const candidate = join(directory, index === 0 ? filename : `${stem} (${index})${extension}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not allocate a unique installer filename.');
}

/*
 * 魔数签名校验（读文件的头/尾几个字节比对格式签名）：
 *   .exe：头 2 字节必须是 'MZ'（DOS/PE 可执行文件的经典签名）；
 *   .dmg：文件末尾 512 字节的"koly 块"（DMG 格式的结尾元数据块签名）。
 * 不匹配 = 下到的根本不是安装包（可能是错误页 HTML），直接判失败。
 */
async function verifyInstaller(path: string, spec: PlatformSpec, bytes: number): Promise<void> {
  const handle = await open(path, 'r');
  try {
    if (spec.extension === '.exe') {
      const header = Buffer.alloc(2);
      await handle.read(header, 0, 2, 0);
      if (header.toString('ascii') !== 'MZ') throw new Error('Downloaded file is not a Windows executable.');
      return;
    }
    const trailer = Buffer.alloc(Math.min(512, bytes));
    await handle.read(trailer, 0, trailer.length, Math.max(0, bytes - trailer.length));
    if (trailer.subarray(0, 4).toString('ascii') !== 'koly') {
      throw new Error('Downloaded file is not a valid DMG image.');
    }
  } finally {
    await handle.close();
  }
}

/*
 * 下载主流程。步骤（文件头列的每道防御在这里落地）：
 *   1. 推导平台规格 + 地区 → 拼下载 URL，确保输出目录存在；
 *   2. fetch（跟随重定向）→ 校验 HTTP 状态 → 【白名单校验最终 URL】；
 *   3. 决定文件名 + 避让重名 → 独占创建 .part 临时文件（0o600）；
 *   4. for-await 流式逐块写盘：每块查取消信号、累计字节数防超限；
 *      进度节流上报（百分比前进了、或距上次超 1 秒才报一次）；
 *   5. handle.sync() 强制刷盘 → 字节数对账 → 魔数校验 → rename 转正；
 *   6. 任何失败路径：关句柄、删 .part、原样抛错。
 */
export async function downloadInstaller(options: DownloadInstallerOptions = {}): Promise<DownloadResult> {
  const { signal, onProgress = () => undefined, outputDirectory = join(homedir(), 'Downloads'), fetchImpl = fetch, platformOptions } = options;
  const spec = detectPlatformSpec(platformOptions);
  const regionCode = detectSystemRegion(platformOptions);
  const distribution = installerDistributionForRegion(regionCode);
  const sourceUrl = installerUrl(spec, distribution);
  await mkdir(outputDirectory, { recursive: true });

  const response = await fetchImpl(sourceUrl, { redirect: 'follow', ...(signal ? { signal } : {}) });
  if (!response.ok || !response.body) throw new Error(`Installer download failed with HTTP ${response.status}.`);
  // 白名单查的是 response.url——重定向链的【最终】落点，不是我们发起的 URL。
  const finalUrl = new URL(response.url || sourceUrl);
  if (finalUrl.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
    throw new Error(`Installer redirected to an untrusted host: ${finalUrl.hostname || finalUrl.href}`);
  }

  const expectedBytes = Number(response.headers.get('content-length')) || undefined;
  if (expectedBytes && expectedBytes > MAX_INSTALLER_BYTES) throw new Error('Installer exceeds the 1 GiB safety limit.');
  const filename = filenameFromResponse(response, spec);
  const destination = await uniqueDestination(outputDirectory, filename);
  // .part 名里掺 pid+时间戳：并发下载互不踩；'wx' = 必须新建（已存在就报错）。
  const partial = `${destination}.${process.pid}.${Date.now()}.part`;
  const handle = await open(partial, 'wx', 0o600);
  let receivedBytes = 0;
  let lastPercent = -1;
  let lastReportAt = 0;

  try {
    // response.body 是 Web 流；for-await 逐块消费（Node 里可直接异步迭代）。
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) throw signal.reason ?? new Error('Download cancelled.');
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_INSTALLER_BYTES) throw new Error('Installer exceeds the 1 GiB safety limit.');
      await handle.write(chunk);

      const now = Date.now();
      const percent = expectedBytes ? Math.floor((receivedBytes / expectedBytes) * 100) : undefined;
      if ((percent !== undefined && percent > lastPercent) || now - lastReportAt >= 1000) {
        lastPercent = percent ?? lastPercent;
        lastReportAt = now;
        onProgress({ receivedBytes, expectedBytes, percent });
      }
    }
    await handle.sync(); // fsync：确保数据真正落盘（掉电也不丢）再进入校验
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  }
  await handle.close();

  try {
    if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
      throw new Error(`Installer download was incomplete: received ${receivedBytes} of ${expectedBytes} bytes.`);
    }
    await verifyInstaller(partial, spec, receivedBytes);
    await rename(partial, destination); // 原子转正：从此正式文件名可见
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }

  return {
    path: destination,
    bytes: receivedBytes,
    platform: spec.platform,
    arch: spec.arch,
    region: regionCode ?? 'unknown',
    distribution,
    sourceUrl,
  };
}

/* dsh jobs 服务要求的后台任务句柄形状（见 installer/index.ts 文件头的 jobs 背景）。 */
export interface DownloadJobHandle {
  cancel(reason?: string): void;
  done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail: string }>;
  /* dsh 轮询调用：返回上次调用以来新增的输出并清空缓冲（增量消费模式）。 */
  readOutput(): string;
}

/*
 * 把 downloadInstaller 包装成 `ctx.jobs` 形状的任务句柄：
 *  - cancel → AbortController.abort（下载循环里检查 signal 会及时停）；
 *  - 进度/结果以带前缀的行写进输出缓冲（TABBIT_DOWNLOAD_PROGRESS /
 *    TABBIT_INSTALLER_READY + JSON——机器可解析，模型也能读懂）；
 *  - done 归一为三态：completed（含安装包路径）/ killed（用户取消）/
 *    failed（其它错误）；
 *  - onSettled：无论成败都回调一次（installer/index.ts 用它清 activeJobs 账）。
 */
export function createDownloadJob(options: DownloadInstallerOptions & { onSettled?: () => void } = {}): DownloadJobHandle {
  const controller = new AbortController();
  let pendingOutput = '';
  const append = (line: string) => {
    pendingOutput += `${line}\n`;
  };
  const formatProgress = ({ receivedBytes, expectedBytes, percent }: DownloadProgress) => {
    append(`TABBIT_DOWNLOAD_PROGRESS ${JSON.stringify({ receivedBytes, expectedBytes, percent })}`);
  };

  const done = downloadInstaller({ ...options, signal: controller.signal, onProgress: formatProgress })
    .then((result) => {
      append(`TABBIT_INSTALLER_READY ${JSON.stringify(result)}`);
      return { status: 'completed' as const, detail: `installer saved to ${result.path}` };
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) {
        append('Tabbit Browser installer download was cancelled.');
        return { status: 'killed' as const, detail: 'download cancelled' };
      }
      append(`Tabbit Browser installer download failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 'failed' as const, detail: 'download failed' };
    })
    .finally(() => options.onSettled?.());

  return {
    cancel: (reason) => controller.abort(new Error(reason || 'Download cancelled.')),
    done,
    readOutput() {
      const output = pendingOutput;
      pendingOutput = '';
      return output;
    },
  };
}
