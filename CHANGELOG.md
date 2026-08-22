# Changelog

## 0.2.3

- Fixed the bundle's `cordis.patch.yml` loader entry to use the npm package
  name `dsh-tabbit` instead of the non-existent package `tabbit-browser`. This
  resolves the `Cannot find package 'tabbit-browser'` load failure that
  affected fresh installs after the package was renamed in 0.2.1.

## 0.2.2

- Install and update commands now use the npm package (`dsh plugin add
  dsh-tabbit`) as the primary route — prebuilt tarball, CDN-served, and
  counted in npm download stats; the `github:` source remains documented as
  a fallback.

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
