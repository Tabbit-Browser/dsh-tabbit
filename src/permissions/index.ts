/*
 * ============================================================================
 * 文件职责：独立的「页面读取」权限门
 * ============================================================================
 *
 * 为什么浏览器访问要单独一档权限？——因为经 Tabbit 浏览是【带着用户真实
 * 登录态（cookie）】的：邮箱、网银、公司内网……模型能看到用户能看到的一切。
 * 这和"能不能读文件系统"是完全不同维度的风险，所以独立于 dsh 的文件/沙箱
 * 权限，自成一门：
 *
 *  - `tabbit.pageAccess`（总闸，管 tabbit_browser 和 web_fetch 两个工具）：
 *      ask    = 每会话第一次用时问一次用户，之后（成功过就）不再问
 *      always = 直接放行【默认】
 *      never  = 一律拒绝
 *  - `tabbit.intranetFetch`（附加闸，只管 web_fetch 打内网/回环目标）：
 *      ask    = 每会话【每个 origin】问一次
 *      always / never 同上
 *    这道闸就是本插件的 SSRF 姿态——有了它，带用户登录态的浏览器抓取才能
 *    负责任地接管 web_fetch（取代 dsh 内置的直连抓取器，后者靠"只连公网
 *    IP"自保）。origin 授权只发给"询问当时就被判定为内网、且该次
 *    调用成功"的目标：一个公网时期成功过的域名，事后 DNS 解析翻转成内网
 *    （DNS rebinding 攻击）时，【不会】继承当年的授权。
 *
 * ─── 必备背景：dsh 的 `tools/pre-execute` 瀑布（waterfall）───────────────
 *
 * dsh 每次要执行一个工具调用前，会触发 `tools/pre-execute` 事件。这是一个
 * "瀑布"式事件：处理器收到 (exec, next) 两个参数——
 *   - 返回 next() 的结果       = 放行，交给下一个处理器/最终执行；
 *   - 返回 {kind:'deny',reason} = 直接拒绝这次工具调用（reason 给模型看）；
 *   - 返回 {kind:'ask', reason} = 请求用户审批：dsh 把 reason 交给
 *     `ctx.approval`（审批服务），由部署所用的审批 UI（web 弹窗等）问用户，
 *     用户点允许才继续执行。
 * exec 里有：name（工具名）、arguments（参数）、agent（发起的会话 agent）、
 * callId（本次调用唯一 id）等。
 *
 * 工具执行完（无论成败）会触发 `tools/result` 事件——我们用它来"记账"：
 * 只有【成功】的调用才把授权记进会话记忆（失败不记，下次重试会再问）。
 *
 * Full access 的豁免以 DSH 当前生效的预设为准。Auto 和自定义预设也可采用
 * `never` 审批策略，单独看这个值无法知道用户是否选择了 Full access。
 */
import type { Context } from '@deepseek-ai/cordis';

import { privateTargetReason } from '../runtime/net.js';

// 类型副作用导入：让 dsh-tools 的 tools/pre-execute、tools/result 事件类型
// 和 dsh-user-approval 的 ctx.approval、core 的 ctx.tabbit 类型生效。
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '../core/index.js';

/* 受本门管辖的两个工具。 */
const GATED_TOOLS = new Set(['tabbit_browser', 'web_fetch']);

/* resolveAsk 的三种结论：放行 / 拒绝（带理由）/ 发起询问（带文案）。 */
type AskOutcome = 'bypass' | { kind: 'deny'; reason: string } | { kind: 'ask'; reason: string };

/*
 * 把"想发起一次询问"折算成当前模式下的正确结论：
 *  - 宿主确认当前预设为 Full access → 'bypass' 放行；
 *  - 审批服务根本没挂载（某些 headless 组合）→ 返回一个【解释了出路】的
 *    拒绝：告诉用户去 settings 把 tabbit.<key> 设为 always。若不接手，
 *    dsh 工具层的通用拒绝文案会把这条出路藏没；
 *  - 其它情况 → 正常返回 ask，交给审批 UI 问用户。
 */
function resolveAsk(
  ctx: Context,
  exec: { agent?: { session: unknown } },
  askReason: string,
  settingsKey: 'pageAccess' | 'intranetFetch',
): AskOutcome {
  const presets = ctx.get('permissionPresets' as never) as { current?(session: unknown): string } | undefined;
  if (exec.agent !== undefined) {
    try {
      if (presets?.current?.(exec.agent.session) === 'danger-full-access') return 'bypass';
    } catch {
      // 宿主无法读取当前会话的预设时，按常规询问处理。
    }
  }
  if (ctx.get('approval') === undefined) {
    return {
      kind: 'deny',
      reason: `This action needs user confirmation (settings tabbit.${settingsKey} = ask), but no approval channel is mounted in this composition. Set settings tabbit.${settingsKey} to "always" to allow it without prompts.`,
    };
  }
  return { kind: 'ask', reason: askReason };
}

export const name = 'tabbit-permissions';
export const inject = ['tools', 'tabbit'];

