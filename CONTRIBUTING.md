# Contributing to supercut

Thanks for helping build supercut.

## Local setup

```bash
npm install
npm run build
npm run test
```

Try the keyless path against the bundled demo app (port 4319, chosen to avoid Vite preview's default 4173):

```bash
python3 -m http.server 4319 --directory examples/demo-app &
node dist/cli/index.js record --recipe examples/demo.recipe.json --out supercut-out/take
node dist/cli/index.js render --take supercut-out/take --out supercut-out/final.mp4
```

Agents working on this repo: see [AGENTS.md](AGENTS.md) for commands, test rules and invariants.

## Good first contributions

Good starter tasks usually improve one narrow part of the project:

- add or improve a recipe in `examples/`,
- add tests for schema validation,
- improve CLI error messages,
- document a recorder or renderer edge case,
- add a small render theme or background asset.

## Pull request checklist

Before opening a PR:

- Run `npm run build`.
- Run `npm run test`.
- Keep the PR focused on one change.
- Add or update tests when behavior changes.
- Include screenshots, videos, or generated artifacts for visual changes.

## Releasing

Releases publish from GitHub Actions, never from a laptop. Bump `version` in `package.json` (and the plugin manifests), merge, then push a `v<version>` tag. `.github/workflows/release.yml` checks the tag against `package.json`, runs the whole CI suite on the tagged commit, and only then publishes with npm trusted publishing (OIDC, no stored token), which attaches a provenance attestation. A version already on npm is skipped rather than failed. The trusted publisher on npmjs.com must name this repository, the workflow file `release.yml` and the environment `npm-publish`.

## Project principles

- Real product footage beats mockups.
- The event log is a public contract.
- Non-AI recorder/render paths should remain useful without an API key.
- Defaults should produce a launch-ready video, not a raw screen recording.
