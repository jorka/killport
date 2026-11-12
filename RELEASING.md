# Releasing

## One-time setup (needs your accounts)

1. **Publisher:** `JoroGeorgiev` (set in `packages/vscode/package.json`; extension ID `JoroGeorgiev.killport`).
2. **Repository:** https://github.com/jorka/killport (set in both `package.json` files).
3. **Secrets** (GitHub → Settings → Secrets → Actions). Any that are missing are skipped:
   - `VSCE_PAT`: Azure DevOps token with *Marketplace → Manage* scope
   - `OVSX_PAT`: token from https://open-vsx.org (Cursor, Windsurf, VSCodium install from there)
   - `NPM_TOKEN`: npm automation token (for `npx killport-mcp`; the name is currently free)
4. **Screenshot.** Add a screenshot or GIF of the panel to the top of `README.md`
   (the Marketplace page shows the README).

## Each release

1. Bump `version` in `packages/vscode/package.json` **and** `packages/mcp/package.json` (keep them equal).
2. Move the `Unreleased` notes in `CHANGELOG.md` under the new version and date.
3. `npm test && npm run test:integration && npm run package`, then install the `.vsix` and click through once.
4. Commit, then `git tag v<version> && git push --tags`. The Release workflow tests, packages and publishes
   to the Marketplace, Open VSX and npm, and creates a GitHub release with the `.vsix`.
