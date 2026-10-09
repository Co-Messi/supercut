# Changelog

All notable changes to this project are recorded here. The format follows Keep a Changelog.

## 0.1.0 (unreleased)

First public release of `@co-messi/supercut`.

### Added

- `supercut generate`: the full pipeline. It reads the app's source routes and crawls the live UI, picks the moments that sell the product, writes a schema-validated filming recipe, records it, runs quality checks with bounded re-takes, and renders the video.
- `supercut record` and `supercut render`: the keyless stages, usable on their own with a hand-written or agent-written `recipe.json`.
- `supercut doctor`: checks Node, ffmpeg, the Playwright Chromium binary and WebCodecs H.264 support, with install hints for macOS, Linux and Windows.
- Public contracts: a strict recipe schema and an event-log schema, so any recorder can feed the renderer.
- Bundled backgrounds (seven wallpapers, four procedural palettes) and four original instrumental music tracks.
- Provider setup for DeepSeek, OpenRouter and any OpenAI-compatible endpoint, with a hard per-run LLM token budget (300000 by default).
- Coding agent integration with no API key: a Claude Code skill (`.claude/skills/supercut`) and a plugin manifest, so `/plugin marketplace add Co-Messi/supercut` then `/plugin install supercut@supercut` works.
- `SECURITY.md`, `AGENTS.md`, a release workflow with npm provenance, and a packed-install smoke test in CI.
- A "Film my app" issue template.

### Changed

- The bundled demo app now serves on port 4319 instead of 4173, which is Vite preview's default and collided often.
- The director's prompt lists music tracks from the single `MUSIC_TRACKS` source instead of a hand-copied list.
- CLI errors are short and readable: unknown flags, a missing or invalid recipe file, and schema errors print one message and the command's usage instead of raw Node or Zod text. Flags such as `--seed` are validated before any file is read.
- Root `--help` lists the key `generate` flags.
- LLM retries: an empty answer is retried once (with a raised `max_tokens` when it was truncated), a timed-out attempt is retried once, and the per-attempt timeout scales with `max_tokens`.

### Fixed

- `supercut record` exits nonzero when any scene failed (the take is still written) and says to check the app URL and that the port is not used by something else. An app that is not listening gives a short message instead of a Playwright call log.
- `supercut doctor` no longer passes when the Chromium binary is missing from disk. The unused ffprobe check is removed.
- The LLM budget no longer leaks across calls: a provider that reports no usage is metered at prompt estimate plus `max_tokens`, timed-out and aborted attempts are charged at their worst case, and a 400 at an escalated size that does not blame the output size fails at once instead of wasting attempts.

### Security

- Private network guard (`--block-private-network`), destructive control filter, action preview with confirmation, best effort secret redaction and untrusted-content markers around page text. Details are in `SECURITY.md`.

### Capture

- (to be filled in by the integrator)

### Render

- (to be filled in by the integrator)
