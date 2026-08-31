# Recovery

Read this reference when a `tabbit_browser` call fails, comes back with
`taskWasReset: true`, or comes back `truncated: true`.

## What the tool already handles for you

Unlike a CLI you'd poll by hand, `tabbit_browser` resolves interruptions
inside a single call — there is no separate receipt-polling, checkpoint, or
resource-paging step to run yourself:

- **Quarantined task** (an earlier mutating call in this task was
  interrupted mid-flight): the tool checkpoints the task and retries your
  call automatically. You'll see this recorded in the result's `notes`
  array; no action needed.
- **Task reset** (`taskWasReset: true` in the result): the task's worker was
  lost, or the browser itself restarted. Every page and `globalThis` value
  set by earlier calls in that task is gone, and your call ran in a fresh
  task. Treat it as a cold start — re-navigate, and don't assume a
  previously-opened page or a stored `globalThis` value still exists.
- **Runtime momentarily unavailable**: retried once automatically after a
  short delay.

## What you still have to do

Automatic retry is only safe when the tool itself can tell the action didn't
already happen — it can't know that for something like a payment or a sent
message. If a call fails, times out, or comes back with `taskWasReset: true`
right after a call you believe mutated something, do not immediately repeat
that action:

1. Make a fresh, narrowly-scoped call with `read_only: true` to inspect
   visible state — the URL, a confirmation element, an order id, a new item
   in a list.
2. Only repeat the mutating action if that inspection shows it did not take
   effect.

This is the same principle as the SKILL's "a resolved `click()` is not proof
of success" — verification, not the call's return status, tells you whether
an action happened.

## Large results

There's no resource handle to page through by hand. If your return value is
too big, the result comes back as `truncated: true` (with a `resultText`
prefix, not the full value). Don't retry the same call expecting more data
next time — narrow what you return: filter, aggregate, or cap array length in
the browser realm before returning (see `information-extraction.md`), or
write large output to a file with `artifactPath()` and return its path
instead of its contents.

## Task limits and cleanup

The browser allows 8 concurrent tasks machine-wide, shared with every other
host (Claude Code, Codex, …) automating this Tabbit Browser — not just this
agent. If a call fails with a busy/queue-full error, retry shortly rather than
opening another task. Run `/tabbit` if the user asks what's currently running
or occupying a task slot.

Close a task by passing `finish: true` on the last `tabbit_browser` call of a
piece of work (add `keep_tabs: true` when the task claimed tabs the user
already had open, or when what's on screen is still useful to them). Don't
leave the task open just because cleanup also happens when the agent session
ends — that fallback runs whenever the session is disposed, which from the
user's side can be much later, with your tab group sitting in their browser
looking like you're still working.

`finishError` in a result means the evaluation itself succeeded but closing
the task didn't. Most often the Runtime Service had already finalized the idle
task on its own, so there is nothing left to do: report the answer normally,
don't retry the call, and don't treat it as a failed step.

## Errors you'll see verbatim

A failed call returns `{status: 'failed', error, errorCode}`. Common
`errorCode` values:

| errorCode | Meaning | Response |
| --- | --- | --- |
| `LAUNCHER_MISSING` | Tabbit Browser integration isn't installed on this machine. | Run `tabbit_browser_install`. |
| `INSTANCE_SELECTION` | Multiple Tabbit instances are registered and the choice was ambiguous. | Run `/tabbit` to list instances, then ask the user which one, and set settings key `tabbit.instance`. |
| `BROWSER_RUNTIME_UNAVAILABLE` | Tabbit Browser may be starting. | Retry shortly. |
| `SERVICE_BUSY` / `TASK_QUEUE_FULL` | The Runtime Service is at capacity. | Retry shortly; don't open a new task to route around it. |
| `TAB_OWNERSHIP_CONFLICT` | A tab id in `claim_tabs` was invalid, repeated, already owned by another task, or no longer a real page. The browser pre-checks the whole list and rejects it as a unit, leaving no half-created task. | Only claim tab ids the user explicitly gave you for this task; fix or drop the list and call again. |
| `CLAIM_REQUIRES_NEW_TASK` | `claim_tabs` was set on a call that reused an existing task. | Claims only take effect the moment a task is first created; use a new task name. |

Never resolve any of these by switching to another browser automation
backend.
