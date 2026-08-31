/*
 * ============================================================================
 * 文件职责：内网/私有目标判定（供"页面读取权限"和 web_fetch 使用）
 * ============================================================================
 *
 * 为什么需要它？—— SSRF 防护（Server-Side Request Forgery，服务端请求伪造）。
 * web_fetch 是拿【用户的真实浏览器】去抓网页的：如果放任模型抓
 * `http://192.168.1.1/`（路由器管理页）、`http://localhost:8080/`（本机内部
 * 服务）这类地址，等于把用户内网暴露给了提示词注入攻击。dsh 官方出厂就是因为
 * 没有 provider 能负责任地处理这个问题，才把 web_fetch 整个禁用的。
 * 本插件的方案：抓内网目标不禁止，但走独立的审批门（settings
 * `tabbit.intranetFetch`，默认逐 origin 询问用户）——判定"是不是内网目标"
 * 就是本文件的活。
 *
 * 设计取向：尽力而为（best-effort），三层判定由快到慢：
 *   1. 字面 IP：同步判段（10.x、127.x、192.168.x 等私有网段）；
 *   2. 域名形态：同步判形（localhost、*.local、无点裸主机名等）；
 *   3. DNS 解析：真的去查这个域名解析到什么 IP，但限时（默认 1.5 秒）——
 *      查不出来就当"未知非内网"放行（反正解析不了的域名导航自己会失败）。
 *
 * 重定向问题：这里只判定【请求发起时】的 URL；公网 URL 302 跳到内网地址的
 * 情况，由 web-fetch provider 在拿到最终 URL 后【再查一次】兜底（见
 * src/web-fetch/index.ts 的"redirect containment"段）。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/*
 * IPv4 私有段判定。命中任何一段即视为私有：
 *   10.0.0.0/8         企业内网 A 段
 *   127.0.0.0/8        回环（本机）
 *   0.0.0.0/8          "本网络"保留段
 *   169.254.0.0/16     链路本地（DHCP 拿不到地址时的自动配置段）
 *   172.16.0.0/12      企业内网 B 段（172.16 ~ 172.31）
 *   192.168.0.0/16     家用路由器最常见段
 *   100.64.0.0/10      CGNAT（运营商级 NAT，Tailscale 等 VPN 也用它）
 */
function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/*
 * IPv6 私有段判定：
 *   ::1        回环；:: 未指定地址
 *   fe80::/10  链路本地
 *   fc00::/7   ULA（唯一本地地址，IPv6 的"内网段"，fc/fd 开头）
 *   ::ffff:x.x.x.x  IPv4 映射地址——剥掉前缀后按 IPv4 规则复判
 */
function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) return ipv4IsPrivate(lower.slice('::ffff:'.length));
  return false;
}

/* 字面 IP（v4 或 v6）是否属于私有/回环段。isIP 返回 4/6/0（0=不是 IP）。 */
export function ipIsPrivate(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4IsPrivate(ip);
  if (version === 6) return ipv6IsPrivate(ip);
  return false;
}

/*
 * 不查 DNS 的"域名形态"判定：一眼就能看出是本地/内网名字的模式。
 *   - localhost 及 *.localhost；
 *   - 常见内网专用后缀：.local（mDNS）/.internal/.lan/.home/.corp；
 *   - 不含点的裸主机名（如 http://nas/ ——公网域名必有点）。
 * 末尾的 `.` 是 DNS 的"绝对域名"写法（如 example.com.），先剥掉再比。
 */
export function hostnameLooksLocal(hostname: string): boolean {
  const name = hostname.replace(/\.$/u, '').toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name.endsWith('.local') || name.endsWith('.internal') || name.endsWith('.lan') || name.endsWith('.home') || name.endsWith('.corp')) {
    return true;
  }
  if (!name.includes('.') && isIP(name) === 0) return true;
  return false;
}

/*
 * 综合判定一个 URL 是否指向私有/内网目标。
 *
 * @returns 判定为私有时返回【原因描述字符串】（直接用于审批询问的文案里，
 *          让用户知道为什么被拦）；公网或无法判定时返回 undefined。
 *
 * 判定顺序：URL 能不能解析 → 主机是不是字面 IP → 域名形态 → 限时 DNS。
 * DNS 用 Promise.race 跟一个定时器赛跑：超过 dnsBudgetMs 就放弃等待，
 * 按"未知"处理——宁可漏判也不让权限检查把每次 fetch 卡住几秒。
 * （漏判的兜底：navigation 之后 web-fetch 会对最终 URL 的字面形态再查一次。）
 */
export async function privateTargetReason(rawUrl: string, dnsBudgetMs = 1500): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // 连 URL 都不是：不归这里管（工具那边自会报"非法 URL"）。
    return undefined;
  }
  // IPv6 字面量在 URL 里带方括号（http://[::1]/），先剥掉。
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(hostname) !== 0) {
    return ipIsPrivate(hostname) ? `IP address ${hostname} is private/loopback` : undefined;
  }
  if (hostnameLooksLocal(hostname)) {
    return `hostname "${hostname}" looks like a local/intranet name`;
  }
  try {
    // lookup(all:true) 返回该域名的全部解析地址；任何一个落在私有段就算私有
    // （防"公网域名解析到内网 IP"的 DNS rebinding 变体）。
    const resolved = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), dnsBudgetMs).unref?.()),
    ]);
    if (Array.isArray(resolved)) {
      const hit = resolved.find((entry) => ipIsPrivate(entry.address));
      if (hit) return `hostname "${hostname}" resolves to private address ${hit.address}`;
    }
  } catch {
    /* 域名解析不了：交给导航自己失败，这里不拦 */
  }
  return undefined;
}
