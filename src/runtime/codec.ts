/*
 * ============================================================================
 * 文件职责：求值结果的 base64「信封」编解码（codec = coder/decoder）
 * ============================================================================
 *
 * 为什么需要这个文件？——为了绕开 Tabbit CLI 的一个真实 bug：
 *
 * 1. 我们提交给浏览器执行的代码，其返回值由 Runtime Service 写进一张「回执」
 *    （receipt）。回执小于 8 KiB 时直接内联返回；【大于 8 KiB 时会被"溢出"
 *    （spill）到一个资源文件】，之后要用 `resource` 子命令按固定
 *    8192 字节一块地分块读回。
 *
 * 2. 问题在于：CLI 读回资源时是【逐块按 UTF-8 解码】的。而 UTF-8 里一个中文
 *    字符占 3 字节——如果这 3 个字节恰好横跨两个 8192 字节块的边界，两边各自
 *    解码时都会把这半个字符变成乱码（U+FFFD）。也就是说：只要返回值里有中文
 *    （或任何非 ASCII 字符）且体积超过 8 KiB，读回的内容【必然损坏】。
 *    这是实测踩到的坑，不是理论推演。
 *
 * 解决方案（本文件实现的"信封"协议）：
 *    - 发送端（浏览器里）：把模型代码的返回值先 JSON.stringify，再整体转成
 *      base64。base64 只含 ASCII 字符（每字符 1 字节），怎么切块都不会损坏。
 *      最后拼上前缀 "b64:"（或截断时 "b64trunc:"）作为标记。
 *    - 接收端（本文件 decodeEnvelope）：识别前缀、base64 解码、JSON.parse，
 *      还原出原始值。
 *
 * 这层信封对模型完全透明：模型写的代码正常 return，工具正常拿到值。
 */

/* 完整结果的信封前缀。 */
export const ENVELOPE_PREFIX = 'b64:';
/* 浏览器侧就已截断（超过下面的字符上限）的信封前缀。 */
export const ENVELOPE_TRUNCATED_PREFIX = 'b64trunc:';

/*
 * 返回值 JSON 文本的字符数上限（150 万字符），超过就在浏览器侧先截断。
 * 目的：防止模型不小心 return 一个巨型对象，把分块读回的时间拖到不可接受。
 */
export const MAX_RESULT_JSON_CHARS = 1_500_000;

/*
 * 把模型写的「async 函数体」包装成实际提交给 Runtime Service 的完整源码。
 *
 * 背景知识：Runtime Service 的持久求值器（persistent evaluator）收到 stdin
 * 里的代码后，会自己再套一层 `(async () => { <stdin内容> })()` 执行。所以
 * 我们这里生成的字符串本身就是一个"函数体"——最外层的 `return` 就是最终
 * 返回给服务端的值。
 *
 * 包装结构（生成的代码在【浏览器进程里】执行，不在本 Node 进程）：
 *   1. __dshEncode：UTF-8 → base64 的编码函数。优先用 Node 的 Buffer
 *      （Tabbit 的求值环境里有）；万一没有则退回浏览器经典的
 *      btoa+encodeURIComponent 组合技。
 *   2. 把模型代码再包一层嵌套的 async IIFE（立即执行函数）并 await——
 *      这样模型代码里自己写的 `return` 只会结束这层 IIFE、把值交给
 *      __dshValue，不会干扰我们外层的信封逻辑。
 *   3. JSON.stringify 该值；undefined 归一成 null；序列化抛异常（比如值里
 *      有循环引用）时改为返回 {__dshSerializationError: 错误信息}。
 *   4. 超长先截断（打 b64trunc: 前缀），否则打 b64: 前缀，整体 base64 后
 *      return——这就是走网线（其实是走 CLI stdout/资源文件）的最终形态。
 *
 * ⚠️ 注意：下面模板字符串里的内容是要原样发给浏览器执行的代码，
 * 请勿在字符串内部添加任何注释或改动（会改变实际下发的代码）。
 */
