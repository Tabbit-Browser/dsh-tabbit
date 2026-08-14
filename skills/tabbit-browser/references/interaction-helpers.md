# Interaction helpers

These additive helpers live in the persistent Node evaluation realm as the
frozen `tabbit` global. They do not replace native Playwright APIs.

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

## `tabbit.actionability(locator)` and `tabbit.safeClick(locator, options)`

`tabbit.actionability()` verifies the target inside its owner frame and every
iframe host up to the main page. It reports target visibility, event reception,
viewport intersection, frame identity, and blockers such as an `occludedBy`
element. `tabbit.safeClick()` runs that check immediately before a normal
Playwright locator click and throws without clicking when the target or any
frame host is non-actionable.

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
  () => tabbit.safeClick(target),
  {timeoutMs: 3000, activatePage: true},
);
return {kind: result.kind, url: page.url()};
```

## CLI conveniences

Use the launcher documented by `platform-invocation.md`:

- `inspect --task NAME [--frames visible] [--focus] [--depth N] [--max-chars N]`
- `paste --task NAME [--format text|tsv] [--require-editable-focus]`
- `nodejs --diagnostics focus` wraps a body with before/after focus diagnostics.
- `nodejs --compact` shortens metadata only when a named task is reused.
- `resource --max-bytes N` reads up to 65536 bytes per bounded page.

All commands use the existing task runtime and receipt lane. Existing commands
and default output remain unchanged when these flags are absent.
