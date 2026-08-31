/*
 * ============================================================================
 * 文件职责：`tabbit_browser` 工具——code-first 的真浏览器操作
 * ============================================================================
 *
 * 本插件的门面。设计哲学是「一个工具、一个契约」（code-first）：不做
 * click/type/screenshot 一堆细粒度工具，而是让模型直接提交一段【async 函数体】
 * ——在命名的 Tabbit 任务里以正版 Playwright 执行（用户真实 profile、真实
 * 登录态），函数的返回值就是工具结果。这样模型能用它全部的 Playwright 知识，
 * 一次调用干完"导航→等待→提取→加工"整套事，省去大量工具往返。
 *
 * 截图约定：模型在代码里 `page.screenshot({path: artifactPath('x.png')})` 存图，
 * 然后返回 `{screenshots: [artifactPath('x.png')]}`——本文件识别这个顶层字段，
 * 把图从磁盘读出来存成 dsh 图像附件，随工具结果一起进入模型上下文（模型
 * 就能"看到"截图了）。artifactPath 是浏览器侧注入的全局函数，返回该任务
 * 专属 artifacts 目录下的路径。
 *
 * ─── 必备背景：dsh 的工具注册机制 ────────────────────────────────────────
 *
 * dsh 用 `ctx.tools.register(defineTool({...}))` 注册工具：
 *  - name/description：给模型看的工具名和说明（description 就是"给模型的
 *    使用手册"，写得好坏直接决定模型用得对不对）；
 *  - parameters：参数的 JSON Schema（dsh 据此生成给模型的工具签名并校验）；
 *  - output.schema {type:'json'}：声明结果是结构化 JSON；
 *  - output.render(args, value)：把结果 JSON 渲染成实际进入模型上下文的
 *    【内容块（ContentBlock）数组】——文本块+图像块，这是截图能"被看见"
 *    的机关所在；
 *  - timeoutMs：dsh 对整个 execute 的超时（要 > 我们内部 CLI 的 145 秒超时，
 *    否则 dsh 会先掐掉）；
 *  - execute(args, exec)：真正的执行体。exec 里有 agent（发起会话）、
 *    signal（取消信号，用户点停止时触发）等。
 */
import { readFile, stat } from 'node:fs/promises';

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TabbitCliError } from '../runtime/errors.js';

import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import type {} from '../core/index.js';

/*
 * 工具说明（给模型看的使用手册）。要点：
 *  - 可用的注入全局：browser/context/page/pages()/usePage(p)/assert/expect/artifactPath(name)；
 *  - 跑在用户真实 profile 里（登录态共享；开的标签页用户看得见，成组、不抢焦点）；
 *  - 首次调用传 label 给标签组起个人话名字；
 *  - globalThis 跨调用持久（存状态别重复抓取）；console.* 会被丢弃，只有
 *    返回值能带信息出来；
 *  - 返回值要小且可 JSON 序列化；截图走 screenshots 约定；
 *  - 活干完的最后一次调用传 finish:true 关任务（别让标签组一直挂着）；
 *    该保留标签页时加 keep_tabs:true；
 *  - 会话内第一次动浏览器前先跑一次 tabbit_browser_install 预检、复杂操作前
 *    先加载 tabbit skill。预检不是门禁（本工具不做任何强制），但没跑
 *    过的话"没装/版本旧/服务没起来"只会在这里变成一次失败调用；而 install
 *    工具能直接把安装包下下来。模型不加载 skill 就看不到这条协议，所以
 *    description 里也写一句。
 */
