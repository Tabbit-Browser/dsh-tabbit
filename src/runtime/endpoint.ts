/*
 * ============================================================================
 * 文件职责：直连 Runtime Service 公开端点（endpoint.json + NDJSON socket）
 * ============================================================================
 *
 * 这是与浏览器通信的【第二条物理通道】，与 cli.ts（launcher 子进程）并列：
 *
 *   cli.ts     —— 每次 spawn launcher 子进程，走完整 CLI 面（求值/finish/…），
 *                 具备"浏览器没在跑时自动拉起"的能力，代价是 ~1 秒级延迟；
 *   endpoint.ts（本文件）—— 直接连浏览器发布的本机 socket，仅覆盖【无任务】
 *                 操作（目前是 tabs 清单与 ping），稳态延迟 ~1ms，
 *                 但【不会】拉起浏览器：离线就如实报离线。
 *
 * 选型背景（2026-08-28，与 Tabbit 团队确认）：persistent 模式（CLI 的 NDJSON
 * 交互式子命令）计划移除，不能依赖；而 socket 协议里的 unbound `tabs` 是
 * dispatch 的一等 case，与 persistent/bootstrap 绑定机制无关，且在 tab-browser
 * tip-of-tree 上逐行未变——这是"零浏览器改动 + 快速读取"的唯一交集。
 *
 * ─── 线上协议（对 Dev 1.13.8 / 稳定 1.11.16 / tip-of-tree 三版源码核对一致，
 *      并经真机验证；服务端实现 runtime-public-server.mjs + runtime-service.mjs）───
 *
 *  1. endpoint.json（schema v2，浏览器 C++ 侧 local_agent_endpoint.cc 写出）：
 *       {version:2, kind:"browser-runtime-service", transport, address,
 *        token(32字节 base64url), generation, browserPid}
 *     位置在 <用户数据目录>/LocalAgent/endpoint.json（注册表记录里给了全路径）。
 *     【只在 Runtime Service 运行期间存在，浏览器退出即删；每次重启
 *     address/token/generation 三元组全部轮换】——所以本文件的铁律是：
 *     每次连接前【现读】该文件，绝不缓存凭据。
 *  2. 传输：macOS/Linux = unix domain socket（0600）；Windows = named pipe
 *     （\\.\pipe\tabbit-runtime-…）。Node 的 net.createConnection 对两者同一 API。
 *  3. 帧格式：NDJSON（一行一个 JSON + \n）。连接后第一帧必须是【严格恰好
 *     三个键】的认证帧 {"version":1,"token":…,"generation":…}——服务端用
 *     timingSafeEqual 比对，不匹配就【无响应直接断开】（这是认证失败唯一的
 *     可观测征兆，见下面 STALE_ENDPOINT 的处理）。认证帧成功也没有回执。
 *  4. 认证后每帧一个请求对象，响应一行 {ok:true,value} 或
 *     {ok:false,error:{name,code,message}}。非 persistent 连接一问一答后由
 *     服务端主动收尾；我们读到响应行就自行断开，不依赖这一行为。
 *  5. unbound {"op":"tabs"}（连接上没有任务绑定时）：返回全 profile 标签页
 *     清单。服务端内部开一个临时会话并在同一 dispatch 里 finalize(keep:true)
 *     ——不产生任务、页面、标签组，也不出现在 `tasks` 列表里（真机核查）。
 *     {"op":"ping"} 返回 {running:true, generation}，可当健康检查。
 *  6. 服务端限额：认证帧 ≤4KB、请求 ≤64MB、8 并发 dispatch（超了回
 *     SERVICE_BUSY）、未认证连接空闲 5 秒收、dispatch 超时 150 秒。
 *
 * 错误统一包装成 TabbitCliError（与 CLI 通道共用一套错误分类，上层不用区分
 * 消息是从哪条通道冒出来的）。
 */
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

import { TabbitCliError, classifyAppError } from './errors.js';

/* 我们支持的 endpoint.json schema 版本（浏览器侧 kBrowserRuntimeEndpointVersion）。 */
const ENDPOINT_SCHEMA_VERSION = 2;

/* 解析后的 endpoint.json。字段名与文件一致。 */
export interface TabbitEndpoint {
  version: number;
  kind: string;
  transport: 'unix_socket' | 'named_pipe';
  address: string;
  token: string;
  generation: string;
  browserPid: number;
}

/*
 * `tabs` 清单里的单个标签页描述符。形状以浏览器 C++ 序列化代码为准
 * （browser_runtime_service_host.cc 的 OnRuntimeListTabs），真机两代验证一致。
 */
