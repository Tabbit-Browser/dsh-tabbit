# Information extraction

Use this reference for DOM-heavy research, lists, tables, pagination, infinite
scroll, virtualized content, or any task likely to return more than a small
answer.

## Contents

- Realm boundary
- Select the extraction surface
- Extract and aggregate once
- Bound and deduplicate results
- Paginate and scroll safely
- Verify and return compact output

## Realm boundary

The `tabbit_browser` tool's `code` argument runs in a persistent **Node
realm**. It owns Playwright objects, task globals, filesystem access, and the
final returned value. The website runs in the **page realm**. It owns
`document`, `window`, DOM nodes, and application JavaScript.

Use Locators from the Node realm for normal semantic content. Use
`page.evaluate(fn, argument)` when a DOM-only computation is materially more
compact. Pass all inputs through the argument channel: a function passed to
`page.evaluate()` does not capture Node variables.

```js
const minimum = 100;
return await page.evaluate(({minimum}) => {
  const prices = [...document.querySelectorAll("[data-price]")]
    .map((element) => Number(element.getAttribute("data-price")))
    .filter(Number.isFinite);
  return {
    count: prices.length,
    aboveMinimum: prices.filter((price) => price >= minimum).length,
  };
}, {minimum});
```

Do not return DOM nodes from the page realm or `Page`, `Locator`, `Frame`, and
`JSHandle` objects from the Node realm. Return JSON-safe values.

## Select the extraction surface

- Use roles, labels, text, and scoped Locators for ordinary lists and tables.
- Use one `page.evaluate()` for custom DOM traversal or aggregation that would
  otherwise require many protocol round trips.
- Use screenshots plus real input for canvas or virtualized editors; their DOM
  may describe toolbars or hidden inputs instead of visible content.
- Prefer an application's visible UI and user-authorized state. Do not bypass
  Browser policy or switch to another network/browser backend.

## Extract and aggregate once

Do the query, normalization, filtering, and mapping in one coherent call. Keep
the returned schema explicit and small.

```js
const maxResults = 25;
return await page.evaluate(({maxResults}) => {
  const records = [...document.querySelectorAll("article")]
    .map((article) => ({
      title: article.querySelector("h2")?.textContent?.trim() ?? "",
      url: article.querySelector("a[href]")?.href ?? "",
      summary: article.querySelector("p")?.textContent?.trim() ?? "",
    }))
    .filter((record) => record.title && record.url)
    .slice(0, maxResults);
  return {count: records.length, records};
}, {maxResults});
```

Do not retrieve `innerHTML`, the whole body text, or a full accessibility tree
when the user needs only a few fields or an aggregate.

## Bound and deduplicate results

Define `maxResults` before collecting. Deduplicate on the most stable available
key—canonical URL, application ID, or a normalized compound key—and preserve
the first complete record.

```js
const maxResults = 50;
const rows = await page.getByRole("row").allTextContents();
const unique = [...new Map(rows
  .map((text) => text.trim())
  .filter(Boolean)
  .map((text) => [text.toLocaleLowerCase(), text])).values()]
  .slice(0, maxResults);
return {count: unique.length, rows: unique};
```

Aggregate in the runtime when the answer is a count, grouping, comparison, or
small set of matches. Large raw results consume the inline result budget and
make subsequent reasoning less reliable.

## Paginate and scroll safely

Bound every loop by iteration count, result count, and a concrete stop signal.
Re-resolve Locators after each render, record progress, and stop if an iteration
adds nothing.

```js
const maxPages = 10;
const maxResults = 100;
const records = new Map();

for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
  const cards = page.locator("article[data-id]");
  const count = await cards.count();
  const before = records.size;
  for (let index = 0; index < count && records.size < maxResults; index += 1) {
    const card = cards.nth(index);
    const id = await card.getAttribute("data-id");
    if (!id || records.has(id)) continue;
    records.set(id, {id, text: (await card.innerText()).trim()});
  }
  if (records.size >= maxResults || records.size === before) break;

  const next = page.getByRole("button", {name: /next/i});
  if (!await next.isVisible().catch(() => false) || await next.isDisabled()) break;
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    next.click(),
  ]);
}

return {count: records.size, records: [...records.values()]};
```

For infinite scroll, compare stable item IDs or counts before and after each
bounded scroll. Do not use an unbounded loop or assume that scrolling implies
new content loaded.

## Verify and return compact output

Before returning, verify that the extracted records match the requested scope:
check the URL, page heading, result count, representative first/last records,
or an application-provided total. Report truncation explicitly.

Return a compact object such as:

```js
return {
  source: {url: page.url(), title: await page.title()},
  count: records.length,
  truncated: records.length === maxResults,
  records,
};
```

If the raw return value still exceeds the inline limit, the tool result comes
back with `truncated: true` (and a smaller `resultText` prefix) instead of the
full value — see `runtime-recovery.md`. Narrow what you return (filter,
aggregate, cap length) rather than retrying the same call unchanged.
