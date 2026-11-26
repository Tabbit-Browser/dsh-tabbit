/* Cordis 整段替换 web.config；通过 DSH 自身的组合器继承此前的搜索设置。 */
import type { Context } from '@deepseek-ai/cordis';
import { createRequire } from 'node:module';
import { readHostVersion } from '../host-version.js';

interface ProfileLocation { name: string; dir: string; home: string; installAnchor: string }
interface BundleLayer { patches: { insert?: { name: string }[] }[] }
interface WebEntry { id?: string; config?: Record<string, unknown> }
interface AppBoot {
  loadProfile(bin: string, name: string, anchor: string, home: string, options: { userLayer: boolean }): { layers: BundleLayer[] };
  loadProfileDirectory?(bin: string, dir: string, anchor: string, options: { userLayer: boolean }): { layers: BundleLayer[] };
  composeEntries(layers: unknown[][]): WebEntry[];
}

export const name = 'tabbit-web-config';

/* 由 web 行在求值配置时调用。用户 profile 和命令行补丁仍由 DSH 在 bundle 之后应用。 */
function inheritedSearchProvider(ctx: Context): string | undefined {
  const profile = ctx.get('profileContext') as ProfileLocation | undefined;
  // 早期 0.1.x 尚未提供 profileContext，基座默认走 DeepSeek Messages 搜索。
  if (!profile?.installAnchor) return readHostVersion()?.startsWith('0.1.') ? 'deepseek-official' : undefined;
  const require = createRequire(profile.installAnchor);
  const boot = require('@deepseek-ai/dsh-app-boot') as AppBoot;
  const { layers } = boot.loadProfileDirectory?.('dsh', profile.dir, profile.installAnchor, { userLayer: false })
    ?? boot.loadProfile('dsh', profile.name, profile.installAnchor, profile.home, { userLayer: false });
  // 通过本包插入的行识别边界，安装别名和浏览器内置 bundle 也能识别。
  const index = layers.findIndex(layer => layer.patches.some(patch =>
    patch.insert?.some(row => row.name === 'dsh-tabbit/web-config'),
  ));
  // 若以额外 overlay 加载本补丁，profile 中已有的所有 bundle 都在它之前。
  const preceding = index < 0 ? layers : layers.slice(0, index);
  const web = boot.composeEntries(preceding.map(layer => layer.patches)).find(entry => entry.id === 'web');
  const setting = web?.config?.searchProvider;
  if (setting === undefined || typeof setting === 'string') return setting;
  // 自定义 bundle 可使用 !!js 表达式，让同一版本的宿主在 web 条目上下文中求值。
  const { interpolate } = require('@deepseek-ai/cordis-plugin-loader');
  return interpolate(ctx, setting);
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tabbitInheritedSearchProvider: typeof inheritedSearchProvider;
  }
}

/* 配置服务独立于浏览器连接，离线或关闭浏览器工具时也能组装 web 服务。 */
export function apply(ctx: Context): void {
  ctx.provide('tabbitInheritedSearchProvider', inheritedSearchProvider);
}