export interface TabbitTabDescriptor {
  tabId: number;
  windowId: number;
  /* 在所属窗口标签条（tab strip）里的位置，从 0 起。 */
  index: number;
  title: string;
  url: string;
  active: boolean;
  /* available=无主可认领；owned=已属于某个本插件可见的工作区；busy=被别的工作区占有。 */
  state: 'available' | 'owned' | 'busy';
  /* 所在标签组的元数据；不在任何组里时为 null。组标题只是展示文本，不是身份。 */
  group: { groupId: string; title: string } | null;
}

export interface TabbitTabInventory {
  tabs: TabbitTabDescriptor[];
  /* 服务端因体量截断清单时为 true（正常机器上标签页数量远够不到上限）。 */
  truncated: boolean;
}

export interface EndpointRequestOptions {
  /* 整个请求的墙钟超时（毫秒）。tabs 稳态 ~1ms，默认值只是兜底。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/*
 * 读取并校验 endpoint.json。三种失败各有语义：
 *   - 文件读不到/不是 JSON：浏览器离线（文件退出即删）——ENDPOINT_MISSING；
 *   - schema 版本或 kind 不认识：浏览器换了协议世代，需要升级本插件——
 *     ENDPOINT_UNSUPPORTED（宁可明确失败也不猜着连）；
 *   - transport 不认识：同上。
 */
export function readEndpoint(endpointPath: string): TabbitEndpoint {
  let parsed: Partial<TabbitEndpoint>;
  try {
    parsed = JSON.parse(readFileSync(endpointPath, 'utf8')) as Partial<TabbitEndpoint>;
  } catch (error) {
    throw new TabbitCliError({
      kind: 'browser-unavailable',
      code: 'ENDPOINT_MISSING',
      message: `Tabbit Browser is not running (cannot read ${endpointPath}): ${String((error as Error)?.message ?? error)}`,
    });
  }
  if (parsed.version !== ENDPOINT_SCHEMA_VERSION || parsed.kind !== 'browser-runtime-service') {
    throw new TabbitCliError({
      kind: 'protocol',
      code: 'ENDPOINT_UNSUPPORTED',
      message: `Unsupported Runtime Service endpoint schema (version=${String(parsed.version)} kind=${String(parsed.kind)}); update dsh-tabbit.`,
    });
  }
  if (
    (parsed.transport !== 'unix_socket' && parsed.transport !== 'named_pipe') ||
    typeof parsed.address !== 'string' ||
    parsed.address === '' ||
    typeof parsed.token !== 'string' ||
    typeof parsed.generation !== 'string'
  ) {
    throw new TabbitCliError({
      kind: 'protocol',
      code: 'ENDPOINT_UNSUPPORTED',
      message: 'Runtime Service endpoint file is missing transport/address/token/generation fields.',
    });
  }
  return parsed as TabbitEndpoint;
}

/*
 * 在一条新连接上完成"认证帧 + 单个请求帧 → 一行响应"的完整交换。
 *
 * 实现要点：
 *   - 认证帧和请求帧一次性写出（服务端逐帧消费，无需等认证回执——协议里
 *     认证成功本来就没有回执）；
 *   - settled 布尔量保证 resolve/reject 只发生一次（error/close/data 会竞争）；
 *   - 读到第一个换行即为完整响应，之后立刻 destroy——unbound 连接没有任何
 *     需要善后的服务端状态（无任务绑定），断开即干净；
 *   - 【close 先于 data 到达 = 认证被拒或服务端换代】：服务端对坏凭据的行为
 *     是无响应断开，映射为 STALE_ENDPOINT，由上层（requestViaEndpoint）现读
 *     endpoint.json 重试一次——覆盖"浏览器刚重启、我们拿的是上一代凭据"窗口。
 */
function endpointRequestOnce(endpoint: TabbitEndpoint, payload: object, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(endpoint.address);
    let buffer = '';
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new TabbitCliError({
            kind: 'timeout',
            code: 'CLIENT_TIMEOUT',
            message: `Runtime Service endpoint did not respond within ${timeoutMs}ms`,
          }),
        ),
      );
    }, timeoutMs);
    timer.unref();

    socket.on('error', (error: NodeJS.ErrnoException) => {
      // 两类都归为"凭据/端点过期"（可现读文件重试一次）：
      //   ENOENT/ECONNREFUSED —— 文件还在但 socket 已不可连（浏览器正在退出
      //   或重启的窗口期）；
      //   ECONNRESET/EPIPE —— 交换中途被掐（服务端对坏凭据的 destroy 在
      //   客户端常表现为 RST，而不是干净的 close）。
      const stale =
        error.code === 'ENOENT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ECONNRESET' ||
        error.code === 'EPIPE';
      settle(() =>
        reject(
          new TabbitCliError({
            kind: stale ? 'browser-unavailable' : 'protocol',
            code: stale ? 'STALE_ENDPOINT' : 'SOCKET_ERROR',
            message: stale
              ? `Runtime Service connection dropped before a response (browser restarting or stale credentials): ${error.code}`
              : `Runtime Service socket error: ${error.message}`,
          }),
        ),
      );
    });
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ version: 1, token: endpoint.token, generation: endpoint.generation })}\n` +
          `${JSON.stringify(payload)}\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      settle(() => {
        let response: { ok?: boolean; value?: unknown; error?: { name?: string; code?: string; message?: string } };
        try {
          response = JSON.parse(buffer.slice(0, newline)) as typeof response;
        } catch {
          reject(
            new TabbitCliError({
              kind: 'protocol',
              code: 'BAD_FRAME',
              message: `Runtime Service returned a non-JSON frame: ${buffer.slice(0, 200)}`,
            }),
          );
          return;
        }
        if (response.ok === true) {
          resolve(response.value);
          return;
        }
        const error = response.error ?? {};
        reject(
          new TabbitCliError({
            kind: classifyAppError(error),
            code: error.code ?? 'REQUEST_FAILED',
            message: error.message ?? 'Runtime Service request failed',
          }),
        );
      });
    });
    socket.on('close', () =>
      settle(() =>
        reject(
          new TabbitCliError({
            kind: 'browser-unavailable',
            code: 'STALE_ENDPOINT',
            message:
              'Runtime Service closed the connection before responding (endpoint credentials are stale; the browser likely restarted)',
          }),
        ),
      ),
    );
  });
}

