# AGENTS.md

## Project

`dsh-tabbit` — DSH bundle that packages the Tabbit Browser skill and
background installer. Published on npm as
[`dsh-tabbit`](https://www.npmjs.com/package/dsh-tabbit); listed in the
awesome-dsh-plugin registry as `Tabbit-Browser/dsh-tabbit`.

## Conventions

- Plain ESM JavaScript (`"type": "module"`), no build step. Node >= 20.
- Tests: `npm test` (`node --test`). All tests must pass before releasing.
- The npm tarball contents are whitelisted in `package.json` `files` —
  verify with `npm pack --dry-run` after changing it.
- Install/update instructions given to users (READMEs, `SKILL.md`,
  `index.js` update notice) prefer the npm route
  (`dsh plugin --profile web add dsh-tabbit`); the
  `github:Tabbit-Browser/dsh-tabbit` source is the documented fallback.
  npm installs are what the registry's download stats count.

## Release process

npm version and GitHub Release must stay in lockstep:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npm test` — 34/34 must pass.
3. Commit (`chore: release X.Y.Z`) and push to `main`.
4. `npm publish`. The npm account has security-key-only 2FA, which the
   npm CLI cannot satisfy — publish with a granular access token
   (read+write on packages, bypass 2FA) via a throwaway userconfig:
   `npm publish --userconfig <tmpfile>` where the tmpfile contains
   `//registry.npmjs.org/:_authToken=npm_...`. Delete the tmpfile
   afterwards; never commit tokens.
5. `gh release create vX.Y.Z --repo Tabbit-Browser/dsh-tabbit --target main`
   with the changelog entry as notes. This also creates the `vX.Y.Z` tag.

## Registry entry (awesome-dsh-plugin)

The upstream registry entry lives at
`data/plugins/Tabbit-Browser__dsh-tabbit.yml` in
`awesome-dsh-plugin/awesome-dsh-plugin`. READMEs there are generated from
the YAMLs — after editing an entry, run `node scripts/generate-readme.mjs`
and commit both READMEs, or CI fails. npm package detection and download
stats are re-probed daily by upstream automation; no manual cache edits.
