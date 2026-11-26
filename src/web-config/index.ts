/* 在 Cordis 已合并的 web 配置上补抓取默认值，搜索字段由宿主原样求值。 */
import type { Context } from '@deepseek-ai/cordis';

interface WebConfigPatch { id?: string; name?: string; config?: unknown }
interface LoaderEntry {
  options?: { id?: string; name?: string };
  parent?: { tree?: { config?: { patches?: WebConfigPatch[] } } };
}
interface LoaderFiber { entry?: LoaderEntry }
type ConfigListener = (this: LoaderFiber | undefined, input: unknown, next: () => unknown) => unknown;
type ListenForConfig = (
  event: 'internal/config', listener: ConfigListener, options: { global: boolean },
) => unknown;

export const name = 'tabbit-web-config';

/* 官方基座通过 insert 声明 HTTP 默认值。单独覆盖 web.config 的补丁可显式选回 HTTP。 */
function hasWebConfigOverride(entry: LoaderEntry): boolean {
  return entry.parent?.tree?.config?.patches?.some((patch) =>
    patch.id === 'web' && (!patch.name || patch.name === entry.options?.name) && Object.hasOwn(patch, 'config'),
  ) ?? false;
}

/* 保留整个最终 config。空缺时使用 Tabbit，已有第三方 fetch provider 继续生效。 */
function applyFetchDefault(config: unknown, entry: LoaderEntry): unknown {
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) return config;
  const options = (config ?? {}) as Record<string, unknown>;
  const preferred = process.env.DSH_WEB_FETCH_PROVIDER ?? 'tabbit-browser';
  if (typeof options.__jsExpr === 'string') {
    // 整段 !!js 在 Loader 中求值，其返回对象的其他字段也保持原样。
    return {
      __jsExpr: `((value) => ({ ...value, fetchProvider: value?.fetchProvider ?? ${JSON.stringify(preferred)} }))(eval(${JSON.stringify(options.__jsExpr)}))`,
    };
  }
  const fetchProvider = options.fetchProvider;
  if (fetchProvider && typeof fetchProvider === 'object') {
    const expression = (fetchProvider as { __jsExpr?: unknown }).__jsExpr;
    if (typeof expression === 'string') {
      return { ...options, fetchProvider: { __jsExpr: `eval(${JSON.stringify(expression)}) ?? ${JSON.stringify(preferred)}` } };
    }
  }
  if (fetchProvider != null && (fetchProvider !== 'http' || hasWebConfigOverride(entry))) return config;
  return { ...options, fetchProvider: preferred };
}

/* web 行依赖该服务，确保 Loader 在校验配置前已装好配置钩子。 */
export function apply(ctx: Context): void {
  const tree = (ctx.fiber as LoaderFiber | undefined)?.entry?.parent?.tree;
  const on = ctx.on as unknown as ListenForConfig;
  on.call(ctx, 'internal/config', function (input, next) {
    // Cordis 4.2 在首参传 fiber，早期版本把 fiber 绑定给 this。
    const entry = this?.entry ?? (input as LoaderFiber | undefined)?.entry;
    const config = next();
    if (entry?.options?.id !== 'web' || (tree && entry.parent?.tree !== tree)) return config;
    return applyFetchDefault(config, entry);
  }, { global: true });
  ctx.provide('tabbitFetchDefaults', true);
}
