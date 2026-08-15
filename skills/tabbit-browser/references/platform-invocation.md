# Platform invocation

Use the stable `tabbit-cli` launcher installed by Tabbit Browser. When
`tabbit_browser_install` returned a `cliPath`, use that exact path.

Otherwise use the platform default:

- Windows PowerShell: `$env:LOCALAPPDATA\Tabbit\LocalAgent\bin\tabbit-cli.exe`
- Windows Git Bash: `"$LOCALAPPDATA/Tabbit/LocalAgent/bin/tabbit-cli.exe"`
- macOS/Linux: `~/.local/bin/tabbit-cli`

Invoke it as the first command token. For example:

```bash
~/.local/bin/tabbit-cli nodejs --task 'inspect extensions' <<'EOF'
return {title: await page.title(), url: page.url()};
EOF
```

Do not substitute `tabbit-playwright`, another browser launcher, a versioned
binary, a wrapper command, raw CDP, or a direct Runtime Service connection.
Browser owns the Runtime Service and its restart policy.
