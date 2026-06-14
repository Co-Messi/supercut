# supercut

<p align="center">
  <img src="assets/readme-hero-10k.png" alt="supercut — institutional-grade launch videos from your real app" width="100%" />
</p>

> Point it at your app. Get the supercut.

Institutional-grade, max-60-second launch videos generated from your **real**
product — not an HTML mockup. A scripted browser performs your app on camera;
a cinematic renderer adds the Screen Studio look: spring zoom-to-cursor,
motion blur, padded background, and a polished final export.

**Status: pre-release.** The core record/render/generate pipeline exists, but
it is still being hardened. Use it on trusted apps and trusted recipes.

## Why people should star it

- Real footage only — no fake UI renders, ever.
- One-command promise — the end goal is `supercut https://your-app.com`.
- Open event-log contract — any recorder can feed the renderer.
- Useful without an API key — `supercut record` and `supercut render` stand alone.
- Built for launches — ≤60s, 1080p60, padded backgrounds, smooth zooms.

```text
 your app URL ──▶ ① analyze   pick the 2-4 money moments (LLM)
                  ② script    write the filming recipe (LLM, schema-validated)
                  ③ record    deterministic browser executor performs it
                  ④ qc        deterministic + optional vision checks, bounded retakes
                  ⑤ render    cinematic compositing ──▶ final.mp4 (≤60s target)
```

## Install for local development

```bash
npm install
npm run typecheck
npm run test:fast
```

For browser/video tests you also need Chromium + ffmpeg:

```bash
npx playwright install chromium
npm run test:e2e
```

## CLI

```bash
npm run build
node dist/cli/index.js doctor
node dist/cli/index.js record --recipe examples/demo.recipe.json --out out/take --seed 1
node dist/cli/index.js render --take out/take --out out/final.mp4
node dist/cli/index.js generate --url https://your-app.example --out out/generate --yes
```

### Private/local apps & untrusted targets

Filming your own local dev app is the primary use case, so `generate` **allows**
localhost / RFC1918 / link-local by default — no flag needed:

```bash
node dist/cli/index.js generate --url http://127.0.0.1:3000 --yes
```

If you point supercut at an **untrusted or public** URL, add `--block-private-network`
to engage the SSRF guard (rejects localhost, RFC1918, link-local, and cloud-metadata
addresses, and validates each redirect hop):

```bash
node dist/cli/index.js generate --url https://untrusted.example --block-private-network --yes
```

(`--allow-private-network` is a deprecated no-op kept for back-compat.) Known limit:
the guard does not defend against DNS-rebinding (resolve-time TOCTOU).

> **supercut drives and may MUTATE the target app.** It performs real clicks and
> typing on whatever you point it at. Destructive controls (Delete, Pay, Checkout,
> …) are excluded from filming by default; pass `--allow-destructive` to include
> them. Do not run it against production data or URLs/recipes you do not trust.

## LLM provider setup

Copy `.env.example` to `.env` or pass `--env-file <file>`.

```bash
cp .env.example .env
```

DeepSeek is text-only in this project, so Supercut disables screenshots and
vision QC for DeepSeek by default:

```env
SUPERCUT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
SUPERCUT_MODEL=deepseek-v4-pro
```

OpenRouter/custom OpenAI-compatible providers can use vision-capable models:

```env
SUPERCUT_PROVIDER=openrouter
OPENROUTER_API_KEY=...
SUPERCUT_MODEL=anthropic/claude-sonnet-4.6
SUPERCUT_VISION=true
```

For `SUPERCUT_PROVIDER=custom`, set both `SUPERCUT_LLM_BASE_URL` and
`SUPERCUT_MODEL`; Supercut will not guess an OpenRouter model for your endpoint.

If multiple provider keys are present, set `SUPERCUT_PROVIDER` explicitly.
Ambiguous provider configuration fails loudly rather than guessing.

## Privacy warning

`supercut generate` may send crawled DOM text, element labels/selectors,
optional screenshots, and optional repo notes (`--repo`) to the configured LLM
provider. It can also persist sensitive frames, recipes, and director reports in
`out/`. Review those artifacts before sharing them.

Use `record` + `render` for a no-LLM workflow.

## Event-log contract

The public boundary is:

```text
recipe.json ──▶ record ──▶ take directory
                         ├─ events.json
                         ├─ frames-index.json
                         └─ frames/*.png

take directory ──▶ render ──▶ final.mp4
```

Schemas reject unsupported URL schemes, malformed known events, non-monotonic
timelines, oversized event logs, and impossible camera/zoom boxes.

## Project principles

- Real product footage beats mockups.
- The event log is a public contract.
- Non-AI recorder/render paths must remain useful without an API key.
- Defaults should fail loudly on unsafe or ambiguous config.

## Contributing

```bash
npm run typecheck
npm run test:fast
npm run test:e2e
npm audit --audit-level=moderate
```

Keep PRs focused and add tests for behavior changes.

## License

MIT
