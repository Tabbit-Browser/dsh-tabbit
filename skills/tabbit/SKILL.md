---
name: tabbit
description: Control Tabbit Browser in a task-isolated Playwright workspace; never switch browser backends.
---

# Tabbit

## Choose invocation

- Set `<launcher>` to macOS/POSIX `"$HOME/.local/bin/tabbit-cli"` or Windows
  PowerShell `& "$env:LOCALAPPDATA\Tabbit\LocalAgent\bin\tabbit-cli.exe"`. Do
  not assume `tabbit-cli` is on `PATH`.
- If the command tool returns a reusable process handle and supports later
  stdin writes through pipe-backed stdin (non-PTY on Windows), run `<launcher>
  persistent` once. This is preferred.
- Otherwise use `<launcher> nodejs --task NAME` immediately. Reuse the exact
  name for every command. Do not try persistent first. Read [platform
  invocation](references/platform-invocation.md) for CMD and code input.

## Persistent workspace

Send newline frame; wait for its response. Never detach or background the
process.
Commands renew a five-minute lease; expiry keeps tabs/group and stops animation.

Send `bootstrap` first with a concise display `taskName`. In `code`, navigate,
act, verify with Playwright `expect`, then return proof:

```json
{"op":"bootstrap","taskName":"Save-profile","requestId":"save-01","code":"await page.goto('https://example.test/profile',{waitUntil:'domcontentloaded'}); await page.getByRole('button',{name:'Save'}).click(); await expect(page.getByText('Saved')).toBeVisible(); return {verified: true};"}
```

If bootstrap returns `queued`, wait with
`{"op":"inspect","requestId":"save-01","waitMs":60000}`; never resubmit.

Split only when the returned state changes the next decision. Later `run`
frames name a path-safe `requestId`:
`{"op":"run","requestId":"save-02","code":"return await page.title();"}`
Send `{"op":"tabs"}` before bootstrap to take over an existing tab; include its
exact `tabId` in `claimTabIds`.
Inventory creates no task, Page, tab, or group. Later frames omit task identity.

The workspace owns only `context.pages()`/`pages()` and places every owned tab
in its one group. Prefer semantic locators, bounded loops,
same-program verification. Use `status` and `result.value`.

Before the final response, finish exactly once: send `{"op":"finish"}` in
persistent mode or run `<launcher> finish --task NAME` otherwise.
Plain finish retains tabs and the resumable group. Use
`{"op":"finish","keep":false}` only for explicit discard or necessary cleanup.
It closes only session-created tabs, never claimed or resumed tabs.

## Load details only when needed

Do not preload these references:

- Read [platform invocation](references/platform-invocation.md) for
  product/instance routing or launcher failures.
- Read [interaction helpers](references/interaction-helpers.md) for
  claim/resume, evidence, focus, paste, or blockers.
- Read [Playwright recipes](references/playwright-recipes.md) for popups,
  frames, uploads, downloads, canvas, or repetition.
- Read [information extraction](references/information-extraction.md) for results.
- Read [runtime recovery](references/runtime-recovery.md) after a failed,
  interrupted receipt or transport/finish failure.
  Never blindly retry a possible mutation.