export function buildEvaluationSource(body: string): string {
  return `const __dshEncode = (text) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  return btoa(unescape(encodeURIComponent(text)));
};
const __dshValue = await (async () => {
${body}
})();
let __dshJson;
try {
  __dshJson = JSON.stringify(__dshValue === undefined ? null : __dshValue);
  if (typeof __dshJson !== 'string') __dshJson = 'null';
} catch (error) {
  __dshJson = JSON.stringify({ __dshSerializationError: String((error && error.message) || error) });
}
if (__dshJson.length > ${MAX_RESULT_JSON_CHARS}) {
  return '${ENVELOPE_TRUNCATED_PREFIX}' + __dshEncode(__dshJson.slice(0, ${MAX_RESULT_JSON_CHARS}));
}
return '${ENVELOPE_PREFIX}' + __dshEncode(__dshJson);`;
}

/*
 * 解码后的结果。两个字段互斥：
 *  - value：信封完整走通时，还原出的原始值；
 *  - rawText：截断或无法 JSON.parse 时，能抢救出来的原始 JSON 文本片段。
 */
export interface DecodedResult {
  /* 信封完整往返时解析出的原值。 */
  value?: unknown;
  /* 被截断或解析失败时的原始 JSON 文本。 */
  rawText?: string;
  truncated: boolean;
}

/*
 * 宽松的 base64 解码：
 *  1. 先剔除所有非 base64 字符（分块读回时可能混入引号、换行等杂质）；
 *  2. 把长度裁到 4 的整数倍（base64 每 4 字符编码 3 字节，尾部不完整的
 *     "量子"直接丢弃）——这样即使数据被截断在任意位置也能解出前缀部分。
 */
function decodeBase64Lenient(body: string): string {
  const clean = body.replace(/[^A-Za-z0-9+/=]/gu, '');
  const usable = clean.slice(0, clean.length - (clean.length % 4));
  return Buffer.from(usable, 'base64').toString('utf8');
}

/*
 * 解码一个从求值返回的"线上值"（wire value）。
 *
 * @param wireValue CLI 返回的原始值。可能是：带信封前缀的字符串（正常路径）、
 *                  不带前缀的任意值（比如老版本/别的任务写的，直接原样透传）。
 * @param complete  资源分块读回是否读到了 EOF。为 false 表示读取被字节上限
 *                  截停了——此时 base64 可能断在任意位置，解出来的 JSON 文本
 *                  只是个前缀，不再尝试 JSON.parse，直接作为 rawText 返回。
 */
export function decodeEnvelope(wireValue: unknown, complete = true): DecodedResult {
  // 不是字符串就不可能带信封，原样返回（数字、布尔、对象等）。
  if (typeof wireValue !== 'string') {
    return { value: wireValue, truncated: false };
  }
  if (wireValue.startsWith(ENVELOPE_PREFIX)) {
    const text = decodeBase64Lenient(wireValue.slice(ENVELOPE_PREFIX.length));
    if (complete) {
      try {
        return { value: JSON.parse(text), truncated: false };
      } catch {
        // 理论上完整信封必可解析；解析不了说明数据异常，把文本原样交上去。
        return { rawText: text, truncated: true };
      }
    }
    // 读回不完整：JSON 文本只是前缀，parse 注定失败，直接给 rawText。
    return { rawText: text, truncated: true };
  }
  if (wireValue.startsWith(ENVELOPE_TRUNCATED_PREFIX)) {
    // 浏览器侧就截断过了，永远只能拿到文本片段。
    const text = decodeBase64Lenient(wireValue.slice(ENVELOPE_TRUNCATED_PREFIX.length));
    return { rawText: text, truncated: true };
  }
  // 无信封前缀的普通字符串：原样返回。
  return { value: wireValue, truncated: false };
}
