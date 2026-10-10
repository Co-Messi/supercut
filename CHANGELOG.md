# Changelog

All notable changes to this project are recorded here. The format follows Keep a Changelog.

## Unreleased

Fixes for the 2026-10-09 adversarial review.

### Added

- `--storage-state <file>` on `generate` and `record`: a saved Playwright session signs the crawl and every take in. Only the file's path reaches the browser; its contents never reach a prompt, the take, the reports or the logs. README has a "Filming a signed-in app" section.
- `--allow-private-network` is a real option again: it lets a public target reach private addresses (see Behaviour changes).
- `director-report.json` records a run id, the wall time of each stage, the number of takes and the QC adjustments applied at render time; `render-report.json` carries the same run id.
- Dependabot updates for npm dependencies and GitHub Actions.

### Changed

- One destructive-control policy (`src/security/destructive.ts`) for `generate` and the agent skill, widened to money and irreversible verbs (Buy, Sell, Subscribe, Upgrade, Payment, Transfer, Send money, Order now, Checkout, Refund, Charge, Merge, Deploy, Publish, Approve, Restart, Discard, Clear all, Empty trash, Purge, Drop, Log out, Sign out, Leave team, Ban, Uninstall, Disconnect, Cancel order and more). View-only controls such as "Clear filters" and "Reset view" stay filmable.
- QC re-takes happen only to drop a scene, at most once, so each action runs at most twice per run, and the confirmation question says so. Hold and zoom patches are applied to the recorded take at render time, without filming again.
- The crawl runs at the recorder's 1920x1080 viewport, reads source routes from Next.js apps only, and takes source routes and discovered links in turn.
- The token ceiling is checked before every attempt and charges the worst case for any failure after the request may have been sent (a reset connection, a 5xx). Prompt estimates count CJK and other non-ASCII characters as a token each, and the per-image estimate rises to what the provider actually bills.
- The CLI's default output directory is `supercut-out/`.
- `playwright` is pinned to 1.60.0, the version CI tests.
- Releases publish through npm trusted publishing with provenance, only after the whole CI suite passes on the tagged commit. CI also runs on Node 24.

### Fixed

- A click hit-tests the press point right before pressing, re-aims once if the target moved, and fails the scene instead of pressing whatever covered it. The logged click is where the press landed.
- `type` sends keys only to a focused text field that is the target, clears only its own input or textarea, and appends in a rich text editor instead of selecting the whole document.
- A field whose form submits through a destructive control can be typed into but never submitted.
- A table row with a nested Delete button is judged by its own label, so admin tables stay filmable.
- A vision QC failure after capture renders the recorded take instead of ending the run; the QC prompt wraps scene names in the untrusted markers.
- An unknown `--bg` fails at preflight, before any spend.
- Typed text counts toward the 60 second estimate at the time typing takes, and is capped at 500 characters. Patched recipes are re-validated against the cap.
- A crawl or a take whose page settles on another site (an identity provider's sign-in page) is refused; a crawl that found nothing to click or only a sign-in form stops before any LLM call.
- `:nth-match` disambiguation looks an element up by identity in one call (a 2,000-row table crawled in 40.7s now takes 2.5s).
- Custom endpoints that refuse `max_tokens` or `response_format` are asked again without them, and a rejection prints the provider's message.
- Superseded takes are deleted after the video renders, and an interrupted render removes its temporary stream.
- The tarball check is an allowlist and rejects `" 2"` sync-conflict copies.

### Security

- Selectors that would carry an email or a token into a prompt are left out of the inventory.
- Action previews and every log line built from model or page text escape terminal control characters.
- A `.env` read from the current directory that redirects the LLM endpoint or turns the token ceiling off prints a warning naming the file and the variable.
- `--repo` notes never follow a symlinked README, and secret assignments with prefixed key names (`aws_secret_access_key`) are redacted.
- The crawl never requests a link whose path reads as destructive (`/logout`).
- The private-network policy also covers SIIT (`::ffff:0:0/96`) and local-use NAT64 (`64:ff9b:1::/48`) addresses.

### Behaviour changes for existing users

- A target that resolves to a public address now gets the private-network guard by default: its pages cannot reach localhost or private addresses, requests go through the guard (buffered, a 30 second limit for responses that never finish, service workers blocked). Pass `--allow-private-network` for the old behaviour. A localhost or private target is unchanged. The `record()` and `crawlApp()` library defaults now match the CLI: a private target is filmed without passing `allowPrivateNetwork`.
- More labels are destructive, including Publish, Deploy, Merge and every Transfer; pass `--allow-destructive` to film them.
- Vision is off by default for a custom provider; set `SUPERCUT_VISION=true` for a model that takes images.
- Default output moved from `out/` to `supercut-out/`.
- At most one QC re-take instead of three; a shorter hold suggested by QC is not applied.
- `confirmCapture` (library) receives `{ maxPerformances }`.
- Recipes with long typed text may now exceed the 60 second estimate and fail validation.

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
