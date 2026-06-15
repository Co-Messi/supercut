# Contributing to supercut

Thanks for helping build supercut.

## Local setup

```bash
npm install
npm run build
npm run test
```

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

## Project principles

- Real product footage beats mockups.
- The event log is a public contract.
- Non-AI recorder/render paths should remain useful without an API key.
- Defaults should produce a launch-ready video, not a raw screen recording.
