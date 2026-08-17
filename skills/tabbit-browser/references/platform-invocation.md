# Platform invocation

Use the stable Tabbit CLI installed by Tabbit Browser for the current platform:

```text
macOS:   ~/.local/bin/tabbit-cli
Windows: %LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe
```

DSH's Windows `read-only` and `workspace-write` modes use a restricted token
that cannot open the Browser Runtime Service named pipe for writing. Do not ask
for Full Permission in advance. Invoke the CLI normally first.

After `tabbit_browser_install` detects a supported Browser, launcher, and
Runtime process, use `tabbit-cli tasks` as the connection probe. If it succeeds,
continue without mentioning permissions. If it returns
`BROWSER_RUNTIME_UNAVAILABLE`, ask the user to change the current DSH session
permission to Full Permission, then stop the task. Do not retry the CLI or
continue browser work.

On macOS, invoke it as the first command token. For example:

```bash
~/.local/bin/tabbit-cli nodejs --task 'inspect extensions' <<'EOF'
return {title: await page.title(), url: page.url()};
EOF
```

On Windows, use the native executable installed below `LOCALAPPDATA`. In
PowerShell, pipe multiline JavaScript to the launcher with the call operator:

```powershell
@'
return {title: await page.title(), url: page.url()};
'@ | & "$env:LOCALAPPDATA\Tabbit\LocalAgent\bin\tabbit-cli.exe" nodejs --task 'inspect extensions'
```

The PowerShell call operator is shell syntax for invoking the launcher; it is
not a wrapper. In either platform's shell, keep the launcher as the invoked
command and pass `nodejs`, `screenshot`, `finish`, and other CLI operations
directly to it.

Do not substitute `tabbit-playwright`, another browser launcher, a versioned
binary, a wrapper command, raw CDP, or a direct Runtime Service connection.
Browser owns the Runtime Service and its restart policy.
