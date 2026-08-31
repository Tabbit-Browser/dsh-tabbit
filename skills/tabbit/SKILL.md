---
# This frontmatter is the live source for the skill's catalog entry: the
# dsh-tabbit skill provider (src/core/index.ts) parses `description` and
# `whenToUse` from here, so editing them takes effect. `name` is documentation
# only — the runtime skill name is the SKILL_NAME constant in that file.
name: tabbit
description: Operate the user's Tabbit Browser through the tabbit_browser tool — recipes for navigation, extraction, waiting, downloads, screenshots, claimed tabs, and error recovery. Load this before non-trivial browser work.
whenToUse: Before writing any tabbit_browser call beyond a one-line lookup, and whenever a call fails, times out, or comes back with taskWasReset or truncated.
---

# Tabbit Browser operation

The `tabbit_browser` tool runs JavaScript (an async function body) inside a task attached to the user's real Tabbit Browser profile — with the user's logged-in sessions. The API surface is genuine Playwright 1.62 (`playwright-core` + Playwright Test `expect`, no test runner).

## Before the first call

Call `tabbit_browser_install` once before the first `tabbit_browser` call in a session. A `ready` result is cached for the rest of the session — don't call it again for later tasks in the same conversation. Only pass `refresh: true` after a `tabbit_browser` call fails with `LAUNCHER_MISSING` or `BROWSER_RUNTIME_UNAVAILABLE`, or after the user installs/updates/restarts Tabbit Browser mid-session.

- `ready`: proceed with `tabbit_browser`.
- `restart-required`: a supported Tabbit Browser is installed but its Runtime Service isn't reachable. Ask the user to relaunch Tabbit Browser once, then call again with `refresh: true`.
- `background`: Tabbit is missing or outdated; a region-appropriate installer download started as a background job. Report that to the user and wait for the completion notice — don't poll or start a second download.

## Execution model

