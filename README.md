<p align="center">
  <img src="https://raw.githubusercontent.com/Co-Messi/supercut/main/assets/supercut-wordmark-final.png" alt="supercut: real app footage to cinematic launch video" width="620" />
</p>

<p align="center">
  <strong>Point an AI director at your live app. Get a cinematic 60 second launch video.</strong>
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/Quick_start-1a1a1a" alt="Quick start" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="#contributing"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome" /></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Co-Messi/supercut/main/assets/demo-pulse.webp" alt="supercut filming a live service-health dashboard: it searches for a service, then flips through services as their live metrics update" width="900" />
  <br />
  <sub><em>A preview of one supercut run against a live service-health dashboard: the cursor, camera and cuts are all automatic. This clip is a 1200px, silent animated WebP. The real render is an MP4 with music.</em></sub>
</p>

---

## Quick start

```bash
npx @co-messi/supercut generate --url http://localhost:3000
```

`generate` needs an LLM key in a `.env` (see [LLM provider setup](#llm-provider-setup)), plus Playwright's Chromium and an `ffmpeg` on your PATH. `npx @co-messi/supercut doctor` checks both and prints the exact install command for anything missing. The Chromium command runs supercut's own copy of Playwright (`node "<its path>/cli.js" install chromium`), because `npx playwright install chromium` run inside an app with its own Playwright installs that app's browser version, which supercut cannot use.

From source:

```bash
git clone https://github.com/Co-Messi/supercut
cd supercut
npm install
npm run build

node dist/cli/index.js generate --url http://127.0.0.1:3000
```

Any command accepts `--help`. Examples below write the command as plain `supercut ...`: run it as `npx @co-messi/supercut ...`, or `node dist/cli/index.js ...` from a source checkout.

No key? The keyless path works standalone against the bundled demo app:

```bash
# 1. serve the bundled demo app on port 4319
python3 -m http.server 4319 --directory examples/demo-app &

# 2. film it with the example recipe, then render
node dist/cli/index.js record --recipe examples/demo.recipe.json --out out/take
node dist/cli/index.js render --take out/take --out out/final.mp4
```

## Use it from your coding agent (no API key)

Already working in Claude Code? Let your agent be the director. It reads your app, writes the filming recipe itself, runs `supercut record` and `supercut render`, then looks at a contact sheet of the result before it reports back. No LLM key is needed because your agent is the LLM.

```text
/plugin marketplace add Co-Messi/supercut
/plugin install supercut@supercut
```

Then ask: "make a launch video of my app running on localhost:3000". The skill lives in [`.claude/skills/supercut/SKILL.md`](.claude/skills/supercut/SKILL.md) and works in any agent that can read a skill file or a pasted task: it documents the recipe schema with a minimal valid example, the staging-only safety rules, and the exact commands.

Using a different agent? Paste this as the task:

```text
Make a launch video of my app using supercut (https://github.com/Co-Messi/supercut).
Follow .claude/skills/supercut/SKILL.md from that repo: read my app, write recipe.json,
show me the action list and wait for my yes, then run supercut record and supercut render,
and look at a contact sheet of the result before reporting. My app runs at <MY_APP_URL>
and its source is in <MY_APP_SOURCE_DIR>. Film staging or local data only.
```

## How it works

```text
 your app URL ──▶ 1 analyze   read the source + crawl the app, pick the money moments (LLM)
                  2 script    write the filming recipe (LLM, schema-validated, no invented selectors)
                  3 record    a deterministic browser performs it, captured frame by frame
                  4 qc        deterministic + optional vision checks, bounded re-takes
                  5 render    cinematic compositing ──▶ final.mp4 (up to 60s)
```

Each stage hands off a plain JSON artifact, so you can stop at any point, hand-edit, and resume. Stages 3 and 5 need no LLM.

- **Real footage only.** It drives your actual app in a real browser. Nothing is faked or re-created.
- **It understands the product.** It reads your routes and source and crawls the DOM, so it films the moments that sell the product (type a query, frame the result) instead of parking on the landing page.
- **It frames the payoff.** The camera holds on the result an action produces, not the button you clicked.
- **An open contract.** The recorder writes a documented event log, and any recorder can feed the renderer.

## How it compares

| | Films your real running app | Needs a human to record or edit | Needs an LLM API key | Open source |
| --- | --- | --- | --- | --- |
| supercut | Yes | No | `generate`: yes. Agent skill path: no | Yes (MIT) |
| Screen Studio | Yes (screen recording) | Yes | No | No |
| openscreen | Yes (screen recording) | Yes | No | Yes (MIT) |
| agentic-product-demo | No (rebuilds the UI as code in Remotion) | No (your coding agent writes it) | No separate key (runs inside your coding agent) | Kit is MIT; depends on Remotion, which needs a paid license for companies over 3 people |

Based on each project's public description at the time of writing. Check them before you decide, they change.

## Project principles

- Real product footage beats mockups.
- The event log is a public contract.
- The keyless `record` and `render` paths stay useful without an API key.
- Defaults fail loudly on unsafe or ambiguous config.

## Safety

supercut drives and may mutate the app you point it at. Film staging or local data, never production. Destructive controls (Delete, Pay, and similar) are excluded by default on a best effort basis, `generate` prints every action before filming and asks first, and `--block-private-network` engages an SSRF guard for untrusted targets. Full details are in [SECURITY.md](SECURITY.md).

## LLM provider setup

Copy `.env.example` to `.env` (or pass `--env-file <file>`):

```bash
cp .env.example .env
```

DeepSeek is text-only here, so supercut disables screenshots and vision QC for it by default:

```env
SUPERCUT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
SUPERCUT_MODEL=deepseek-v4-pro
```

OpenRouter and custom OpenAI-compatible providers can use vision-capable models:

```env
SUPERCUT_PROVIDER=openrouter
OPENROUTER_API_KEY=...
SUPERCUT_MODEL=anthropic/claude-sonnet-4.6
SUPERCUT_VISION=true
```

For `SUPERCUT_PROVIDER=custom`, set `SUPERCUT_API_KEY`, `SUPERCUT_LLM_BASE_URL` and `SUPERCUT_MODEL`. A provider-scoped key never leaves its provider. If multiple provider keys are present, set `SUPERCUT_PROVIDER` explicitly: ambiguous config fails loudly rather than guessing.

Every `generate` run has a hard LLM spend ceiling: 300000 tokens by default, tunable with `--max-tokens <n>` or `SUPERCUT_MAX_TOKENS` (`0` or `off` disables). Retries, escalations and timed-out attempts all count against it, and the run aborts with a per-stage breakdown if it would pass the ceiling.

## Backgrounds

Every render stages the app window on a background. The default is the bundled `cobalt` wallpaper. Pick another with `--bg` (on `render` and `generate`):

```sh
supercut render --take out/take --bg sunrise            # bundled wallpaper
supercut render --take out/take --bg midnight           # procedural palette
supercut render --take out/take --bg path/to/wall.png   # your own image
```

| wallpaper            | look                        |
| -------------------- | --------------------------- |
| `cobalt` *(default)* | deep blue-violet silk waves |
| `glacier`            | cool blue-violet            |
| `sunrise`            | warm gradient               |
| `daydream`           | pastel clouds               |
| `magenta`            | magenta glow                |
| `coral`              | pastel coral bloom          |
| `lavender`           | soft blue-lavender          |

Procedural palettes (generated at render time, no asset): `aurora`, `midnight`, `dusk`, `paper`.

## Music

`render` is silent by default. On `generate` the AI director picks the bundled track that matches your app's look. `--music` (on `render` and `generate`) muxes a looped, loudness-normalized track with fade in and out under the video, without re-encoding the video or changing its length:

```sh
supercut render   --take out/take --music midnight
supercut generate --url http://localhost:3000 --music pulse
supercut render   --take out/take --music path/to/your-track.mp3   # your own file
```

Bundled tracks (original instrumentals made for supercut, provenance in `assets/music/CREDITS.md`):

| track      | vibe                    |
| ---------- | ----------------------- |
| `pulse`    | minimal tech-house      |
| `daybreak` | bright melodic house    |
| `midnight` | dark synthwave/techno   |
| `momentum` | driving minimal techno  |

`--music off` forces a silent cut. `--music` always outranks the director's pick on `generate`.

## Privacy

`generate` sends crawled page text, element labels and selectors, and optional repo notes (`--repo`) to your configured LLM provider. In vision mode it also uploads full, unredacted screenshots of your app, so do not film apps showing real customer data or secrets with vision on. It writes frames, recipes and director reports to `out/`; review those before sharing. `record` and `render` never call an LLM. See [SECURITY.md](SECURITY.md).

## Event-log contract

The public boundary is plain JSON, so any recorder can feed the renderer:

```text
recipe.json ──▶ record ──▶ take directory
                         ├─ events.json        (the event-log contract)
                         ├─ frames-index.json
                         └─ frames/*

take directory ──▶ render ──▶ final.mp4
```

Schemas reject unsupported URL schemes, malformed events, non-monotonic timelines, oversized logs, and impossible camera boxes.

Besides its events, `events.json` carries three optional declarations about the take. The built-in recorder always writes all three; a third-party recorder should write each one it can honour:

| field | meaning | when it is absent |
| --- | --- | --- |
| `t_source_unified: true` | event `t` is on the same clock as frame `t_source` | a legacy take: event and frame skew only warns |
| `navigation_logged: true` | every page change while filming is logged: a later scene's entry as its `scene` event, anything else (a clicked link, a submit, a `goto`, a page redirecting itself) as a `navigation` event, and a same-document route change that changes the URL path as a `navigation` event with `kind: "spa"`. The renderer then reads an unexplained frame gap as a stall on the same page and keeps the camera | page changes are inferred from long frame gaps, so a long main-thread stall can read as a page change |
| `failed_scenes: [names]` | scenes the recorder could not perform | the take is assumed complete, so partial footage cannot be refused |

Identical runs produce structurally and geometrically identical `events.json` with timestamps agreeing within about 150ms (not byte-identical). Three render-time gates protect the output:

- **Partial take**: the recorder lists scenes it could not perform in `failed_scenes`, and `record` exits nonzero. `render` refuses such a take, because the video would silently skip those scenes; `SUPERCUT_ALLOW_PARTIAL=1` renders the scenes that were filmed.
- **Skew**: on a unified-clock take, events leading the footage by more than 250ms fail the render (`SUPERCUT_ALLOW_SKEW=1` forces it). Logs without the marker are treated as legacy recorders and only warn.
- **Capture health**: a take whose frame count falls far below its duration times fps is refused, because that footage renders as stills with a camera gliding over them. Average source fps is printed on every `record`, `generate` and `render` run. To render a genuinely sparse take, set `SUPERCUT_ALLOW_SPARSE=1`.

## Contributing

```bash
npm run typecheck
npm run test:fast
npm run test:e2e          # needs Chromium and ffmpeg
npm audit --audit-level=moderate
```

Keep PRs focused and add tests for behavior changes. Agents working on this repo should read [AGENTS.md](AGENTS.md). Want a video of your app? Open a ["Film my app" issue](https://github.com/Co-Messi/supercut/issues/new?template=demo_request.md).

## License

[MIT](LICENSE)
