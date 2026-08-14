# Runtime receipts and recovery

Read this reference when an evaluation is queued, running, interrupted, timed
out, quarantined, or returns a resource handle.

## Receipt states

Every evaluation is serialized and identified by `requestId`.

- `succeeded`: use `result.value` or its resource handle.
- `failed`: inspect the error and correct the code only when no uncertain
  mutation remains.
- `queued` or `running`: the operation is still live. Run `tabbit-playwright
  receipt --task '<name>' --request '<request-id>'`; do not submit the operation
  again.
- `interrupted` with `mutationState: "possible"`: the action may already have
  happened. Do not retry it under any request ID.

The CLI wait window controls how long the call waits for a receipt. Its expiry
is not an operation failure.

## Interrupted mutation procedure

1. Read the named task's receipt with the same request ID.
2. If still queued or running, continue polling the same receipt.
3. Run `tabbit-playwright checkpoint --task '<name>'` after it settles. Check
   `url`, `pageCount`,
   `targetEpoch`, `documentGeneration`, and `mainFrameAttached`.
4. Inspect the application state with a new read-only evaluation.
5. Continue from observed state. Retry only when evidence proves the original
   mutation did not occur.

Never clear uncertainty by switching browser automation backends. Within the
same Runtime Service generation, do not create a new task merely to evade a
quarantined or interrupted task.

## Runtime generation loss

`SERVICE_LOST`, `GENERATION_MISMATCH`, `BROWSER_RUNTIME_UNAVAILABLE`, or an
unknown task after a service reconnect means the Browser Runtime Service may
have restarted. A new generation never restores the old evaluator, pages, or
executable task state. Persisted receipts and resources are diagnostic records;
they do not make the old task executable again.

For an interrupted mutation:

1. Preserve any receipt already returned by the old generation.
2. Do not resubmit the mutation under either the old or a new request ID.
3. After the new generation is ready, create a task only for read-only
   inspection of externally visible application state.
4. Retry the mutation only when that inspection proves it did not occur.

Do not start, stop, or restart the Runtime Service. Browser owns its process and
restart policy.

## Idempotent request IDs

Choose IDs that state intent and order:

```text
open-dashboard-01
filter-breached-02
submit-escalation-03
verify-escalation-04
```

Calling `evaluate` again with `submit-escalation-03` retrieves the existing
operation; it does not run new code. Never assign that ID to changed code.

## Large resources

Prefer returning a small aggregate. When the result is a resource handle:

1. Run `tabbit-playwright resource --task '<name>' --resource '<id>' --offset 0`.
2. Append the returned slice.
3. Continue with exactly the returned `nextOffset`.
4. Stop when `eof` is true.

Do not request a slice length; the server fixes each slice at at most 8192
bytes. Avoid echoing the full resource into the final response when a compact
answer is sufficient.

## Cleanup

Run `tabbit-playwright finish --task '<name>'` exactly once after verification
or when abandoning a failed task. A successful result is:

```json
{"taskId":"task-...","finished":true,"keep":false}
```

If `finish` fails because the Runtime Service generation disappeared, Browser
has already revoked that generation and closes its Browser sessions. Report
that task-level cleanup could not be confirmed; do not start a controller or a
fallback browser.
