# Platform invocation

Read this reference only when the user names an instance or product, the host
cannot keep process stdin writable, or launcher, permission, installation, or
routing fails. Use only the installed stable launcher. Never invoke a CLI from
an app bundle, use a versioned native CLI, read `endpoint.json`, or switch
backends.

## Persistent invocation

Start the launcher once per Agent conversation and keep its stdin/stdout open.
It selects and authenticates one Browser instance once, then accepts bounded
newline-delimited JSON: optionally one unbound `tabs` inventory, then
`bootstrap`; zero or more `run`, `inspect`, `tabs`, `claim`, `resume`,
`receipt`, `checkpoint`, `diagnose`, `docs`, or `resource` frames; and `finish`
last. When claiming existing Browser state, pass the selected returned ID
through bootstrap `claimTabIds`. Wait for each newline JSON response before
sending the next frame. Later frames must not contain `task`, `taskId`, `name`,
`taskName`, or `generation`.

Every submitted frame produces exactly one newline JSON receipt on stdout.
Local validation failures and Runtime transport interruption are receipts too;
stderr is reserved for process-level startup, shutdown, and usage failures.

The macOS/POSIX stable launcher is:

```bash
"$HOME/.local/bin/tabbit-cli" persistent
```

The Windows PowerShell form is:

```powershell
& "$env:LOCALAPPDATA\Tabbit\LocalAgent\bin\tabbit-cli.exe" persistent
```

The Windows CMD form is:

```bat
"%LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe" persistent
```

Use pipe-backed stdin for persistent mode on Windows. Do not allocate a console
PTY: terminal echo, line editing, or wrapping can alter an NDJSON frame. If the
host offers only a PTY, use the compatibility commands immediately. This rule
does not change the macOS/POSIX launcher or its stdin behavior.

Keep the launcher as the first command token. When the Agent command sandbox
blocks it, request reusable approval only for that stable path; do not wrap it
with `env`, a shell, or another executable. The client retains one Browser
connection for the workspace. If that connection closes, the workspace ends.

Do not start persistent mode with a detached or background command that closes
stdin. `Persistent input ended before bootstrap` means the host closed the
protocol stream; it is not Browser or instance unavailability. When the host
has no interactive process primitive, use the compatibility commands instead
of building a FIFO or wrapper. A frame the client rejects reports
`INVALID_PERSISTENT_INPUT` on stdout and leaves the connection open; correct
that frame and continue on the same process. Choose one concise task name and
reuse it exactly:

- `nodejs --task NAME`, `inspect --task NAME`, `tabs --task NAME`
- `claim --task NAME --tab ID...`, `resume --task NAME --group ID`
- `receipt --task NAME --request ID`, `checkpoint --task NAME`,
  `diagnose --task NAME`
- `resource --task NAME --resource ID`, `finish --task NAME [--discard]`

These commands reuse the same Browser-owned task and receipt lane. Plain
`finish` retains it; `--discard` closes only tabs created by that session.

On Windows, pass multiline `nodejs` code through pipe-backed stdin. If the host
cannot close that pipe, write the code to a task-scoped temporary `.js` file,
then invoke the stable launcher from CMD with `<` redirection:

```bat
"%LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe" nodejs --task NAME < "%TEMP%\tabbit-task.js"
```

Remove the temporary file after its receipt. Do not use a PowerShell pipeline,
here-string, `echo`, or a console PTY to transport code; those paths can alter
newlines, encoding, or long input.

## Product and instance selection

With no explicit instance or product request, do not inspect the registry or
set an override. The stable launcher selects once when persistent mode starts.

For an explicit request, inspect only the current user's registry with
read-only commands. Normalize only case and surrounding space for a product and
match exactly `Tabbit Browser`, `Tabbit Browser Dev`, `Tabbit`, or `Tabbit Dev`;
they are not aliases. Discard records that fail the platform checks below. Pick
the exact requested instance or one exact product match. If multiple valid
records match a product, show their instance IDs and ask the user. Automatic
liveness and newest-endpoint selection belong to the stable launcher.

Set the selected uppercase 16-hex instance ID before starting the one persistent
process. Do not invoke an unpinned launcher as a probe, change the ID during the
conversation, or repeat environment setup for operations.

POSIX shell:

```bash
export TABBIT_PLAYWRIGHT_INSTANCE='0123456789ABCDEF'
"$HOME/.local/bin/tabbit-cli" persistent
unset TABBIT_PLAYWRIGHT_INSTANCE
```

PowerShell:

```powershell
$env:TABBIT_PLAYWRIGHT_INSTANCE = '0123456789ABCDEF'
& "$env:LOCALAPPDATA\Tabbit\LocalAgent\bin\tabbit-cli.exe" persistent
Remove-Item Env:TABBIT_PLAYWRIGHT_INSTANCE
```

CMD:

```bat
set "TABBIT_PLAYWRIGHT_INSTANCE=0123456789ABCDEF"
"%LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe" persistent
set "TABBIT_PLAYWRIGHT_INSTANCE="
```

## Registry validation

On macOS/POSIX, the registry is exactly:

```text
$HOME/.local/share/tabbit-playwright/instances
```

Inspect candidate `*.instance` files and matching `*.product` sidecars with
`find`, `test`, `stat`, and bounded text reads. The directory must be owned by
the current user, mode 0700, and not a symlink. A record must be a
regular non-symlink owned by the current user with mode 0600, an uppercase
16-hex filename ID, exact managed marker and line count, absolute managed paths,
and a canonical product sidecar. Missing `endpoint.json` means offline; never read
the file. Ignore invalid records.

On Windows, the registry is exactly:

```text
%LOCALAPPDATA%\Tabbit\LocalAgent\instances
```

Use PowerShell `Get-ChildItem`, `Get-Item`, `Get-Acl`, and `Get-Content -Raw`
only for read-only inspection. A valid `*.json` record is a regular file under
that protected root, has no reparse component, has the protected DACL for the
current user and `SYSTEM`, and has exactly `version`, `instanceId`, `product`,
`cliPath`, `endpointPath`, `browserPath`, and `userDataDir`. Require version 1,
a matching uppercase 16-hex filename ID, a canonical product, absolute accepted
installation paths, and `endpointPath` exactly below `userDataDir\LocalAgent`.
Ignore invalid records; do not repair them.

## Failure boundaries

- Agent sandbox denial: request reusable approval for the stable launcher path
  and, only for explicit selection, read-only registry access. Approval does not
  authorize registry changes.
- OS ownership, mode, ACL, endpoint-access, quarantine, or signing-policy
  denial: verify Agent and Browser share an OS user, then relaunch Browser so it
  can repair its managed integration. Report any remaining denial without
  changing system security.
- Missing or malformed launcher/registry: invalid installation.
- exit 69: unavailable or ambiguous routing.
- `Persistent input ended before bootstrap`: closed host stdin; use an
  interactive process or the compatibility commands above. Do not relaunch the
  Browser.
- Failure after selection: runtime connection denial.
- `BROWSER_RUNTIME_UNAVAILABLE`: relaunch Browser once with permission. Never
  start the Browser-owned Runtime Service directly.

Never broaden permissions or ACLs, require administrator access, disable
security controls, or copy/relocate native binaries.
