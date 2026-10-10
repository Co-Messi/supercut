# Changelog

All notable changes to this project are recorded here. The format follows Keep a Changelog.

## 0.1.0 (2026-10-09)

First public release of `@co-messi/supercut`.

### Added

- `supercut generate`: the full pipeline. It reads the app's source routes and crawls the live UI, picks the moments that sell the product, writes a schema-validated filming recipe, records it, runs quality checks with bounded re-takes, and renders the video.
- `supercut record` and `supercut render`: the keyless stages, usable on their own with a hand-written or agent-written `recipe.json`.
- `supercut doctor`: checks Node, ffmpeg, the Playwright Chromium binary and WebCodecs H.264 support, with install hints for macOS, Linux and Windows.
- Public contracts: a strict recipe schema and an event-log schema, so any recorder can feed the renderer.
- Bundled backgrounds (seven wallpapers, four procedural palettes) and four original instrumental music tracks.
- Provider setup for DeepSeek, OpenRouter and any OpenAI-compatible endpoint, with a hard per-run LLM token budget (300000 by default).
- Coding agent integration with no API key: a Claude Code skill (`.claude/skills/supercut`) and a plugin manifest, so `/plugin marketplace add Co-Messi/supercut` then `/plugin install supercut@supercut` works.
- `SECURITY.md`, `AGENTS.md`, a tag-triggered release workflow, and a packed-install smoke test in CI. 0.1.0 itself was published by hand and carries no npm provenance attestation.
- A "Film my app" issue template.

### Changed

- The bundled demo app now serves on port 4319 instead of 4173, which is Vite preview's default and collided often.
- The director's prompt lists music tracks from the single `MUSIC_TRACKS` source instead of a hand-copied list.
- CLI errors are short and readable: unknown flags, a missing or invalid recipe file, and schema errors print one message and the command's usage instead of raw Node or Zod text. Flags such as `--seed` are validated before any file is read.
- Root `--help` lists the key `generate` flags.
- LLM retries: an empty answer is retried once (with a raised `max_tokens` when it was truncated), a timed-out attempt is retried once, and the per-attempt timeout scales with `max_tokens`.

### Fixed

- The `supercut` command survives `npm publish` on npm 11, which drops a `bin` path written with a leading `./`. CI checks `package.json` with npm 11 and fails if npm would rewrite it on publish.
- `supercut record` exits nonzero when any scene failed (the take is still written), names each failed scene with its reason, and points at the likely cause: the app URL and port for an error page or a refused connection, the selector for a control that never became visible. An app that is not listening gives a short message instead of a Playwright call log.
- `supercut doctor` no longer passes when the Chromium binary is missing from disk. The unused ffprobe check is removed.
- The Chromium install command in `doctor` and `render` errors runs supercut's own copy of Playwright (`node "<its path>/cli.js" install chromium`). `npx playwright install chromium`, even with a version pinned, run inside an app with its own `@playwright/test` ran that app's Playwright and installed its browser revision, which supercut cannot find.
- The LLM budget no longer leaks across calls: a provider that reports no usage is metered at prompt estimate plus `max_tokens`, timed-out and aborted attempts are charged at their worst case, and a 400 at an escalated size that does not blame the output size fails at once instead of wasting attempts.

### Security

- Private network guard (`--block-private-network`), destructive control filter, action preview with confirmation, best effort secret redaction and untrusted-content markers around page text. Details are in `SECURITY.md`.

### Capture

- A scene that shares the previous scene's URL now reloads unless the previous scene only hovered or waited. Typed text, filters, modals and scroll position no longer carry into the next scene.
- Typing clears the field first, then types each grapheme with real key events (keydown, keypress, input, keyup), so autocomplete and key driven inputs react as they would for a person.
- Every page change is logged: link and submit navigations as `navigation` events, SPA route changes as `navigation` with `kind: "spa"`, scene entries as `scene` events. Each take declares `navigation_logged: true`.
- A navigation is stamped at the first frame that actually shows the new page, not at commit time, so the camera no longer cuts on the old page.
- Navigations that never commit (204, downloads, aborts) leave nothing behind, commits within 300ms collapse into one, and a guard redirect logs one navigation.
- A scene whose entry page answers with HTTP 400 or above fails with a message naming the URL and status. Failed scenes are written to `failed_scenes` in `events.json`, with reasons printed.
- The repaint beacon is a CSS animation instead of a script that rewrote a style 60 times a second: zero DOM mutations in the filmed app, and frames keep flowing during long main thread tasks.
- Identical consecutive frames are written once. The bundled demo's frame directory went from 72MB to 7.9MB.

### Render

- A failed Chromium launch no longer hangs `render`; it closes the local server and prints the install command.
- A take with failed scenes is refused unless `SUPERCUT_ALLOW_PARTIAL=1`. `generate` renders a take that lost a few scenes and says which ones and why.
- On takes that declare `navigation_logged`, an unexplained frame gap is a stall on the same page: the frame holds and the payoff zoom survives. Older takes keep the gap inference.
- An SPA route change cuts like a page load, except one within 400ms of a beat whose named result region (`focus_selector`, or a QC zoom) was read on the new route: that beat keeps its punch, so a list item opening its detail route still frames the detail.
- Focus boxes under 8px are ignored instead of zooming into a corner. A shot ends at the earliest required zoom out.
- The 60 second estimate now counts reload, settle and pre-roll per scene and the real end tail. The measured length is checked after planning and warned about loudly when over 60 seconds.
- `render-report.json` is written next to every video: page changes and their source, beats framed or skipped with a reason, duration, source fps, accumulator mode, bitrate. The CLI prints a one line summary such as `framed 4 of 5 beats`.
- The bitrate line is informational; a mostly static take encodes small and is not a problem.
- When the float16 accumulator is unavailable the CLI says so, and the 8 bit fallback is capped at 4 passes to keep colour shift small.
- The cursor is drawn at mid shutter so it no longer leads the blurred content during fast zooms.
- The motion quality suite grades with the planner's own thresholds, adds pan speed and type and hover arrival metrics, uses a new JPEG pipeline fixture, and a pixel level e2e test checks luminance and cut timing on rendered frames.

### Behaviour changes for existing takes

- Takes recorded before pre-roll existed lose zooms on clicks in the first 1.4 seconds of a page; `render-report.json` lists them as too soon after the page opened.
- Recipes close to 60 seconds may now fail validation, because the overhead estimate is more honest.
- Takes with failed scenes are refused by `render` (see above).