const DESCRIPTION = [
  "Run JavaScript (an async function body) inside the user's Tabbit Browser via genuine Playwright.",
  'Available globals: `browser`, `context`, `page` (current page), `pages()`, `usePage(p)`, `assert`, `expect`, `artifactPath(name)`.',
  "Runs in the user's REAL profile with their logged-in sessions; tabs you open appear in their browser (grouped, non-focus-stealing). Pass `label` on your first call in a session to name that group something readable.",
  '`globalThis` persists across calls in the same task — store state instead of re-scraping. `console.*` output is discarded; communicate via the return value only.',
  'Return small JSON-serializable values. To show yourself a screenshot, save it with `page.screenshot({ path: artifactPath("x.png") })` and return `{ screenshots: [artifactPath("x.png")] }`.',
  'Pass `finish: true` on your last call once this piece of browser work is done, so the task and its tab group close instead of sitting open indefinitely; add `keep_tabs: true` alongside it if the tabs should stay open regardless (e.g. tabs the user pointed you at).',
  "Pass `list_tabs: true` (no code needed) to list every tab currently open in the user's browser — all windows, including tabs you did not open; metadata only, zero side effects. Use it to find a tab the user referred to, then attach that tab via `claim_tabs` when creating a new task.",
  'Call `tabbit_browser_install` once before your first browser call in a session, and load the `tabbit` skill for recipes before non-trivial work.',
].join(' ');

/* 渲染进上下文的文本上限（30k 字符），防止巨型结果撑爆模型上下文。 */
const MAX_RENDERED_CHARS = 30_000;
/* 截图扩展名 → MIME 类型映射（attachments.saveImage 需要）。 */
const IMAGE_MEDIA_BY_EXT: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
/*
 * 合法 artifact 路径的形状校验：必须落在某任务的 artifacts 目录里
 * （…/tasks/task-<uuid>/artifacts/<文件名>）。这是安全边界——防止模型编造
 * 任意路径（如 /etc/passwd、用户私人文件）骗我们读盘上传进上下文。
 */
const ARTIFACT_PATH_PATTERN = /\/tasks\/task-[0-9a-f-]+\/artifacts\/[^/]+$/u;

/* 单张截图的处理结果：attachment（成功存为附件）与 error（失败原因）二选一。 */
interface ScreenshotRecord {
  path: string;
  attachment?: unknown;
  error?: string;
}

/* 工具结果 JSON 的完整形状（渲染前的结构化值）。 */
interface BrowserToolValue {
  status: 'succeeded' | 'failed';
  /* 实际执行所在的任务名（也是浏览器里标签组的标题）。list_tabs 分支无任务，不带。 */
  task?: string;
  /* 成功时解码出的返回值。 */
  value?: unknown;
  /* 结果被截断/无法解析时抢救出的原始文本。 */
  resultText?: string;
  error?: string;
  truncated?: boolean;
  /* true = 任务状态曾丢失（浏览器重启过），之前存的 globalThis/页面没了。 */
  taskWasReset?: boolean;
  /* 自动恢复动作的说明（来自 TabbitClient）。 */
  notes?: string[];
  /* finish:true 且成功关闭时置位。 */
  finished?: true;
  /* finish 失败时的原因（不让整个调用失败，只如实报告）。 */
  finishError?: string;
  screenshots?: ScreenshotRecord[];
  [key: string]: unknown;
}

