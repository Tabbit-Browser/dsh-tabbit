# Platform invocation

Use the stable Tabbit CLI installed by Tabbit Browser:

```text
~/.local/bin/tabbit-cli
```

Invoke it as the first command token. For example:

```bash
~/.local/bin/tabbit-cli nodejs --task 'inspect extensions' <<'EOF'
return {title: await page.title(), url: page.url()};
EOF
```

Do not substitute `tabbit-playwright`, another browser launcher, a versioned
binary, a wrapper command, raw CDP, or a direct Runtime Service connection.
Browser owns the Runtime Service and its restart policy.
