# Interaction helpers

Newer Tabbit Browser builds expose a frozen `tabbit` global inside the
persistent Node realm that `tabbit_browser` code runs in. Its helpers add
bounded observation and safer interaction on top of native Playwright APIs —
they do not replace them. On older browsers the global may be absent; feature-
check once per task before relying on it:

```js
return {hasHelpers: typeof tabbit !== "undefined"};
```

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
Call it before keyboard or bulk input.

`tabbit.hitTest(locator)` reports the element at the locator's center across
frames. `tabbit.hitTest({x, y})` checks a main-frame viewport point. Call it
before coordinate input and treat mismatches as a reason to re-observe.

## `tabbit.actionability(locator)`

Verifies the target inside its owner frame and every iframe host up to the
main page. It reports target visibility, event reception, viewport
intersection, frame identity, and blockers such as an `occludedBy` element.
For targets inside frames or beneath overlays, check actionability first and
only then perform the normal Playwright `locator.click()`; when the report
says the target or a frame host is non-actionable, re-observe instead of
clicking anyway.

## `tabbit.pasteText(text, options)`

Dispatches a task-local synthetic paste, then uses an editable fallback when
needed. It never reads or overwrites the user's OS clipboard and reports
`trusted: false`. Options are `format: "text" | "tsv"` and
`requireEditableFocus: true | false`. The receipt reports byte/character
counts, strategy, and focus before/after, but never echoes the payload. Prefer
it over per-character typing for multiline or tabular content.

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
`download`, `dialog`, `navigation`, and `url` (`options.url` required for
`url`).

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
observed result after a short settle window. Options are `timeoutMs`,
`settleMs`, `pollMs`, and `activatePage`. With `activatePage: true`, a newly
opened page becomes the task's active `page`.

```js
const result = await tabbit.triggerAndObserve(
  () => page.getByRole("button", {name: "Continue"}).click(),
  {timeoutMs: 3000, activatePage: true},
);
return {kind: result.kind, url: page.url()};
```
