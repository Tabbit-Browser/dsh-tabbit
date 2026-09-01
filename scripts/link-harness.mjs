#!/usr/bin/env node
// 把仓库根目录下的 .dsh-harness（gitignored 符号链接）指向本机的
// deepseek-harness 检出——tsconfig.json 的 paths 和 package.json 的
// devDependencies link: 条目全部固定指向 ./.dsh-harness，从不因人而异，
// 每个开发者只需要在这一处配置自己的检出路径。见 README 的"开发"一节。
//
// 用法：npm run link-harness -- /path/to/deepseek-harness
//      （或设置环境变量 DSH_HARNESS_PATH）
import { existsSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const target = process.argv[2] ?? process.env.DSH_HARNESS_PATH
if (!target) {
  console.error('Usage: npm run link-harness -- /path/to/deepseek-harness\n(or set DSH_HARNESS_PATH)')
  process.exit(1)
}

const resolvedTarget = resolve(target)
if (!existsSync(resolvedTarget)) {
  console.error(`No such directory: ${resolvedTarget}`)
  process.exit(1)
}

// 用一个必然存在的构建产物粗略校验"这看起来像一份构建过的 deepseek-harness
// 检出"，而不是等 pnpm install / tsc 报出更晦涩的错误再让人猜——harness 自己
// 的 lib/ 是 gitignored 的，光 clone 不 build 是最常见的踩坑方式。
const sentinel = resolve(resolvedTarget, 'packages/core/tools/lib/index.js')
if (!existsSync(sentinel)) {
  console.error(
    `${resolvedTarget} doesn't look like a built deepseek-harness checkout ` +
      '(missing packages/core/tools/lib/index.js). Build it first: pnpm install && pnpm build in that repo.',
  )
  process.exit(1)
}

const linkPath = resolve(import.meta.dirname, '..', '.dsh-harness')
try {
  const stat = lstatSync(linkPath)
  if (!stat.isSymbolicLink()) {
    console.error(`${linkPath} already exists and isn't a symlink — remove it manually first.`)
    process.exit(1)
  }
  unlinkSync(linkPath)
} catch {
  /* 还不存在，正常，直接建 */
}

try {
  // Windows 上普通符号链接建目录需要开发者模式/管理员权限，junction 不用。
  symlinkSync(resolvedTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
} catch (error) {
  console.error(`Failed to create ${linkPath}: ${error.message}`)
  if (process.platform === 'win32') {
    console.error('On Windows, creating symlinks needs Developer Mode enabled or an elevated shell.')
  }
  process.exit(1)
}

console.log(`Linked .dsh-harness -> ${resolvedTarget}`)
