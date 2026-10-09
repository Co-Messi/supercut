# AGENTS.md

Guidance for coding agents working ON this repository. If you want to USE supercut to film an app, read `.claude/skills/supercut/SKILL.md` instead.

supercut is a TypeScript CLI: an AI director films a real web app with Playwright and renders a cinematic launch video.

## Commands

```bash
npm ci
npm run build          # tsc to dist/
npm run typecheck      # tsc --noEmit
npm run test:fast      # the quick unit files, no browser
npm test               # whole suite including e2e (needs Chromium and ffmpeg)
npm run test:e2e       # only *.e2e.test.ts
npm run check:pack     # asserts the npm tarball contents and size
npm run dev -- <args>  # run the CLI from source with tsx
```

Browsers: `npx playwright install chromium`. `ffmpeg` must be on PATH. `supercut doctor` checks both.

## Layout

- `src/schema`: the public contracts (`recipe.ts`, `event-log.ts`). Zod, strict.
- `src/director`: LLM stages (analyze, script, qc), config, budget, source route reading.
- `src/capture`: the recorder. Drives the browser, writes the take directory.
- `src/render`: the planner and renderer. Turns a take into `final.mp4`.
- `src/cli`: argument parsing, readable errors, `doctor`.
- `src/security`: URL policy, browser request gate, redaction.
- `assets/`: bundled backgrounds and music (allowlisted in `package.json` `files`).

## Test rules

- Write the failing test first for any behavior change.
- Run `npm run test:fast` and `npx tsc --noEmit` before every commit. Run only the e2e files you touch; they launch Chromium.
- Never loosen a threshold, tolerance or gate to make a test pass. Fix the cause, or change the threshold with a stated reason in the commit.
- Unit tests must not need a network or an API key. LLM behavior is tested with a stub client or a mocked `fetch`.
- Do not skip, `.only` or delete a failing test to get green.

## The event-log contract

The recorder and the renderer only meet through a take directory:

```text
events.json          event log (schema in src/schema/event-log.ts)
frames-index.json    [{ file, t_source }]
frames/*             the frames (JPEG or PNG)
```

- Event timestamps share the frame `t_source` clock, declared by `t_source_unified: true`.
- `failed_scenes` (optional) lists scenes the recorder could not perform. A take with failed scenes is partial footage and the render stage refuses it unless explicitly allowed.
- Any recorder that writes this shape can feed the renderer. Changing the shape is a contract change: update the schema, the parser tests and the README together, and keep old takes parseable where possible.

## Invariants

- `record` and `render` stay keyless. They must never call an LLM or need an API key. Only `generate` does.
- The event log is a public contract. Schemas are strict and reject malformed input loudly.
- Private and localhost targets are allowed by default; `--block-private-network` engages the SSRF guard. Do not weaken the guard when it is on.
- Destructive controls are excluded from filming by default (`--allow-destructive` opts in).
- Recipes are capped at 60 seconds of estimated video.
- The LLM budget is a hard ceiling for the whole run. Every attempt, including retries and timeouts, is metered at its worst case.
- Defaults fail loudly on unsafe or ambiguous config rather than guessing.
- Page-derived text sent to a model is wrapped in the per-run untrusted markers.

## Style

- Comments state present-tense invariants and the reason for them. History belongs in commit messages, not in code comments or test names.
- Prose in docs and comments avoids em dashes and en dashes. Use commas, colons or separate sentences.
- Conventional commit messages (`fix(cli): ...`, `feat(director): ...`). Keep PRs focused.
