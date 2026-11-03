window.__ModuleLoader__.load({ id: "dsh-tabbit", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';

/*
 * ============================================================================
 * 文件职责：dsh Web 客户端插件——`@tab` 提及的前端半边 + 观看实例打点
 * ============================================================================
 *
 * ⚠️ 本文件跑在【浏览器里的 dsh 网页】上，不是 Node 进程！它是 package.json
 * `dsh.client` 声明的客户端模块，由 dsh 以 /plugins/dsh-tabbit/client.js
 * 静态服务、被网页加载执行。
 *
 * 首尾两行的 window.__ModuleLoader__.load({id, factory}) 是 dsh Web 端的
 * 客户端模块装载协议：手写这个外壳（而不是上 webpack/vite 打包链）是刻意
 * 选择——本文件零依赖、百来行，不值得为它引入一整套构建。factory 里手工
 * 模拟了 CommonJS 的 module/exports，最后 return module.exports 交回给
 * ModuleLoader。（middle 部分随便改，首尾包裹行不要动。）
 *
 * 功能一：页面加载即向 /tabbit/instance-hint 打点（fire-and-forget），
 *   让服务端检测"用户正用哪个 Tabbit 看 dsh"（→ 优先在那个实例执行任务）。
 * 功能二：注册两个 `@` 输入源（排在 dsh 自带的"文件与文件夹/对话"之后）：
 *   ①"网页标签"——两类单页候选：本会话浏览器任务里打开的页面
 *   （kind:'task-page'）与用户浏览器里的普通标签页（kind:'user-tab'，
 *   服务端直连 Runtime Service 清单）；标签组主页（group-home，无正文的
 *   空壳页）已被服务端屏蔽，不会混进来。
 *   ②"标签组"——整组候选：服务端按 groupId 实时聚合的组清单（标题 +
 *   可读取成员页），单独成组展示，不与单页混排。兑现走【引用】而非发送
 *   时提取：chip 只携带组标题+成员清单，发送零等待；注入的引用块引导
 *   模型在对话里按需用 tabbit_browser / web_fetch 自提正文。
 *   两个源共用同一份 roster（短 TTL 缓存，避免菜单展开时打两次）。
 *   选中插入 chip；点发送时立即调用 /tabbit/mention/extract 现场提取（失败
 *   阻断发送，语义不变），但序列化结果不再是整段正文——服务端把提取到的
 *   正文暂存、只回一个短 token，这里拼出 `@[标题](tabbit-tab:token)` 这样
 *   的短标记塞进气泡文本。真正的正文由服务端的 `agent/pre-step` 钩子
 *   （src/mentions/index.ts）在模型即将看到这条消息前，凭 token 取回并接成
 *   一条独立的、默认折叠的上下文消息——和 dsh 内置 @文件/@对话 的做法一致，
 *   聊天气泡里不会直接堆全文。候选与提取的数据都来自服务端的
 *   /tabbit/mention/* 路由（src/mentions/index.ts），同源 fetch 直连。
 *
 * dsh 客户端插件协议与服务端 Cordis 如出一辙：导出 {name, inject, apply(ctx)}；
 * 这里注入的 'inputTriggers' 是 dsh-client-ui-input-trigger 提供的"输入框
 * 触发菜单"服务（package.json dsh.client.inject 里声明了要它一起装）；
 * 共享的触发菜单负责渲染候选列表 UI——@tab 部分只提供数据，不需要 React。
 *
 * 历史版本的 tabbit/status 自定义会话事件会导致日志冷加载失败（issue #22）。
 * 宿主持久层对未知事件要求 ignorable 标记，插件侧尚无设置入口；因此不要
 * 恢复自定义状态卡或向会话追加自定义事件（见 AGENTS.md）。
 */

/*
 * 本输入源的注册名（也是 chip 序列化时的 source 标识）。这个字符串同时是
 * @ 菜单分组标题——宿主用 t(source.name) 做本地化查找，查不到译文（我们
 * 的分组名从不在宿主词典里）就原样显示这个字符串，这是宿主自己的
 * "cordis" 提及源也在用的既有兜底行为，不是 hack。
 */
const SOURCE_NAME = '网页标签';
/*
 * 候选键 → 完整标签页引用（task/url/index/title）的暂存表。
 * 为什么需要它：候选条目（candidate）只有 name/description 两个字符串字段，
 * 塞不下结构化引用；先寄存在这里，用户选中时（onPick）再按键取回。
 */
const refByKey = new Map();

/* 从 dsh 会话对象里取会话 id（兼容 sessionId/id 两种字段形状）。 */
function sessionIdOf(session) {
  if (!session) return '';
  return String(session.sessionId || session.id || '');
}

/*
 * 候选名直接用页面标题（回退 URL）——菜单把 name 当主文案渲染（dsh 自带的
 * "对话"源就是人话标题），mangle 成 slug 会显得粗糙。name 同时是 refByKey
 * 的键，必须唯一：同标题的多个标签页给后来者追加 " ·2" 序号消歧。
 */
function candidateName(tab, seen) {
  const base = String(tab.title || tab.url || 'tab').trim().slice(0, 60) || 'tab';
  const count = (seen.get(base) || 0) + 1;
  seen.set(base, count);
  return count > 1 ? base + ' ·' + count : base;
}

/*
 * @ 菜单一次最多渲染的候选数——菜单本身带滚动条（宿主 MenuView 的
 * viewport 是 overflow-y:auto），这里不是"菜单能放几条"的硬限制，只是
 * 防止真机 170+ 标签页时一次性渲染过多 DOM；对齐宿主"对话"提及源自己用
 * 的候选上限（50）。想找更靠后的标签页，继续敲字过滤即可（query 是对
 * 服务端返回的全量清单做的，不受这个数字影响）。
 */
const MAX_CANDIDATES = 50;

/*
 * 给标记文本里的标题转义：serialize() 把它嵌进 `@[标题](tabbit-tab:token)`
 * 这样的短标记里，方括号会打乱服务端 agent/pre-step 钩子的解析——把它们
 * 换成空格，不影响可读性。
 */
function sanitizeMarkerTitle(text) {
  return String(text || '').replace(/[[\]()]/gu, ' ').trim() || 'tab';
}

/* 拉取本会话的候选清单（GET /tabbit/mention/tabs），归一成 {tabs, groups}。 */
async function fetchRoster(sessionId) {
  try {
    const response = await fetch('/tabbit/mention/tabs?session=' + encodeURIComponent(sessionId));
    if (!response.ok) return { tabs: [], groups: [] };
    const data = await response.json().catch(() => ({}));
    return {
      tabs: Array.isArray(data.tabs) ? data.tabs : [],
      // 旧服务端（≤0.3.5）没有 groups 字段——归一为空数组，组源静默空置。
      groups: Array.isArray(data.groups) ? data.groups : [],
    };
  } catch {
    return { tabs: [], groups: [] };
  }
}

/*
 * 两个 @ 源共用同一份 roster 的短 TTL 缓存：菜单每次展开，"网页标签"和
 * "标签组"两个源的 candidates() 几乎同时被调，没有这层就会对同一个路由
 * 打两次请求。2 秒 TTL 只合并同一次展开的并发调用，不影响标签页增删的
 * 时效性。刻意不带 AbortSignal——共享请求被任一调用方的菜单关闭取消掉，
 * 会拖死另一个源（这本是个毫秒级的本机请求，取消防语义收益为零）。
 */
let rosterCache = null; // { session, at, promise }
function fetchRosterShared(sessionId) {
  const now = Date.now();
  if (rosterCache && rosterCache.session === sessionId && now - rosterCache.at < 2000) {
    return rosterCache.promise;
  }
  const promise = fetchRoster(sessionId);
  rosterCache = { session: sessionId, at: now, promise };
  return promise;
}

/*
 * 输入源定义——inputTriggers 服务约定的接口形状：
 *   trigger：触发字符（@）；order：多个 @ 源并存时的排序；
 *   candidates()：给出候选；onPick()：用户选中一条时怎么插入；
 *   codec：chip 的序列化协议（clipboardText 复制文案 + serialize 发送时展开）。
 */
const source = {
  trigger: '@',
  name: SOURCE_NAME,
  // 正数：排在宿主"文件与文件夹/对话"（reference 源，order 默认 0）后面。
  order: 10,
  /*
   * 产出候选列表。request.query 是 @ 后面已敲的过滤词，按标题/URL 包含匹配
   * （不区分大小写）；最多 MAX_CANDIDATES 条（菜单本身会滚动，这不是硬
   * 上限，见常量注释）。roster 拉取失败静默返回空——@ 菜单永远不能因为
   * 我们炸掉。每条候选把完整引用寄存进 refByKey，键 = 序号+标题slug。
   */
  async candidates(session, request) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return [];
    // fetchRosterShared 自带异常归一（空清单），不会再抛错——@ 菜单永远
    // 不能因为我们炸掉。
    const { tabs } = await fetchRosterShared(sessionId);
    const query = String((request && request.query) || '').toLowerCase();
    const matched = tabs.filter((tab) => {
      if (!query) return true;
      return (
        String(tab.title || '').toLowerCase().includes(query)
        || String(tab.url || '').toLowerCase().includes(query)
      );
    });
    const seen = new Map();
    return matched.slice(0, MAX_CANDIDATES).map((tab) => {
      const label = tab.title || tab.url;
      const key = candidateName(tab, seen);
      // 两类候选的引用形状不同：任务页记 task/index（就地提取要用），
      // 用户标签页记 userTab 标志（提取走服务端重取分支）。
      refByKey.set(
        key,
        tab.kind === 'user-tab'
          ? { userTab: true, url: tab.url, title: label, tabId: tab.tabId }
          : { task: tab.task, url: tab.url, index: tab.index, title: label },
      );
      return {
        name: key, // 候选主文案，同时是唯一键（onPick 靠它回查 refByKey）
        description: tab.url, // 菜单里的副标题
        // 前缀图标：宿主的候选图标是封闭枚举（只有 file/folder/session
        // 三种，见 dsh-client-ui-input-trigger），没有 favicon/自定义图标的
        // 位置——统一用 file（宿主里渲染成一个"浏览"风格的图标）。
        icon: 'file',
        // 来源徽标：任务页标出"是代理任务里的页"，普通标签页只标 Tabbit。
        hint: tab.kind === 'user-tab' ? 'Tabbit' : 'Tabbit task',
      };
    });
  },
  /*
   * 用户选中候选 → 返回插入指令：往输入框插一个真实 chip。
   *   ref：chip 携带的引用数据（JSON 字符串，发送时交给 codec.serialize）；
   *   label：chip 显示文本；clipboardText：chip 被复制时的纯文本形态。
   */
  onPick(pick) {
    const ref = refByKey.get(pick.candidate.name);
    if (!ref) return undefined;
    return {
      insert: {
        source: SOURCE_NAME,
        ref: JSON.stringify(ref),
        label: ref.title,
        clipboardText: '@' + ref.title,
      },
    };
  },
  codec: {
    /* 含 chip 的内容被复制成纯文本时，chip 显示为 "@标题"。 */
    clipboardText(ref) {
      try {
        return '@' + (JSON.parse(ref).title || 'tab');
      } catch {
        return '@tab';
      }
    },
    /*
     * 【发送时】的序列化：dsh 在用户点发送时对每个 chip 调用它，返回值
     * 替换 chip 进入实际发给模型的提示词。
     * 这里调 POST /tabbit/mention/extract 现场提取页面标题+正文——提取失败
     * 就【抛异常阻断发送】（输入框保留草稿和 chip），语义与之前完全一样：
     * 用户以为引用了页面内容、实际上没引上的"静默降级"，比一次显式失败
     * 糟糕得多。
     *
     * 变化的是【提取成功之后】：正文不再直接拼进这里的返回值（那会让整段
     * 网页正文直接堆进用户能看到的聊天气泡）。服务端把提取到的正文暂存，
     * 只把一个一次性 token 回给我们；这里只拼一个短标记
     *   @[标题](tabbit-tab:token)
     * 塞进发出去的文本。真正的正文由服务端的 agent/pre-step 钩子
     * （src/mentions/index.ts）在这条消息即将进入模型这一步时，凭 token
     * 取回暂存内容、接成一条独立的、默认折叠的"Context injection"消息
     * ——聊天气泡里最终只看得到 "@标题"，和 dsh 内置 @文件/@对话 的观感
     * 一致，模型仍然完整拿到正文。
     */
    async serialize(ref, signal) {
      const parsed = JSON.parse(ref);
      // 两类 chip 的提取请求体不同（服务端按 userTab 分流）：
      //   任务页 → {task,url,index} 就地读取；用户标签页 → {url,userTab:true}
      //   服务端在共享 fetch 任务里重取该 URL（不触碰用户原标签页）。
      const body = parsed.userTab === true
        ? { url: parsed.url, userTab: true }
        : { task: parsed.task, url: parsed.url, index: parsed.index };
      const response = await fetch('/tabbit/mention/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error('tab mention failed: ' + (data.error || response.status));
      }
      const title = sanitizeMarkerTitle(data.title || parsed.title);
      return '@[' + title + '](tabbit-tab:' + data.token + ')';
    },
  },
};

/*
 * 组输入源的注册名（也是 chip 序列化时的 source 标识与 @ 菜单分组标题）。
 * 与"网页标签"刻意分成两个源：宿主菜单按源分节渲染，标签组由此【单独成组】
 * 展示，不与单页候选混排。
 */
const GROUP_SOURCE_NAME = '标签组';
/*
 * 组候选键 → 完整组引用（groupId/title/count）的暂存表，与 refByKey 同理：
 * 候选条目只有 name/description 两个字符串字段，结构化引用先寄存、选中时
 * 按键取回。
 */
const groupRefByKey = new Map();

/*
 * 组 chip 的 ref 里最多携带的成员页数：清单最终拼进 chip 的 JSON ref（草稿
 * 状态的一部分），带太多只会徒增体积；服务端注入时也按 30 个列出（超出
 * 注明页数），多带没有意义。
 */
const GROUP_REF_MAX_CARRIED = 30;

/*
 * "标签组"输入源——接口形状与 "网页标签" 相同（trigger/order/candidates/
 * onPick/codec），差异在数据与兑现方式：
 *   候选来自 roster 的 groups 段（服务端按 groupId 实时聚合；member 过滤
 *   规则保证每组至少有一个能兑现内容的页）；过滤词除组标题外也匹配成员页
 *   的标题/URL——想不起组名时可以按内容把组搜出来。
 *   兑现刻意【不做】发送时提取：整组逐页重取最坏要数分钟，会把"点发送"
 *   卡成长等待。chip 只携带组引用（标题 + 成员页清单），序列化时调
 *   {"groupRef":...} 毫秒级暂存；正文由模型在对话里按需用 tabbit_browser /
 *   web_fetch 自行提取（注入的 <browser-tab-group> 引用块里有指引措辞）。
 */
const groupSource = {
  trigger: '@',
  name: GROUP_SOURCE_NAME,
  // 排在 "网页标签"（order 10）之后。
  order: 11,
  async candidates(session, request) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return [];
    const { groups } = await fetchRosterShared(sessionId);
    const query = String((request && request.query) || '').toLowerCase();
    const matched = groups.filter((group) => {
      if (!query) return true;
      if (String(group.title || '').toLowerCase().includes(query)) return true;
      const members = Array.isArray(group.members) ? group.members : [];
      return members.some(
        (member) =>
          String(member.title || '').toLowerCase().includes(query)
          || String(member.url || '').toLowerCase().includes(query)
      );
    });
    const seen = new Map();
    return matched.slice(0, MAX_CANDIDATES).map((group) => {
      const members = Array.isArray(group.members) ? group.members : [];
      const title = String(group.title || '').trim() || '未命名标签组';
      // 组名也要消歧（可重名）：与网页候选同一套 ·2 序号规则。
      const key = candidateName({ title, url: '' }, seen);
      groupRefByKey.set(key, {
        groupId: group.groupId,
        title,
        count: members.length,
        // 成员清单随 chip 走（发送时的 groupRef 暂存要用），最多带 30 个。
        members: members
          .slice(0, GROUP_REF_MAX_CARRIED)
          .map((member) => ({ url: String(member.url || ''), title: String(member.title || '') }))
          .filter((member) => member.url !== ''),
      });
      return {
        name: key, // 候选主文案，同时是唯一键（onPick 靠它回查 groupRefByKey）
        description: members.length + ' 个页面',
        // 组用 folder 图标（宿主封闭枚举 file/folder/session 里最贴合"一组
        // 页面"语义的一个）。
        icon: 'folder',
        hint: 'Tabbit',
      };
    });
  },
  /* 选中组候选 → 插 chip（ref 携带组引用：groupId + 标题 + 成员页清单）。 */
  onPick(pick) {
    const ref = groupRefByKey.get(pick.candidate.name);
    if (!ref) return undefined;
    return {
      insert: {
        source: GROUP_SOURCE_NAME,
        ref: JSON.stringify(ref),
        label: ref.title,
        clipboardText: '@' + ref.title,
      },
    };
  },
  codec: {
    /* 含组 chip 的内容被复制成纯文本时，chip 显示为 "@组名"。 */
    clipboardText(ref) {
      try {
        return '@' + (JSON.parse(ref).title || '标签组');
      } catch {
        return '@标签组';
      }
    },
    /*
     * 组 chip 的发送时序列化：POST {"groupRef":{groupId,title,members}}——
     * 【零抓取】，服务端只把组引用暂存起来回 token，毫秒级返回，发送不被
     * 任何页面提取卡住。pre-step 钩子把 token 展开成 <browser-tab-group>
     * 引用块（成员清单 + 提取指引）；正文由模型在对话里按需用
     * tabbit_browser / web_fetch 自行提取。
     * 清单全无效时服务端回 400，这里同样【抛异常阻断发送】——与单页 chip
     * 的语义一致（显式失败好过静默降级）。
     */
    async serialize(ref, signal) {
      const parsed = JSON.parse(ref);
      const response = await fetch('/tabbit/mention/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          groupRef: { groupId: parsed.groupId, title: parsed.title, members: parsed.members || [] },
        }),
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error('tab group mention failed: ' + (data.error || response.status));
      }
      const title = sanitizeMarkerTitle(data.title || parsed.title);
      return '@[' + title + '](tabbit-tab:' + data.token + ')';
    },
  },
};

