# Changelog

## 0.2.1

- Renamed the package to `dsh-tabbit` and published it to npm; updated all
  remaining references (daily update-check changelog URL, install commands in
  the plugin, skill, and READMEs) from `Tabbit-Browser/dsh-plugin` to
  `Tabbit-Browser/dsh-tabbit`.

## 0.2.0

- Added a daily plugin update check. Loading the skill compares the installed
  plugin version with the published changelog — cached for 24 hours, at most
  one request per day, silent when offline — and, when outdated, asks the user
  whether to update, showing what the new version added.
- Added the `tabbit_plugin_update` tool. It records a version the user declined
  so the skill stops announcing it, and can force a recheck after a plugin
  update or a connectivity change.