/*
 * 对外的单请求入口：现读 endpoint.json → 交换一次；命中"凭据过期/socket 刚没"
 * 这两类【重启窗口】错误时，再现读一次文件重试——文件是浏览器新一代身份的
 * 唯一权威来源，重读即自愈。其余错误（离线、超时、服务端应用错误）原样上抛。
 */
export async function requestViaEndpoint(
  endpointPath: string,
  payload: object,
  options: EndpointRequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await endpointRequestOnce(readEndpoint(endpointPath), payload, timeoutMs);
  } catch (error) {
    if (!(error instanceof TabbitCliError) || error.code !== 'STALE_ENDPOINT') throw error;
    return await endpointRequestOnce(readEndpoint(endpointPath), payload, timeoutMs);
  }
}

/*
 * 全 profile 标签页清单（含用户自己开的页面，不限于代理任务页）。
 * 零副作用：不建任务、不开页面、不出现在 tasks 列表（服务端 unbound tabs
 * 的固有语义）。返回值形状逐字段校验——数据要进提示词/UI，宁可在这里挡住
 * 服务端未来的形状漂移，也不把 unknown 直接漏给上层。
 */
export async function listAllTabs(endpointPath: string, options?: EndpointRequestOptions): Promise<TabbitTabInventory> {
  const value = await requestViaEndpoint(endpointPath, { op: 'tabs' }, options);
  const inventory = value as { tabs?: unknown; truncated?: unknown };
  if (typeof inventory !== 'object' || inventory === null || !Array.isArray(inventory.tabs)) {
    throw new TabbitCliError({
      kind: 'protocol',
      code: 'BAD_FRAME',
      message: 'Runtime Service tabs inventory has an unexpected shape',
    });
  }
  const tabs: TabbitTabDescriptor[] = [];
  for (const entry of inventory.tabs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const tab = entry as Record<string, unknown>;
    if (typeof tab.tabId !== 'number' || typeof tab.url !== 'string') continue;
    const group = tab.group as Record<string, unknown> | null | undefined;
    tabs.push({
      tabId: tab.tabId,
      windowId: typeof tab.windowId === 'number' ? tab.windowId : 0,
      index: typeof tab.index === 'number' ? tab.index : 0,
      title: typeof tab.title === 'string' ? tab.title : '',
      url: tab.url,
      active: tab.active === true,
      state: tab.state === 'owned' || tab.state === 'busy' ? tab.state : 'available',
      group:
        typeof group === 'object' && group !== null && typeof group.groupId === 'string'
          ? { groupId: group.groupId, title: typeof group.title === 'string' ? group.title : '' }
          : null,
    });
  }
  return { tabs, truncated: inventory.truncated === true };
}

/* 健康检查：浏览器在线时返回 {running:true, generation}。 */
export async function pingEndpoint(
  endpointPath: string,
  options?: EndpointRequestOptions,
): Promise<{ running: boolean; generation: string }> {
  const value = (await requestViaEndpoint(endpointPath, { op: 'ping' }, options)) as {
    running?: unknown;
    generation?: unknown;
  };
  return {
    running: value?.running === true,
    generation: typeof value?.generation === 'string' ? value.generation : '',
  };
}