module.exports = {
  name: 'dsh-tabbit-client',
  inject: ['inputTriggers'],
  apply(ctx) {
    // 观看实例打点：告诉服务端"是哪个浏览器在看这个页面"。fire-and-forget
    // （不 await、双层吞错）——纯属锦上添花的提示，任何失败都不能影响页面。
    // 服务端由这条连接的 socket 对端溯源出 Tabbit 实例（详见 src/runtime/peer.ts），
    // 之后浏览器任务会优先在那个实例上执行。
    try {
      fetch('/tabbit/instance-hint', { method: 'POST' }).catch(() => {});
    } catch {}

    // 功能二："网页标签" + "标签组" 两个输入源。
    const inputTriggers = ctx.get('inputTriggers');
    // 防御：服务缺席或形状不对（宿主版本过旧）就静默不注册。
    if (inputTriggers && typeof inputTriggers.registerSource === 'function') {
      // registerSource 返回 disposer（宿主文档：调用方应包进 ctx.effect）；
      // 合成一个联合 disposer，卸载时两个源一起回收。老宿主不返回 disposer，
      // 逐段判空防御。
      const register = () => {
        const disposeTabs = inputTriggers.registerSource(source);
        const disposeGroups = inputTriggers.registerSource(groupSource);
        return () => {
          if (typeof disposeTabs === 'function') disposeTabs();
          if (typeof disposeGroups === 'function') disposeGroups();
        };
      };
      // 优先经 ctx.effect 注册（宿主支持时可在插件卸载时正确回收）；
      // 老宿主没有 effect 就直接注册。
      if (typeof ctx.effect === 'function') {
        ctx.effect(register, 'dsh-tabbit: @tab sources');
      } else {
        register();
      }
    }
  },
};

return module.exports; } });
