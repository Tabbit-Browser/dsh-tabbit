# Runtime receipts and recovery

Read this reference after a failed, interrupted, or quarantined receipt, a
possible mutation, a resource result, explicit diagnostics, transport close, or
finish failure. A `queued` or `running` receipt is not one of those: it is
ordinary pending work, described under receipt states below. Keep using the
same open `tabbit-cli persistent` process while its Browser connection remains
open.

## Compact and explicit results

Normal success is compact: use `result.value` and `status`.
Only bootstrap includes `task` identity. Static Browser/Playwright capabilities
are available with `{"op":"docs","topic":"capabilities"}`; binding,
controller, and Browser health are available with `{"op":"diagnose"}`. Do not
request either after ordinary successful actions.

Each evaluation has a stable `requestId`. Recovery operations are explicit:

- `{"op":"inspect","requestId":"save-01"}` returns the compact state of that
  original request. Its optional `waitMs` waits for that receipt to reach a
  terminal state without resubmitting the request, and can be repeated;
  `{"op":"inspect"}` returns current task status. In compatibility mode the
  same bounded wait is
  `tabbit-cli receipt --task NAME --request save-01 --wait-ms 60000`.
- `{"op":"receipt","requestId":"save-01"}` returns its complete canonical
  receipt.
- `{"op":"checkpoint"}` returns task/page recovery state.
- `{"op":"resource","resourceId":"...","offset":0,"maxBytes":8192}` reads
  a bounded spilled result; continue with the returned `nextOffset` until
  `eof`.

Use `receipt`, `checkpoint`, `diagnose`, `docs`, and `resource` only when their
detail changes the next decision or the user explicitly requests diagnostics.
Choose request IDs that encode intent and order, such as `submit-order-03`, and
never reuse one for changed code. A `run` frame carrying `code` must name its
`requestId`; only `bootstrap` may omit it and take the default `bootstrap`.
That default is reserved: submitting your own work under it fails with
`REQUEST_ID_RESERVED` rather than replaying the bootstrap receipt.
`timeoutMs` bounds the evaluation and must be positive and at most 120000;
`waitMs` bounds only the client-side wait for its receipt and is capped the
same way.

## Receipt states

- `succeeded`: consume inline `result.value`, or read its bounded `resourceId`
  using the operation above.
- A terminal receipt's `transition` reports URL and Page changes plus the new
  page count, target epoch, and document generation. Check it before recovery.
- `queued` or `running`: ordinary pending work, not failure.
  Bootstrap code returns this prompt receipt by default after the workspace
  is bound; its evaluation continues on the same receipt lane. Wait with
  `{"op":"inspect","requestId":"save-01","waitMs":60000}`, repeat that wait as
  long as it stays pending, and never submit the request again. Treat it as a
  fault only once it outlives its own `timeoutMs`.
- `failed`: inspect its bounded error and `mutationState`. Correct and rerun
  only when no uncertain mutation remains. A failed `bootstrap` still created
  the task and bound the connection, and its response carries `bound: true`;
  continue with a corrected `run` frame and never resend `bootstrap`, because
  a second frame naming a task is rejected as an invalid bound request.
- `interrupted`, quarantine, or `mutationState: "possible"`: the action may
  already have happened. Inspect the same request, then its canonical receipt
  and checkpoint. Check `url`, `pageCount`, `targetEpoch`,
  `documentGeneration`, and `mainFrameAttached`, then perform a new read-only
  observation of application state.
  Continue from evidence and retry only when evidence proves the original
  mutation did not occur.
- A screenshot result includes a bounded screenshot delta and `nextAction`. If
  `nextAction.type` is `load_image`, immediately load the named immutable PNG
  with the host image reader before making visual claims.

A client-side wait expiry is not operation failure. Never evade pending or
quarantined work by changing request IDs, tasks, instances, or browser backends.

## Transport close

`TRANSPORT_INTERRUPTED` is the submitted frame's terminal stdout receipt: the
Runtime connection ended before its operation receipt arrived. It does not
prove that a possible mutation did not happen.

The authenticated connection owns the workspace. If it closes, the Runtime
finalizes the task and the native client exits. Do not reconnect, replay the
request, or issue bound receipt/checkpoint operations through a replacement
connection. A fresh workspace may inspect externally visible application state
read-only; retry a mutation only if that proves the original did not occur.

If a group disappeared while the current empty binding remains healthy, list
current tab/group descriptors and make a new explicit claim/resume decision.
If a user drags an owned tab out, accept its release and continue only with the
remaining owned Pages.

## Finish

Send `{"op":"finish"}` exactly once after verification or when abandoning the
workspace. Plain finish releases ownership and retains live tabs and the group;
its returned `groupId` can later be discovered and resumed. To honor an
explicit discard request, send `{"op":"finish","keep":false}`. Discard closes
only tabs created during this session, never claimed tabs or tabs inherited by
group resume.

A repeated finish on the same open connection returns the terminal finish
result and cannot restore execution. If the connection closes before finish is
confirmed, the Runtime finalizes the task; do not start another controller or
fallback browser merely to finish.
