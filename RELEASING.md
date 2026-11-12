# Releasing

## One-time setup (needs your accounts)

1. **Publisher.** Create a publisher at https://marketplace.visualstudio.com/manage and put its ID in
   `packages/vscode/package.json` → `"publisher"` (currently the placeholder `killport`).
   The extension ID becomes `<publisher>.killport`; also update `EXT_ID` in
   `packages/vscode/test/suite/extension.test.js`.
2. **Repository.** Push to GitHub, then add to both `packages/vscode/package.json` and
   `packages/mcp/package.json`:
   ```json
   "repository": { "type": "git", "url": "https://github.com/<you>/killport" },
   "bugs": "https://github.com/<you>/killport/issues",
   "homepage": "https://github.com/<you>/killport#readme"
   ```
   and remove `--allow-missing-repository` from the `package` script in `packages/vscode/package.json`.
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