export const name = 'tabbit-tool-browser';
export const inject = ['tools', 'tabbit'];

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'tabbit_browser',
      description: DESCRIPTION,
      parameters: {
        // code 在 schema 层不再强制（list_tabs:true 的调用没有代码可跑），
        // 但常规调用缺了它会在 execute 里立即得到明确报错——不能让"忘传
        // 代码"静默变成一次空求值。
        code: {
          type: 'string',
          description:
            'Async-function body to evaluate in the browser task (Playwright APIs). Its return value is the tool result. Required unless list_tabs is true.',
        },
        // list_tabs：直连 Runtime Service 端点的全量标签页清单（含用户自开
        // 页面）。零副作用（不建任务/不开页/不拉起浏览器），走
        // ctx.tabbit.listAllTabs() 而非求值——所以离线时如实报离线。
        list_tabs: {
          type: 'boolean',
          description:
            "List every tab of the user's running browser instead of running code: returns { tabCount, tabs: [{ tabId, windowId, index, title, url, active, state, group? }], ... }. state 'available' means the tab can be attached via claim_tabs (new task only); 'busy' means another automation task owns it. tabCount is always the full total; at most 100 entries are returned (listTruncated: true when clipped) — narrow with tabs_filter instead of re-listing. Zero side effects; the browser is never launched for a listing. When set, code/task/finish are ignored.",
        },
        // tabs_filter：大浏览器（真机 170+ 标签页）上全量清单会顶到渲染截断线，
        // 模型必须能按关键词收窄而不是反复重列。
        tabs_filter: {
          type: 'string',
          description:
            'With list_tabs: case-insensitive substring matched against tab title and url, to find a specific tab in a large browser (e.g. the site name the user mentioned).',
        },
        // task：显式指定任务名（不同名字 = 完全独立的浏览器状态）。
        // 一般不传，用会话默认任务即可。
        task: {
          type: 'string',
          description:
            'Named task space. Omit to use the default per-session task (recommended). Distinct names = distinct browser state.',
        },
        // label：给默认任务（= 用户浏览器里的标签组）起人话名字。
        // 只在"本会话第一次调用且没传 task"时生效——名字首调定型（见 core
        // 的 defaultTaskFor），后续换 label 不会换名（换名=换任务=丢状态）。
        label: {
          type: 'string',
          description:
            "Short human-readable description of what this browsing task is for (e.g. \"GitHub trending research\"), shown as the tab group's name in the user's browser. Only used when `task` is omitted AND this is the first tabbit_browser call in the session — later calls (in this session, still omitting `task`) keep the name already established and ignore a new label. Pass this on your first call whenever you can.",
        },
        // read_only：声明本次无副作用。中断后任务不会被隔离（quarantine），
        // 恢复更安全省事。
        read_only: {
          type: 'boolean',
          description: 'Declare that this call performs no mutations (safer recovery after interruptions).',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Per-call evaluation timeout in milliseconds, max 120000 (default 120000).',
        },
        // claim_tabs：把用户【明确指给模型】的已有标签页认领进任务。
        // Runtime Service 的规则是"只在任务创建那一刻生效"，复用任务时它把
        // claim【静默忽略】——静默成功最坑，所以 client.ts 的 evaluateOnce 看到
        // 回执里 reused=true 就自己抛 CLAIM_REQUIRES_NEW_TASK（报错的是我们，
        // 不是服务端），让模型知道要换个新任务名。
        claim_tabs: {
          type: 'array',
          items: { type: 'integer' },
          description:
            'Tab ids EXPLICITLY provided by the user to attach their existing tabs to this task. Only honored when the task is first created.',
        },
        // finish：本次调用后关闭任务（从任务列表消失；除非 keep_tabs，标签组
        // 也一起关）。让模型按任务性质自己判断：一次性查询干完就关；用户可能
        // 接着用的浏览器状态就留着。
        finish: {
          type: 'boolean',
          description:
            "Close this task after this call: it stops appearing in the task list and (unless keep_tabs) its tab group closes. Set this on your LAST call for a piece of work whose browser state doesn't need to survive — judge by the task's nature: a one-off lookup or a completed multi-step job, yes; something the user might reasonably continue in the same browser context next message, no (leave unset).",
        },
        // keep_tabs：配合 finish 用。true = 只摘掉任务追踪、标签页留在浏览器里
        // （对应 CLI 的 --keep；真机验证过 closedTabIds 为空数组）。
        // 典型场景：任务里有用户自己指来的标签页（关了会吓到用户）。
        keep_tabs: {
          type: 'boolean',
          description:
            'Only with finish: true. Leave the tabs this task opened open in the browser instead of closing them. Prefer true when this task claimed tabs the user already had open (closing those would be surprising) or the user may want to keep reading/using what is on screen; otherwise omit (tabs close).',
        },
      },
      output: {
        schema: { type: 'json' },
        // 结果 JSON → 内容块（文本 + 截图图像块）的渲染，见 renderValue。
        render: (_args, value) => renderValue(value as BrowserToolValue),
      },
      // dsh 层的执行超时：160 秒 > 内部 CLI 子进程的 145 秒，保证内部超时
      // 先触发、能给出更有含义的错误（而不是被 dsh 一刀切掐掉）。
      timeoutMs: 160_000,
      async execute(args, exec): Promise<JsonValue> {
        const tabbit = ctx.tabbit;

        // list_tabs 分支：直连清单，与求值路径完全无关（不碰任务/agent/CLI）。
        if (args.list_tabs === true) {
          try {
            const inventory = await tabbit.listAllTabs();
            // 可选按关键词收窄（标题/URL 子串，不区分大小写）。
            const filter = typeof args.tabs_filter === 'string' ? args.tabs_filter.toLowerCase() : '';
            const matched =
              filter === ''
                ? inventory.tabs
                : inventory.tabs.filter(
                    (tab) => tab.title.toLowerCase().includes(filter) || tab.url.toLowerCase().includes(filter),
                  );
            // 真机教训（170 标签页）：全量不限长会顶到 30k 渲染截断线，模型连
            // 总数都读不到。三道防线：①总数字段放在列表【前面】（JSON 按插入
            // 序渲染，截断也先保住总数）；②列表封顶 100 条并显式 listTruncated；
            // ③单条标题/URL 限长。
            return {
              status: 'succeeded',
              tabCount: inventory.tabs.length,
              ...(filter !== '' ? { matchedCount: matched.length } : {}),
              ...(matched.length > 100 ? { listTruncated: true } : {}),
              tabs: matched.slice(0, 100).map((tab) => ({
                tabId: tab.tabId,
                windowId: tab.windowId,
                index: tab.index,
                title: tab.title.slice(0, 80),
                url: tab.url.slice(0, 160),
                active: tab.active,
                state: tab.state,
                ...(tab.group !== null ? { group: tab.group.title || tab.group.groupId } : {}),
              })),
              truncated: inventory.truncated,
            } satisfies BrowserToolValue as unknown as JsonValue;
          } catch (error) {
            if (error instanceof TabbitCliError) {
              return {
                status: 'failed',
                error: friendlyCliError(error),
                errorCode: error.code,
              } satisfies BrowserToolValue as unknown as JsonValue;
            }
            throw error;
          }
        }
        // 常规求值必须有代码（schema 层已放开 required，这里补明确报错）。
        if (args.code === undefined || args.code === '') {
          return {
            status: 'failed',
            error: 'code is required unless list_tabs is true',
            errorCode: 'MISSING_CODE',
          } satisfies BrowserToolValue as unknown as JsonValue;
        }

        // 极端情况下工具可能无所属 agent（如某些编排形态），用 'shared' 兜底。
        const agentId = exec.agent !== undefined ? String(exec.agent.id) : 'shared';
        // 任务名决策：显式 task 优先，否则取会话默认任务（首调可被 label 定名）。
        const task = args.task !== undefined && args.task !== '' ? args.task : tabbit.defaultTaskFor(agentId, args.label);

        const client = tabbit.client();
        let outcome;
        try {
          outcome = await client.evaluate({
            task,
            code: args.code,
            ...(args.read_only === true ? { readOnly: true } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
            ...(args.claim_tabs !== undefined && args.claim_tabs.length > 0 ? { claimTabs: args.claim_tabs } : {}),
            signal: exec.signal, // 用户取消 → 一路传到 CLI 子进程被杀
          });
        } catch (error) {
          // CLI 层错误：转成友好文案的失败【结果】返回（不抛异常）——模型
          // 拿到结构化的 error + errorCode 能自行决定重试/换路，比一条裸异常
          // 有用得多。非 CLI 错误（我们自己的 bug）照常抛出。
          if (error instanceof TabbitCliError) {
            return {
              status: 'failed',
              task,
              error: friendlyCliError(error),
              errorCode: error.code,
            } satisfies BrowserToolValue as unknown as JsonValue;
          }
          throw error;
        }

        // 求值成功（哪怕代码本身失败）说明任务确实存在过：登记
        // "会话 × 任务 × 实际实例"，供会话结束时在正确实例上清理
        // （resolvedInstanceId 的意义见 runtime/client.ts）。
        tabbit.rememberSessionTask(agentId, task, client.resolvedInstanceId());

        // finish 分支：按请求关闭任务。失败不让整个调用报错——求值结果是
        // 真实有效的，只把 finishError 如实附上（例：新版 Runtime Service 会
        // 抢先自动 finalize 闲置任务，我们随后的 finish 会撞 INVALID_STATE，
        // 这是服务端自身行为，属预期兜底）。
        let finishOutcome: Pick<BrowserToolValue, 'finished' | 'finishError'> = {};
        if (args.finish === true) {
          try {
            await client.finishTask(task, { keep: args.keep_tabs === true });
            // 关闭成功：从登记里除名 + 重置默认任务名（下次重新定名，见 core）。
            tabbit.forgetTask(agentId, task);
            finishOutcome = { finished: true };
          } catch (error) {
            finishOutcome = { finishError: `failed to close task: ${String((error as Error)?.message ?? error)}` };
          }
        }

        // 求值失败（模型代码抛异常/超时等）：组装失败结果。
        if (outcome.status === 'failed') {
          return {
            status: 'failed',
            task,
            error: outcome.errorMessage ?? 'evaluation failed',
            ...(outcome.taskWasReset ? { taskWasReset: true } : {}),
            ...(outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
            ...finishOutcome,
          } satisfies BrowserToolValue as unknown as JsonValue;
        }

        // 求值成功：把解码结果装进工具结果。三种形态：
        //  - undefined（无返回值）→ value: null；
        //  - rawText（截断/解析失败）→ resultText + truncated；
        //  - value（正常）→ value（可能带 truncated）。
        const decoded = outcome.result;
        const value: BrowserToolValue = {
          status: 'succeeded',
          task,
          ...(outcome.taskWasReset ? { taskWasReset: true } : {}),
          ...(outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
          ...finishOutcome,
        };
        if (decoded === undefined) {
          value.value = null;
        } else if (decoded.rawText !== undefined) {
          value.resultText = decoded.rawText;
          value.truncated = true;
        } else {
          value.value = decoded.value ?? null;
          if (decoded.truncated) value.truncated = true;
        }

        // 截图约定处理：返回值里有合法的 screenshots 数组就逐张读盘转附件。
        const screenshots = extractScreenshotPaths(value.value);
        if (screenshots.length > 0) {
          value.screenshots = await loadScreenshots(ctx, screenshots, exec.signal);
        }
        return value as unknown as JsonValue;
      },
    }),
  );
}

