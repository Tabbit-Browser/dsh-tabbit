/* DSH 0.2 把旧 settings.yaml 导入 profile；tabbit 节与插件行 id 不同，需单独迁移。 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import { parse } from 'yaml';
import type { TabbitSettings } from './index.js';

type SettingKey = keyof TabbitSettings;
const SETTING_KEYS: SettingKey[] = ['instance', 'launcherPath', 'pageAccess', 'intranetFetch'];
const MIGRATION_MARKER = '.dsh-tabbit-settings-migrated';

interface ProfileLocation { home: string; dir: string }
interface LegacySettings { marker: string; values: Partial<TabbitSettings> }
interface SettingsEntry { options?: { config?: unknown }; evaluate?(expression: string): unknown }
interface LoaderRoot { loader?: { await(): Promise<void> } }
const CORDIS_ROOT = Symbol.for('cordis.root');
const evaluatedConfigs = new WeakMap<SettingsEntry, { raw: object; resolved: unknown }>();

interface SettingsView {
  describe(): { ns: string; user?: unknown; revision: number }[];
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
}

/* 旧文件可能尚未被宿主改名，也可能已经留在 .imported 备份里。 */
function readLegacySection(home: string): Record<string, unknown> | undefined {
  for (const name of ['settings.yaml', 'settings.yaml.imported']) {
    let text: string;
    try {
      text = readFileSync(join(home, name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const document = parse(text) as unknown;
    if (document === null || typeof document !== 'object' || Array.isArray(document)) continue;
    const section = (document as Record<string, unknown>).tabbit;
    if (section !== null && typeof section === 'object' && !Array.isArray(section)) {
      return section as Record<string, unknown>;
    }
  }
  return undefined;
}

/* 只取旧版确实支持的四项，避免把无效值写进新版 profile。 */
function validLegacyValues(section: Record<string, unknown>): Partial<TabbitSettings> {
  const result: Partial<TabbitSettings> = {};
  if (typeof section.instance === 'string') result.instance = section.instance;
  if (typeof section.launcherPath === 'string') result.launcherPath = section.launcherPath;
  if (section.pageAccess === 'ask' || section.pageAccess === 'always' || section.pageAccess === 'never') {
    result.pageAccess = section.pageAccess;
  }
  if (section.intranetFetch === 'ask' || section.intranetFetch === 'always' || section.intranetFetch === 'never') {
    result.intranetFetch = section.intranetFetch;
  }
  return result;
}

/* 发布 Tabbit 服务前读取一次旧值。全新 profile 没有旧配置，直接使用 schema 的默认值。 */
export function loadLegacySettings(ctx: Context): LegacySettings | undefined {
  const profile = ctx.get('profileContext' as never) as ProfileLocation | undefined;
  if (profile === undefined) return;
  const marker = join(profile.dir, MIGRATION_MARKER);
  try {
    readFileSync(marker);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const section = readLegacySection(profile.home);
  if (section !== undefined) return { marker, values: validLegacyValues(section) };
}

function settingsEntry(ctx: Context): SettingsEntry | undefined {
  return (ctx.fiber as { entry?: SettingsEntry } | undefined)?.entry;
}

function isConfigExpression(config: unknown): config is { __jsExpr: string } {
  return config !== null && typeof config === 'object' &&
    typeof (config as { __jsExpr?: unknown }).__jsExpr === 'string';
}

/* 通常可从插件行直接辨别显式字段。整段 !!js 则沿用 Loader 自身的求值规则。 */
export function legacyDefaults(
  ctx: Context, values: Partial<TabbitSettings>, live?: TabbitSettings,
): Partial<TabbitSettings> {
  const entry = settingsEntry(ctx);
  const raw = entry?.options?.config;
  if (!isConfigExpression(raw) || entry === undefined) return missingSettings(values, raw);
  const cached = evaluatedConfigs.get(entry);
  if (cached?.raw === raw) return missingSettings(values, cached.resolved);
  try {
    const resolved = entry.evaluate?.(raw.__jsExpr);
    if (resolved && typeof resolved === 'object') {
      evaluatedConfigs.set(entry, { raw, resolved });
      return missingSettings(values, resolved);
    }
  } catch {
    // 求值上下文不可用时，保留旧设置中更严格的权限。
  }
  const restrictions: Partial<TabbitSettings> = {};
  for (const key of ['pageAccess', 'intranetFetch'] as const) {
    if (values[key] === 'never' || (values[key] === 'ask' && live?.[key] === 'always')) restrictions[key] = values[key];
  }
  return restrictions;
}

function missingSettings(values: Partial<TabbitSettings>, existing: unknown): Partial<TabbitSettings> {
  return Object.fromEntries(SETTING_KEYS.flatMap((key) =>
    values[key] !== undefined &&
      !(existing && typeof existing === 'object' && Object.hasOwn(existing, key)) ? [[key, values[key]]] : [],
  ));
}

/* 新配置优先；成功后写 profile 级标记，避免用户重置字段时被旧值再次覆盖。 */
export async function migrateLegacySettings(ctx: Context, pending = loadLegacySettings(ctx)): Promise<boolean> {
  if (pending === undefined) return true;
  // 新版 Cordis 把根上下文放在公共 symbol 上；旧版才从 root 属性读取。
  const context = ctx as unknown as { [CORDIS_ROOT]?: LoaderRoot; root?: LoaderRoot };
  const loader = (context[CORDIS_ROOT] ?? context.root)?.loader;
  if (loader === undefined) return false;
  await loader.await();
  // 表单更新无法安全改写整段 !!js。继续在运行时补齐，等配置可按字段更新再落盘。
  if (isConfigExpression(settingsEntry(ctx)?.options?.config)) return false;
  const settings = ctx.settings as unknown as SettingsView;
  const descriptor = settings.describe().find((entry) => entry.ns === 'tabbit-browser');
  if (descriptor === undefined) throw new Error('tabbit-browser settings form is not active');
  const patch = missingSettings(legacyDefaults(ctx, pending.values), descriptor.user);
  if (Object.keys(patch).length > 0) await settings.update('tabbit-browser', patch, descriptor.revision);
  await writeFile(pending.marker, 'migrated\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return true;
}
