# Playwright recipes

Use these code bodies as the `code` field of a bound `bootstrap` or `run`
request. Each is an async function body: use it directly without adding an
async wrapper. For name-addressed compatibility, send the same body to
`<launcher> nodejs --task NAME` through a POSIX heredoc on macOS/Linux or the
Windows code-input procedure in [platform invocation](platform-invocation.md).

Each frame gets a fresh async wrapper, so lexical variables do not survive.
Re-resolve Pages with `context.pages()`/`pages()`, or put intentional
cross-frame state on `globalThis`.

## Contents

- Navigate and inspect
- Inspect visible controls and visual targets
- Work with canvas-backed rich editors
- Fill and submit a form
- Extract and aggregate data
- Handle a popup or a possible popup
- Handle same-tab or new-tab navigation
- Handle JavaScript dialogs
- Work with iframes
- Download and upload files
- Repeat actions safely
- Capture evidence
- Correct common API mistakes

## Navigate and inspect

Wait for page content that establishes readiness rather than sleeping for a
fixed duration.

```js
await page.goto("https://example.com", {waitUntil: "domcontentloaded"});
const heading = page.getByRole("heading").first();
await heading.waitFor({state: "visible", timeout: 15000});
return {
  url: page.url(),
  title: await page.title(),
  heading: (await heading.innerText()).trim(),
};
```

Use `mutation: "possible"` because navigation changes browser state.
Prefer `domcontentloaded`, or `commit` followed by an explicit readiness check.
Reserve full `load` for tasks that depend on every page resource.

## Inspect visible controls and visual targets

Use native Playwright. Prefer semantic locators when the target is known. For a
broad view, request an AI-mode ARIA snapshot and bound what you return:

```js
const snapshot = await page.ariaSnapshot({mode: "ai", depth: 20, boxes: true});
return snapshot.slice(0, 6000);
```

Use a fresh snapshot ref with `page.locator("aria-ref=e12")`. For iframe refs,
Playwright accepts the returned `f1e2` form. Use a new snapshot after navigation
or a substantial render. For canvas or coordinate-only surfaces, use native
`page.mouse` operations; the evaluation receipt automatically records compact
cross-frame and open-shadow-root hit diagnostics for mouse clicks.

## Work with canvas-backed rich editors

Canvas-backed editors often keep usable toolbar buttons and editor state in the
accessibility tree even when their visible DOM is flat or misleading. Inspect
that tree before using coordinates:

```js
const before = await page.ariaSnapshot({mode: "ai", depth: 20, boxes: true});
return before.slice(0, 6000);
```

Use a ref from that snapshot directly. ARIA refs may include a frame prefix such
as `f1e2`; native Playwright resolves either form:

```js
await page.locator("aria-ref=e12").click();
return (await page.ariaSnapshot({mode: "ai", depth: 20})).slice(0, 6000);
```

Take a new snapshot after each editor mode change because the next ARIA snapshot
replaces the old ref set. Check state flags such as `[pressed]`, `[expanded]`,
`[checked]`, and `[active]`. After inserting a table, verify that the active
textbox for following content is outside the `table` subtree before typing. Use
a screenshot only when the ARIA tree and visible surface still disagree.

## Fill and submit a form

Prefer labels and roles. Verify the resulting application state.

```js
await page.getByLabel("Email").fill("user@example.com");
await page.getByLabel("Password").fill("correct horse battery staple");

await Promise.all([
  page.waitForURL(/dashboard/, {timeout: 15000}),
  page.getByRole("button", {name: /sign in/i}).click(),
]);

const heading = page.getByRole("heading", {name: /dashboard/i});
await heading.waitFor({state: "visible"});
return {url: page.url(), signedIn: true};
```

If submission does not necessarily navigate, remove `waitForURL` and wait for a
success message or changed application element instead.

## Extract and aggregate data

Use locators for ordinary lists and tables. Aggregate inside the runtime rather
than returning an entire DOM snapshot.

```js
const rows = page.getByRole("table").getByRole("row");
const count = await rows.count();
const records = [];

for (let index = 1; index < count; index += 1) {
  const cells = rows.nth(index).getByRole("cell");
  records.push({
    name: (await cells.nth(0).innerText()).trim(),
    status: (await cells.nth(1).innerText()).trim(),
  });
}

const activeNames = records
  .filter((record) => record.status === "Active")
  .map((record) => record.name);
return {rowCount: records.length, activeNames};
```

For a large DOM-only computation, use one `page.evaluate()` and return an
aggregate. Pass data through the argument channel instead of relying on Node
closures:

```js
const minimum = 100;
return await page.evaluate(({minimum}) => {
  const values = [...document.querySelectorAll("[data-price]")]
    .map((element) => Number(element.getAttribute("data-price")));
  return {
    count: values.length,
    aboveMinimum: values.filter((value) => value >= minimum).length,
  };
}, {minimum});
```

## Handle a popup or a possible popup

When a popup is expected, install the waiter before clicking:

```js
const opener = page.getByRole("link", {name: /details/i});
const [popup] = await Promise.all([
  context.waitForEvent("page", {timeout: 15000}),
  opener.click(),
]);
await popup.waitForLoadState("domcontentloaded");
usePage(popup);

const result = {title: await page.title(), url: page.url()};
await page.close();
usePage(pages().find((candidate) => !candidate.isClosed()));
return result;
```

When a popup is only one possible outcome, start a bounded waiter and inspect
both outcomes. Retain the original page explicitly:

