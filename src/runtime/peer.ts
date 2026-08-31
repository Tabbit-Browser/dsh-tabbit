/*
 * ============================================================================
 * 文件职责：「观看实例」溯源——从一条本机 TCP 连接反查是哪个 Tabbit 在访问我们
 * ============================================================================
 *
 * 解决什么问题？多实例机器上（用户装了好几个 Tabbit），执行浏览器任务时该选
 * 哪个实例？最符合直觉的答案是：【用户正用哪个 Tabbit 看 dsh 网页界面，
 * 就在哪个 Tabbit 里执行】——"在哪看，就在哪跑"。
 *
 * 但 HTTP 请求本身不会告诉我们"我来自哪个浏览器"。本文件用一套 macOS 系统
 * 工具链把它侦查出来：
 *
 *   ① dsh 网页在浏览器里加载时，前端插件（client/client.js）会向
 *      `/tabbit/instance-hint` 发一个 POST（见 src/mentions/index.ts）；
 *   ② 服务端拿到这条 TCP 连接的【对端端口号】（remotePort）——注意我们不信
 *      请求体里的任何内容，身份完全取自 socket 本身，伪造不了；
 *   ③ 用 `lsof` 命令查：本机哪个进程占用着这个端口的客户端一侧？
 *      → 得到发起请求的进程 pid（Chromium 的某个网络辅助进程）；
 *   ④ 用 `ps` 命令沿父进程链往上爬（Chromium 是多进程架构：辅助进程都是
 *      主进程的子孙）；
 *   ⑤ 每个在线 Tabbit 实例的 endpoint.json 里记录着它主进程的 pid
 *      （browserPid 字段）——父链上撞到哪个实例的 browserPid，就是它了。
 *
 * 设计取向：这是一个【启发式】（heuristic）：任何一步失败（不是 macOS、
 * lsof/ps 不可用、对端不是 Tabbit 而是普通浏览器…）都返回 undefined，
 * 调用方（core 的实例四级解析）落回下一优先级，绝不因此报错。
 *
 * 仅支持 macOS：Runtime Service 目前未在 Windows 启用，lsof/ps 的调用方式
 * 也是 macOS 版的。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import type { TabbitInstance } from './instances.js';

// execFile 的 Promise 版（原版是回调风格）；比 exec 安全——参数按数组传，
// 不经过 shell，不存在命令注入问题。
const execFileAsync = promisify(execFile);

/*
 * 建立 browserPid → 实例 id 的映射表（步骤⑤的查找表）。
 * 只看在线实例；endpoint.json 解析失败（可能正赶上浏览器重启、文件被删）
 * 就跳过该实例。
 */
function browserPidMap(instances: readonly TabbitInstance[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const instance of instances) {
    if (!instance.online) continue;
    try {
      const endpoint = JSON.parse(readFileSync(instance.endpointPath, 'utf8')) as { browserPid?: unknown };
      if (typeof endpoint.browserPid === 'number' && endpoint.browserPid > 0) {
        map.set(endpoint.browserPid, instance.id);
      }
    } catch {
      /* endpoint 文件与浏览器重启竞态：跳过这个实例 */
    }
  }
  return map;
}

/*
 * 解析 `lsof -Fpn` 的机器可读输出（步骤③的核心）。
 *
 * -F 输出格式：每行一个字段，首字符是字段类型——
 *   p<pid>   接下来的行都属于这个进程
 *   n<名字>  一条网络连接，形如 "127.0.0.1:54321->127.0.0.1:3199"
 *
 * 我们要找的是：哪个进程的连接里，【本地端】（-> 左边）端口等于 peerPort。
 * 为什么看本地端？——对端端口 X 对我们（服务器）来说是"对方的端口"，但对
 * 发起连接的客户端进程来说，X 正是它自己的本地端口。同时排除自己（dsh 进程
 * 也持有这条连接的服务端一侧，别把自己认成客户端）。
 *
 * 导出仅为可单测（纯函数，喂字符串就能测）。
 */
export function clientPidFromLsof(output: string, peerPort: number, selfPid: number): number | undefined {
  let current: number | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      current = Number.parseInt(line.slice(1), 10);
      continue;
    }
    if (!line.startsWith('n') || current === undefined || current === selfPid) continue;
    const local = line.slice(1).split('->')[0] ?? '';
    if (local.endsWith(`:${peerPort}`)) return current;
  }
  return undefined;
}

/*
 * 主入口：给定一条 loopback 连接的对端端口，返回拥有它的 Tabbit 实例 id。
 * 非 macOS、端口非法、任何查询失败、或对端根本不是 Tabbit → undefined。
 */
export async function instanceIdForPeerPort(
  peerPort: number,
  instances: readonly TabbitInstance[],
  selfPid = process.pid,
): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  if (!Number.isInteger(peerPort) || peerPort <= 0) return undefined;
  const byPid = browserPidMap(instances);
  if (byPid.size === 0) return undefined;

  // 步骤③：lsof 按端口查连接。-n/-P 禁用域名/端口名反解（快很多），
  // -iTCP:端口 过滤，-Fpn 机器可读输出。整体限时 3 秒。
  let owner: number | undefined;
  try {
    const { stdout } = await execFileAsync('lsof', ['-n', '-P', `-iTCP:${peerPort}`, '-Fpn'], { timeout: 3000 });
    owner = clientPidFromLsof(stdout, peerPort, selfPid);
  } catch {
    return undefined;
  }
  if (owner === undefined) return undefined;

  // 步骤④：Chromium 辅助进程是主浏览器进程的子孙，沿父链最多爬 8 跳。
  // `ps -o ppid= -p <pid>` 只输出该进程的父 pid。
  let pid = owner;
  for (let hop = 0; hop < 8 && pid > 1; hop += 1) {
    const matched = byPid.get(pid);
    if (matched !== undefined) return matched; // 步骤⑤：撞上某实例的主进程 pid
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 });
      const ppid = Number.parseInt(stdout.trim(), 10);
      // 防御：ppid 非法或自指（不该发生）就放弃，绝不死循环。
      if (!Number.isFinite(ppid) || ppid <= 0 || ppid === pid) return undefined;
      pid = ppid;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