/*
 * 从返回值里提取截图路径：必须是顶层 screenshots 字段、必须是字符串数组，
 * 最多取前 8 张（防滥用）。形状不对就当没有，不报错。
 */
function extractScreenshotPaths(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const raw = (value as { screenshots?: unknown }).screenshots;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string').slice(0, 8);
}

/*
 * 把截图文件读进 dsh 附件系统。每张图独立成败（一张坏了不拖累别的），
 * 逐张过四道检查：
 *  1. 路径形状必须是任务 artifacts 目录（安全边界，见 ARTIFACT_PATH_PATTERN）；
 *  2. 扩展名必须是已知图像类型；
 *  3. attachments 服务（ctx.get 软取，dsh-attachment 提供）得在场；
 *  4. 文件体积不超过附件服务的图像上限（超了提示模型缩图/裁剪）。
 * 全过 → attachments.saveImage 存成持久图像附件，返回附件引用。
 */
async function loadScreenshots(ctx: Context, paths: string[], signal: AbortSignal): Promise<ScreenshotRecord[]> {
  const attachments = ctx.get('attachments');
  const records: ScreenshotRecord[] = [];
  for (const path of paths) {
    if (!ARTIFACT_PATH_PATTERN.test(path)) {
      records.push({ path, error: 'not a task artifact path; only artifactPath(...) files can be attached' });
      continue;
    }
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    const mediaType = IMAGE_MEDIA_BY_EXT[extension];
    if (mediaType === undefined) {
      records.push({ path, error: 'unsupported image extension' });
      continue;
    }
    if (attachments === undefined) {
      records.push({ path, error: 'attachment service unavailable; screenshot left on disk' });
      continue;
    }
    try {
      const info = await stat(path);
      // 附件服务有两个上限：单图上限 + 单条消息图像总量上限，取小者。
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
      if (info.size > byteCap) {
        records.push({ path, error: `image is ${info.size} bytes (cap ${byteCap}); downscale or clip it` });
        continue;
      }
      if (signal.aborted) break; // 用户已取消：别再做读盘/存附件的重活
      const data = await readFile(path);
      const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType });
      records.push({ path, attachment: ref });
    } catch (error) {
      records.push({ path, error: `failed to read screenshot: ${String((error as Error)?.message ?? error)}` });
    }
  }
  return records;
}

