# Release automation

<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

Every push to `main` runs `.github/workflows/release.yml`. Vercel deploys
`main` to production by itself, outside this workflow.

## Flow

1. semantic-release reads the Conventional Commits since the last tag and
   decides the next version, if any (`.releaserc.json`).
2. On a release, its plugins, in order:
   - write the release notes and update `CHANGELOG.md`;
   - bump `package.json` (`@semantic-release/npm` with `npmPublish: false`:
     nothing goes to npm);
   - set the `version` of `server.json`
     (`@semantic-release/exec` runs `scripts/sync-server-json-version.mjs`);
   - commit the three files as `chore(release): <version> [skip ci]`, push it
     to `main` and tag it (`@semantic-release/git`);
   - create the GitHub Release (`@semantic-release/github`).
3. When the version changed, the job publishes `server.json` to the
   [MCP Registry](https://registry.modelcontextprotocol.io) with
   `mcp-publisher`, logged in through GitHub OIDC (`id-token: write`, no
   secret). The entry lists the hosted server only (`remotes`), under
   `io.github.florentleveque/mural-mcp-serveur`.

A push with no releasable commit (`docs:`, `chore:`, ...) changes no version
and publishes nothing.

## Why a GitHub App pushes the release commit

`main` is protected by a ruleset (pull request and status checks required), so
a direct push with the built-in `GITHUB_TOKEN` is refused (`GH006`). A GitHub
App on the ruleset's bypass list gets through. Its pushes, unlike
`GITHUB_TOKEN`'s, start workflow runs: `[skip ci]` in the release commit keeps
it from starting Release again, and `tests/unit/releaserc-skip-ci.test.ts`
guards that marker.

## One-time setup

None of this can be versioned; the repository owner applies it once.

1. **Create a GitHub App** (owner settings, Developer settings, GitHub Apps):
   - repository permissions: Contents read and write, Issues read and write,
     Pull requests read and write, Metadata read (mandatory);
   - no webhook;
   - installed on this repository only.
2. **Create the `release` environment** (repository settings, Environments),
   with a deployment branch policy that admits `main` only:
   - secret `RELEASE_APP_PRIVATE_KEY`: a private key generated for the App;
   - the key never goes in a repository secret, which a workflow on any branch
     can read: the App bypasses the ruleset, so whoever mints its token can
     push to `main` unchecked.
3. **Add the repository variable `RELEASE_APP_CLIENT_ID`**: the App's Client ID
   (public, hence a variable).
4. **Put the App on the bypass list of the `main` ruleset**, mode "always"
   (the "pull request" mode would still require a pull request).

`release.yml` references exactly these names: environment `release`, variable
`RELEASE_APP_CLIENT_ID`, secret `RELEASE_APP_PRIVATE_KEY`. Until they exist, a
release run fails at the token step and nothing is pushed or published.

## Bumping `mcp-publisher`

`MCP_PUBLISHER_VERSION` in `release.yml` pins the publisher, and its archive is
checked against the release's checksums file before it runs. Pick a release of
[modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry/releases)
at least five days old, as for every dependency.