```js
const original = page;
const beforeUrl = original.url();
const popupPromise = context
  .waitForEvent("page", {timeout: 8000})
  .catch(() => null);

await original.getByRole("link", {name: /open report/i}).click();
const popup = await popupPromise;

if (popup) {
  await popup.waitForLoadState("domcontentloaded");
  const evidence = {kind: "popup", title: await popup.title(), url: popup.url()};
  await popup.close();
  usePage(original);
  return evidence;
}

await original.waitForLoadState("domcontentloaded").catch(() => {});
return {
  kind: original.url() === beforeUrl ? "in-page" : "same-tab",
  title: await original.title(),
  url: original.url(),
};
```

Do not click first and install `waitForEvent("page")` afterward; the event may
already have fired.

## Handle same-tab or new-tab navigation

Use native Playwright and install the waiter before the action:

```js
await Promise.all([
  page.waitForURL(/\/orders\/\d+$/),
  page.getByRole("button", {name: /create order/i}).click(),
]);
return {title: await page.title(), url: page.url()};
```

For a popup, pair `context.waitForEvent("page")` with the click. Receipts report
new pages but do not replace the active `page`. Do not replace the requested
click with `page.goto(linkHref)`; that can skip application behavior. Close
obsolete task-created pages with native `popup.close()`.

## Handle JavaScript dialogs

Attach the handler before the triggering action. Dialog callbacks must not be
left pending because they block page JavaScript.

```js
let message = null;
page.once("dialog", async (dialog) => {
  message = dialog.message();
  await dialog.accept();
});
await page.getByRole("button", {name: /delete/i}).click();
await page.getByText(/deleted/i).waitFor({state: "visible"});
return {accepted: true, message};
```

Use `dialog.dismiss()` when cancellation is the requested behavior.

## Work with iframes

Use `frameLocator()` instead of trying to query iframe contents from the parent
document.

```js
const payment = page.frameLocator('iframe[title="Payment"]');
await payment.getByLabel("Card number").fill("4242 4242 4242 4242");
await payment.getByRole("button", {name: /pay/i}).click();
await page.getByText(/payment complete/i).waitFor({state: "visible"});
return {paid: true};
```

## Download and upload files

Install the download waiter before clicking and save into the task artifact
directory:

```js
const [download] = await Promise.all([
  page.waitForEvent("download", {timeout: 15000}),
  page.getByRole("button", {name: /export/i}).click(),
]);
const output = artifactPath("export.csv");
await download.saveAs(output);
return {
  artifact: output,
  suggestedFilename: download.suggestedFilename(),
  failure: await download.failure(),
};
```

Chromium's built-in PDF viewer may open a page without emitting a download.
Fetch the rendered link through the BrowserContext request client, validate the
signature, and save it as an artifact:

```js
const link = page.getByRole("link", {name: /view pdf/i});
const pdfUrl = new URL(await link.getAttribute("href"), page.url()).href;
const response = await context.request.get(pdfUrl);
assert(response.ok(), `PDF request failed: ${response.status()}`);
const body = await response.body();
assert.equal(body.subarray(0, 5).toString(), "%PDF-");
const output = artifactPath("paper.pdf");
await (await import("node:fs/promises")).writeFile(output, body);
return {artifact: output, bytes: body.length, url: pdfUrl};
```

For a normal file input, use `setInputFiles()`:

```js
await page.getByLabel("Upload document").setInputFiles("/absolute/input.pdf");
await page.getByText(/upload complete/i).waitFor({state: "visible"});
return {uploaded: true};
```

For a file chooser opened by a button:

```js
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.getByRole("button", {name: /choose file/i}).click(),
]);
await chooser.setFiles("/absolute/input.pdf");
await page.getByText(/upload complete/i).waitFor({state: "visible"});
return {uploaded: true};
```

## Repeat actions safely

Re-resolve locators each iteration because frameworks may replace DOM nodes.
Verify progress and bound every loop.

```js
const clicked = [];
for (let index = 0; index < 5; index += 1) {
  const items = page.getByRole("list", {name: /news/i}).getByRole("link");
  assert.ok(await items.count() > index, `missing news item ${index + 1}`);
  const item = items.nth(index);
  const title = (await item.innerText()).trim();

  const original = page;
  const [popup] = await Promise.all([
    context.waitForEvent("page", {timeout: 10000}),
    item.click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  clicked.push({title, landingTitle: await popup.title(), url: popup.url()});
  await popup.close();
  usePage(original);
}
return {count: clicked.length, clicked};
```

If the page can reorder after each click, locate by captured title rather than
by index. Never use an unbounded loop waiting for a page condition.

## Capture evidence

Use a plain filename with `artifactPath()`:

```js
const output = artifactPath("final-state.png");
const screenshot = await page.screenshot({path: output, fullPage: true});
return {screenshot, title: await page.title(), url: page.url()};
```

Take screenshots as evidence or when visual state matters, not as the default
way to discover ordinary DOM controls.

## Correct common API mistakes

| Incorrect | Correct |
| --- | --- |
| `browser.pages()` | `context.pages()` or `pages()` |
| `document.querySelector(...)` in the Node body | `page.evaluate(() => document.querySelector(...))` |
| `expect(locator).toHaveValue(...)` | `await expect(locator).toHaveValue(...)` with the official Playwright Test `expect` |
| `page.waitForTimeout(3000)` after every action | wait for a locator, URL, event, response, or load state |
| click, then `waitForEvent("page")` | install the event waiter before the click with `Promise.all` |
| return a Locator/Page/JSHandle | return a small JSON-safe object |
| `page.goto(href)` when asked to click | call `locator.click()` and verify its result |
| create a new browser for the next step | reuse the same task and persistent `page`/`context` |