/*
 * 结果渲染：结构化 JSON → 进入模型上下文的内容块数组。
 *  - 文本块：除 screenshots 外的字段 pretty-print 成 JSON（超 30k 截断）；
 *  - 图像块：每张成功转附件的截图追加一个 image 块——模型由此"看见"截图。
 */
function renderValue(value: BrowserToolValue): ContentBlock[] {
  const { screenshots, ...textual } = value;
  let text: string;
  try {
    text = JSON.stringify(stripAttachmentNoise(textual, screenshots), null, 2);
  } catch {
    text = String(textual);
  }
  if (text.length > MAX_RENDERED_CHARS) {
    text = `${text.slice(0, MAX_RENDERED_CHARS)}\n… (rendered output truncated)`;
  }
  const blocks: ContentBlock[] = [{ type: 'text', text }];
  for (const shot of screenshots ?? []) {
    if (shot.attachment !== undefined) {
      blocks.push({ type: 'image', attachment: shot.attachment } as ContentBlock);
    }
  }
  return blocks;
}

/*
 * 文本块里的截图信息瘦身：保留"哪张成了/哪张为什么失败"（路径+错误），
 * 但不把附件引用对象整个 dump 进文本（那是一坨无意义的内部结构噪音）。
 */
function stripAttachmentNoise(textual: Record<string, unknown>, screenshots: ScreenshotRecord[] | undefined): unknown {
  if (screenshots === undefined) return textual;
  return {
    ...textual,
    screenshots: screenshots.map((shot) =>
      shot.error !== undefined ? { path: shot.path, error: shot.error } : { path: shot.path, attached: true },
    ),
  };
}

/*
 * 按错误类别给 CLI 错误补一句"接下来该怎么办"的提示（给模型看）：
 * 没装 → 说明未安装；实例歧义 → 指路 /tabbit-info 和 settings；暂不可用/忙 →
 * 建议稍后重试；超时 → 提醒先核实页面状态再重试带副作用的操作。
 */
function friendlyCliError(error: TabbitCliError): string {
  switch (error.kind) {
    case 'launcher-missing':
      return `${error.message} (Tabbit Browser integration is not installed on this machine.)`;
    case 'instance-selection':
      return `${error.message} (Run /tabbit-info to list instances, then set settings key tabbit.instance.)`;
    case 'browser-unavailable':
      return `${error.message} (Tabbit Browser may be starting; retry shortly.)`;
    case 'busy':
      return `${error.message} (The browser runtime is at capacity; retry shortly.)`;
    case 'tab-claim':
      return error.message;
    case 'timeout':
      return `${error.message} (After a timeout, verify page state before retrying side-effectful actions.)`;
    default:
      return error.message;
  }
}
