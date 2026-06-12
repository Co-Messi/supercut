# Spike Results — 2026-06-11

Both pre-build experiments from the design doc (Next Steps step 2). Numbers
measured on macOS arm64, Chrome/Chromium 148, Node 22.22.

## Capture spike (`capture-spike.ts`)

Animated 1920×1080 page at 2x DPR (3840×2160 raw frames), 8s sample.

| Candidate | Achieved fps | Jitter | Frame size | 60s take disk | Verdict |
|---|---|---|---|---|---|
| CDP screencast JPEG q90 | 25.3 | 18.4 ms | 118 KB | 175 MB | ✗ too slow (JPEG encode throttles) |
| **CDP screencast PNG** | **56.1** | **6.9 ms** | 197 KB | 648 MB | **✓ PRIMARY** |
| beginFrame virtual-time | — | — | — | — | ✗ dead (below) |

- **PNG screencast is the primary capture path.** 56 fps sustained at 4K,
  lossless, sharp (sample frame verified: 11px text fully legible —
  `out/capture-A-png-sample.png`). Conformed to the 60fps grid by
  nearest-frame hold per Event-Log Schema v0. Real-time: a 60s take costs
  60s wall-clock (within the ≤2 min capture budget). ~650MB intermediate is
  streamed and deleted after render.
- **`HeadlessExperimental.beginFrame` is not viable anywhere:**
  - New headless (full Chromium 148): the command **no longer exists**
    (`'HeadlessExperimental.beginFrame' wasn't found`).
  - Old headless shell (148, macOS arm64): enabling BeginFrameControl
    (`--enable-begin-frame-control` + `--run-all-compositor-stages-before-draw`,
    any combination, with/without sandbox/GPU) **crashes the browser** before
    the first frame.
  - Design doc's "likely primary" guess is overturned; the screencast
    "fallback" measured excellent anyway.

## Render spike (`render-spike.ts`)

Job per output frame: 8 motion-blur subframes sampling a 3840×2160 source
through a spring-zoom transform into 1920×1080. Budget: 3,600 frames ≤ 6 min
(≥10 fps).

| Candidate | ms/frame | 60s take renders in | Verdict |
|---|---|---|---|
| Pure-JS CPU (Node, nearest-neighbor) | 88.3 | 5.3 min | ✗ technically passes, zero headroom at floor quality |
| **Chromium-hosted (OffscreenCanvas + WebCodecs)** | **9.6** (incl. H.264 encode) | **0.6 min** | **✓ PRIMARY — 10x headroom** |

- **Chromium-hosted compositor is the primary render runtime** (decision #6's
  spike candidate, confirmed). GPU `drawImage` compositing is effectively free;
  composite + `avc1.640028` (H.264 High) hardware/native encode sustains
  ~104 fps output. wgpu-in-Node moot — eliminated without testing (native-deps
  wall + Chromium already provides the GPU).
- **H.264 High profile encode is natively supported** by `VideoEncoder` in
  full headless Chromium on macOS — final MP4 may not even need an ffmpeg
  transcode (mux via Mediabunny in-page or ffmpeg as muxer only).

## Operational gotchas (cost an hour — don't rediscover)

1. **WebCodecs requires a secure context.** `about:blank` and `data:` pages
   have `isSecureContext === false` → `VideoEncoder is not defined`. Serve the
   render host page over `http://127.0.0.1:<port>` (trustworthy origin).
2. **Playwright's default headless shell has NO WebCodecs at all** (stripped
   build). Capture can use the shell (screencast is CDP-side), but the render
   stage must launch the full Chromium: `chromium.launch({ channel: "chromium" })`.
3. **`tsx` cannot run `page.evaluate` callbacks with helpers** — esbuild
   injects `__name` which doesn't exist in-page (`__name is not defined`).
   Run spike/render code with `node --experimental-strip-types`, or keep
   evaluate bodies helper-free.

## Consequences for the build plan

- Capture stage: headless shell + `Page.startScreencast` PNG @2x,
  ack-throttled, conform to 60fps grid. Budget confirmed: ~1 min/take.
- Render stage: full Chromium page on localhost http; decode captured
  footage in-page (WebCodecs `VideoDecoder`) → composite → `VideoEncoder`
  H.264 → mux. **No raw-frame transport between Node and the page.**
  Budget confirmed: ~0.6 min/render — frees ~5 min of the 15-min pipeline
  budget for QC/retakes.