- Injected globals: `browser`, `context`, `page` (currently selected), `pages()`, `usePage(p)`, `assert` (node strict), `expect`, `artifactPath(name)`.
- `globalThis` persists across calls in the same task — store state there (`globalThis.items = ...`) instead of re-scraping.
- `console.*` output is **discarded**. The return value is the only channel; return JSON-serializable data.
- Keep return values small and selective (ids, texts, short lists). Very large values get truncated.
- Timeouts (enforced by the browser's Runtime Service, so treat them as close-to-current rather than exact): 120s per call, 8s per Playwright action, 30s per navigation. Do long jobs in multiple calls.
- Tabs you open appear in the user's browser inside a tab group named after the task. They do not steal focus. They are closed when the task finishes.
- On your **first** `tabbit_browser` call in a session (while omitting `task`), pass `label` with a short description of what you're doing (e.g. `"GitHub trending research"`) — it becomes that tab group's visible name. Later calls in the same session reuse the name already set; a new `label` on those calls is ignored, so only the first one matters.
- One task maps to one tab group. Name it after the task, not the website, and keep every page of the same user request inside it even when the flow spans multiple sites. Only use an explicit `task` to open a second task for genuinely unrelated parallel work.
- When you're done with a task, pass `finish: true` so it stops sitting open indefinitely — don't leave the user's browser looking like you're still working after you've answered. Judge by the task's nature: finish a one-off lookup or a completed multi-step job; leave it running (omit `finish`) mid-task, or when the user's next message could plausibly continue in the same browser context (e.g. "check my cart" → they may follow up with "now check out"). Add `keep_tabs: true` when finishing if the task claimed tabs the user already had open (`claim_tabs`), or if what's on screen is still useful to them — otherwise the tabs close with the task.

## Recipes

Navigate and extract:

```js
await page.goto('https://example.com/pricing', { waitUntil: 'domcontentloaded' });
await page.locator('table').first().waitFor({ timeout: 8000 });
const rows = await page.locator('table tr').allInnerTexts();
return { url: page.url(), title: await page.title(), rows: rows.slice(0, 50) };
```

When a search, filter, detail, or report URL can be reliably derived from the
task (e.g. Google results with `q=`), open that parameterized URL directly
instead of opening the homepage and typing the same criteria in. URL-encode all
user-supplied input. If the parameter format is uncertain or the direct URL
cannot be verified on the visible page, fall back to the site's visible
navigation and search UI; do not loop guessing URL variants.

Open an extra page and switch to it:

```js
const p = await context.newPage();
usePage(p);
await p.goto('https://example.com');
return { pages: pages().map((x) => x.url()) };
```

Screenshots that reach your own context as images — save under `artifactPath` and return the paths in a top-level `screenshots` array:

```js
await page.screenshot({ path: artifactPath('checkout.png') });
return { screenshots: [artifactPath('checkout.png')], note: 'cart before submitting' };
```

Downloads (files under `artifactPath` are deleted when the task ends — read or move them promptly):

```js
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.getByRole('link', { name: 'Export CSV' }).click(),
]);
const saved = artifactPath(download.suggestedFilename());
await download.saveAs(saved);
return { saved };
```

Uploads: `await page.locator('input[type=file]').setInputFiles('/absolute/path')`, or `page.waitForEvent('filechooser')` for custom pickers.

Waiting: prefer `locator.waitFor()` / `expect(locator).toBeVisible()` over sleeps. SPA content often needs one explicit wait after `goto`.

For DOM-heavy research, lists, tables, pagination, or infinite scroll, read [`references/information-extraction.md`](references/information-extraction.md) before writing the extraction call. For popups, JS dialogs, iframes, download/upload event waiters, canvas surfaces, ARIA snapshots, or repeating an action safely, read the matching section of [`references/playwright-recipes.md`](references/playwright-recipes.md).

## The user's own tabs

`tabbit_browser` with `list_tabs: true` (no `code`) lists every tab of the
running browser — all windows, including tabs the user opened themselves.
Each entry is metadata only: `tabId`, `windowId`, `index`, `title`, `url`,
`active`, `state`, optional `group`. The listing has zero side effects and
never launches the browser.

- Use it when the user refers to something they have open ("the docs tab I'm
  looking at", "my cart") to find the exact tab instead of re-navigating.
- `tabCount` is always the full total; at most 100 entries are returned
  (`listTruncated: true` when clipped). On a large browser, pass `tabs_filter`
  (substring against title/url) to find the tab instead of re-listing.
- To work **on** such a tab, claim it: pass its `tabId` via `claim_tabs` when
  the task is first created (claiming is rejected on task reuse — use a fresh
  `task` name if your session task already exists). Only `state: "available"`
  tabs can be claimed; `busy` means another automation task owns it.
- Claiming visibly moves the tab into your task's group — do it only when the
  user's request actually involves that tab, and finish with
  `keep_tabs: true` so their tab survives task cleanup.
- To merely **read** such a page without touching it, prefer opening its URL
  in your own task (`page.goto(url)`) — same logged-in state, user's tab
  untouched.

## Runtime helpers

Newer Tabbit builds expose a frozen `tabbit` global in the evaluation realm with bounded-observation and safer-interaction helpers on top of native Playwright: `tabbit.observe()` (bounded page/frame/focus/ARIA state), `tabbit.focusInfo()` (call before keyboard or bulk input), `tabbit.hitTest()` (call before coordinate actions), `tabbit.actionability()` (targets inside frames or under overlays), `tabbit.pasteText()` (multiline/tabular input without touching the OS clipboard), and `tabbit.triggerAndWait()` / `tabbit.triggerAndObserve()` (arm waiters or observation before a trigger). Read [`references/interaction-helpers.md`](references/interaction-helpers.md) before visual, frame-heavy, or rich-editor work. The global may be absent on older browsers — feature-check `typeof tabbit !== "undefined"` once per task before relying on it.

## Errors and recovery

- **"task was reset"** in a result: the browser or its runtime restarted. All pages and `globalThis` state are gone — re-navigate from scratch.
- **Quarantined task**: a mutating call was interrupted; the tool checkpoints and retries once automatically. After any timeout, do not assume the action failed — verify page state before re-clicking anything side-effectful (payments, posts, sends).
- **Task limit reached**: the browser allows 8 concurrent tasks machine-wide, shared with every other host automating this Tabbit Browser. Reuse your session task; the user can inspect what's running with the `/tabbit-info` command.

Read [`references/runtime-recovery.md`](references/runtime-recovery.md) for the full interrupted-mutation procedure, large-result handling, and an `errorCode` reference table. Never resolve uncertainty by switching to another browser automation backend.

## Plugin updates

The skill may load with a plugin-update notice at the top. When it does, show
the offered version and its changes to the user and ask whether to update now.
If they agree, tell them to rerun the command below over the current install,
then restart the DSH session afterwards:

```bash
dsh plugin --profile web add dsh-tabbit
```

If they decline, call `tabbit_plugin_update` with `dismiss` set to the offered
version, then continue the task. When the skill loads without a notice, do not
call `tabbit_plugin_update`: the plugin already checks for updates at most once
a day and silently skips offline failures.

## Ground rules

- You are sharing the user's logged-in sessions. Never log out, change credentials, or take destructive or irreversible account actions unless the user explicitly asked for exactly that.
- Page access is permission-gated; the user may be asked to approve browser access once per session.
- Do not visit pages of obviously sensitive services (banking, password vaults, medical portals) unless the user's request explicitly requires it.