export function apply(ctx: Context): void {
  // 仅给真正发出的询问挂账。常开、Full access 和失败都不会留下会话授权。
  const pendingGrants = new Map<string, { pageAccess: boolean; origin?: string }>();

  // ── 事前拦截：tools/pre-execute 瀑布 ──────────────────────────────────
  ctx.on('tools/pre-execute', async function (exec, next) {
    // 不归我们管的工具：立刻放行给下一个处理器。
    if (!GATED_TOOLS.has(exec.name)) return next();
    const settings = ctx.tabbit.currentSettings();
    const agentId = exec.agent !== undefined ? String(exec.agent.id) : undefined;
    const needsPageApproval = settings.pageAccess === 'ask' &&
      (agentId === undefined || !ctx.tabbit.hasPageAccessGrant(agentId));

    // 总闸 never：两个工具一律拒绝。
    if (settings.pageAccess === 'never') {
      return {
        kind: 'deny' as const,
        reason: 'Tabbit Browser page access is disabled (settings tabbit.pageAccess = never).',
      };
    }

    // ── 附加闸：web_fetch 的内网目标检查（在总闸之前查，因为它更具体）──
    if (exec.name === 'web_fetch' && settings.intranetFetch !== 'always') {
      const url = urlArgumentOf(exec.arguments);
      if (url !== undefined) {
        // 内网判定（net.ts）：返回原因字符串 = 是内网；undefined = 公网/未知。
        const reason = await privateTargetReason(url);
        if (reason !== undefined) {
          if (settings.intranetFetch === 'never') {
            return {
              kind: 'deny' as const,
              reason: `web_fetch to a private/intranet target is disabled (${reason}; settings tabbit.intranetFetch = never).`,
            };
          }
          if (settings.intranetFetch === 'ask') {
            const origin = originOf(url);
            // 本会话对这个 origin 是否已授权过？
            const granted =
              agentId !== undefined && origin !== undefined && ctx.tabbit.hasIntranetGrant(agentId, origin);
            if (!granted) {
              const outcome = resolveAsk(
                ctx,
                exec,
                `web_fetch targets a PRIVATE/INTRANET address through your browser: ${reason}. First request to ${origin ?? 'this target'} in this session — allow it?${needsPageApproval ? ' This also allows this session to browse with your logged-in profile.' : ''} (Set settings tabbit.intranetFetch to "always" to skip these prompts.)`,
                'intranetFetch',
              );
              if (outcome !== 'bypass') {
                // 真的发出了询问：按 callId 挂账，等 tools/result 里对账。
                if (outcome.kind === 'ask' && agentId !== undefined) {
                  pendingGrants.set(grantKey(agentId, exec.callId), {
                    pageAccess: needsPageApproval, ...(origin !== undefined ? { origin } : {}),
                  });
                }
                return outcome;
              }
              // bypass（Full access）：内网闸放行，继续走下面的总闸检查。
            }
          }
        }
      }
    }

    // ── 总闸：pageAccess = ask 且本会话还没授权过 → 发起询问 ──────────
    if (needsPageApproval) {
      const outcome = resolveAsk(
        ctx,
        exec,
        'First Tabbit Browser page access in this session: the agent will browse with your real browser profile, including logged-in sessions. Allow browser access for this session? (Set settings tabbit.pageAccess to "always" to skip this prompt.)',
        'pageAccess',
      );
      if (outcome !== 'bypass') {
        if (outcome.kind === 'ask' && agentId !== undefined) {
          pendingGrants.set(grantKey(agentId, exec.callId), { pageAccess: true });
        }
        return outcome;
      }
    }

    // 所有门都过了：放行执行。
    return next();
  });

  // DSH 只在批准后运行工具；调用结束即销账，成功的询问才留下授权。
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined) return;
    const agentId = String(exec.agent.id);
    const key = grantKey(agentId, exec.callId);
    const pending = pendingGrants.get(key);
    if (pending === undefined) return;
    pendingGrants.delete(key);
    if (result.isError) return;
    // 浏览器工具把执行失败作为结构化值返回时，DSH 外层仍可能标记成功。
    if (exec.name === 'tabbit_browser' && (result as { value?: { status?: string } }).value?.status === 'failed') return;
    if (pending.pageAccess) ctx.tabbit.grantPageAccess(agentId);
    if (pending.origin !== undefined) ctx.tabbit.grantIntranet(agentId, pending.origin);
  });
}

/* 不同会话的工具调用 ID 可以相同，挂账和销账都带会话 ID。 */
function grantKey(agentId: string, callId: unknown): string {
  return JSON.stringify([agentId, String(callId)]);
}

/* 提取 URL 的 origin（协议+主机+端口）——内网授权的记忆粒度。 */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/* 从工具参数里安全地抠出 url 字段（参数是模型给的，形状不可信，逐层判断）。 */
function urlArgumentOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const url = (args as { url?: unknown }).url;
  return typeof url === 'string' ? url : undefined;
}
