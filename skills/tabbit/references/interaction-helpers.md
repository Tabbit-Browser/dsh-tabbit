# Interaction helpers

These additive helpers live in the persistent Node evaluation realm as the
frozen `tabbit` global. They do not replace native Playwright APIs.

Evaluation code supports top-level `await` and `return` and provides persistent
`browser`, `context`, `page`, `pages()`, `usePage()`, Node `assert`, official
Playwright Test `expect`, `artifactPath()`, `reportIssue()`, and `tabbit`.
Browser DOM globals exist only inside `page.evaluate()`; return bounded
JSON-safe values, never Page, Locator, Frame, JSHandle, or DOM objects.

## Inventory, claim, and resume

`{"op":"tabs"}` before bootstrap is metadata-only discovery across regular
tabs in the bound Profile. It creates no task, Page, tab, or group. Each bounded
descriptor includes `tabId`, `windowId`, tab-strip
`index`, `title`, `url`, `active`, relative `state`, and optional live group
metadata. `available` means unowned, `owned` means owned by this workspace, and
`busy` means another workspace owns it. Discovery never attaches, claims,
groups, focuses, navigates, or creates a Playwright Page.

Only owned tabs appear in `context.pages()` and `pages()`. Bootstrap an existing
available tab with its exact returned ID in `claimTabIds`. After bootstrap,
claim another available tab with `{"op":"claim","tabIds":[17]}` or resume
every claimable tab in one exact group with `{"op":"resume","groupId":"A1B2"}`.
Inventory is advisory:
claim/resume revalidates and can fail if another session won. Batches are
atomic; duplicate, stale, busy, unsupported, or cross-window inputs do not
partially claim. Claims never move tabs between windows. Group titles are
presentation, never identity or ownership.

When the next program is known, combine ownership and evaluation:

```json
{"op":"run","tabIds":[17,18],"requestId":"compare-01","mutation":"possible","code":"await expect(page.getByRole('main')).toBeVisible(); return {controlled:pages().length,url:page.url()};"}
```

Use `groupId` instead of `tabIds` to resume and run. A workspace has no group
while empty and one group once it owns a tab. Dragging an owned tab out is user
takeover and removes that Page; dragging an unowned tab in does not claim it.

## Screenshots

Use screenshots for canvas or DOM/visual disagreement, not routine discovery.
Before substantial input on a canvas or rich editor, make a small write probe
and verify the rendered result. `page.screenshot()` produces a receipt entry
rather than visual input. When
`outcome.screenshotsDelta` gives `nextAction.type: "load_image"`, immediately
load its path with `view_image(path)`. Without an image reader, make no visual
claim and capture no further screenshot. Capture again only after a meaningful
visual-state change. For broad accessible structure, prefer a bounded
`page.ariaSnapshot({mode: "ai", depth: 20, boxes: true})`, then act with a fresh
`page.locator("aria-ref=e2")`.

## `tabbit.observe(options)`

Returns bounded task state: page metadata, selected frame metadata, optional
deep-focus details, and truncated native ARIA snapshots for the page and each
selected frame. Frame entries include `hostBox`, `viewportIntersection`,
`visible`, `actionable`, and `occludedBy`.

```js
return await tabbit.observe({frames: "visible", focus: true, depth: 16,
  maxChars: 6000, frameMaxChars: 2000, maxFrames: 8});
```

`frames` is `"none"`, `"visible"`, or `"all"`; `depth` is 1–30, `maxChars` is
256–20000, `frameMaxChars` is 256–6000, and `maxFrames` is 1–32. This is
observation only. Do not treat a frame snapshot as permission to act when its
host is non-actionable.

## `tabbit.focusInfo()` and `tabbit.hitTest(targetOrPoint)`

`tabbit.focusInfo()` follows focus through child frames and open shadow roots,
returning role/name/type/editability, visibility, rectangle, and selection.
Call it before keyboard input.

`tabbit.hitTest(locator)` reports the element at the locator's center across
frames. `tabbit.hitTest({x, y})` checks a main-frame viewport point. Call it
before coordinate input and treat mismatches as a reason to re-observe.

## `tabbit.actionability(locator)`

`tabbit.actionability()` verifies the target inside its owner frame and every
iframe host up to the main page. It reports target visibility, event reception,
viewport intersection, frame identity, and blockers such as an `occludedBy`
element. Click with native `locator.click()` so Playwright performs its full
actionability and retry behavior.
If a click fails, preserve the Playwright error and use this helper for explicit
diagnostics; do not make the helper a precondition or force the click.

## `tabbit.pasteText(text, options)`

Dispatches a task-local synthetic paste, then uses an editable fallback when
needed. It never reads or overwrites the user's OS clipboard and reports
`trusted: false`. Options are `format: "text" | "tsv"` and
`requireEditableFocus: true | false`. The receipt reports byte/character counts,
strategy, and focus before/after, but never echoes the payload.

```js
const input = page.getByRole("textbox", {name: "Data"});
await input.click();
const paste = await tabbit.pasteText("张三\t25\t技术", {
  format: "tsv", requireEditableFocus: true,
});
await expect(input).not.toHaveValue("");
return {paste, value: await input.inputValue()};
```

Always verify application-visible state; synthetic events are not trusted user
events and a site may reject them.

## `tabbit.triggerAndWait(event, trigger, options)`

Arms the waiter before running `trigger`. Supported events are `popup`, `page`,
`download`, `dialog`, `navigation`, and `url` (`options.url` required for `url`).

```js
const popup = await tabbit.triggerAndWait(
  "popup", () => page.getByRole("link", {name: "Open"}).click(),
  {timeoutMs: 10000},
);
return {popupUrl: popup.url()};
```

## `tabbit.triggerAndObserve(trigger, options)`

Use this for ambiguous transitions. It arms page, URL, navigation, frame, and
DOM-revision observation before `trigger`, then returns the highest-priority
observed result after a short settle window. Options are `timeoutMs`, `settleMs`,
`pollMs`, and `activatePage`. With `activatePage: true`, a newly opened page
becomes the task's active `page`.

```js
const result = await tabbit.triggerAndObserve(
  () => target.click(),
  {timeoutMs: 3000, activatePage: true},
);
return {kind: result.kind, url: page.url()};
```

## Input and blocker conventions

For reactive inputs, select a visible suggestion or use the supported commit
key, blur through a neutral control, and verify persistence. Close any visible
calendar or suggestion overlay before submitting. Follow rendered first-party
links for opaque routes instead of guessing.

Report verified blockers with `reportIssue(code)`: `AUTHENTICATION_REQUIRED`,
`SITE_ACCESS_BLOCKED`, or `BROWSER_ERROR_PAGE`.
