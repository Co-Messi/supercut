/**
 * The render host page — a dumb, fast executor served on localhost
 * (WebCodecs needs a secure context; the headless SHELL has no WebCodecs at
 * all, so this page runs in full Chromium).
 *
 * It fetches the precomputed render-plan.json (all the smart math already
 * done in tested TS) and only does mechanical work per output frame:
 *
 *   background → [×8 subframes: camera transform → shadow → rounded clip →
 *   source frame → cursor] → VideoFrame → H.264 (annexb) → POST /result
 *
 * Plain JS in a template string: it is served as a real page, so no TS/esbuild
 * helper traps.
 */
/** configured encoder bitrate — exported so the orchestrator can verify the
 *  DELIVERED bitrate against it after the mux */
import { cameraTransform } from "./plan.js";

export const ENCODER_BITRATE = 16_000_000;

/** in-page cap on buffered encoded output: a 60s 1080p60 take at 16 Mbps is
 *  ~120MB, so 512MB is generous headroom without risking an in-tab OOM */
export const MAX_ENCODED_BYTES = 512e6;

/**
 * Motion-blur pass count for one output frame: enough shutter samples that
 * consecutive copies of the content window sit ≤ 1px apart at the corner that
 * moves the MOST (a zoom about a point near one corner barely moves that
 * corner while the opposite one sweeps tens of px — sizing from the top-left
 * alone left stepped "onion ring" ghosts on the far side). Rounded up to a
 * power of two: 1/n is then exact in the float16 accumulator, so the n
 * weights sum to exactly 1 (no dimming). `a`/`b` are the [z, offX, offY]
 * camera transforms at the shutter's open/close. Embedded verbatim into the
 * host page below (via toString), so the page runs exactly this code.
 */
export function blurPassCount(
  a: readonly number[],
  b: readonly number[],
  c: { x: number; y: number; w: number; h: number },
  cap: number,
): number {
  let disp = 0;
  const corners = [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]];
  for (const [px, py] of corners) {
    const dx = b[0]! * px! + b[1]! - (a[0]! * px! + a[1]!);
    const dy = b[0]! * py! + b[2]! - (a[0]! * py! + a[2]!);
    disp = Math.max(disp, Math.hypot(dx, dy));
  }
  let n = 1;
  while (n < disp && n < cap) n *= 2;
  return n;
}

export const HOST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>supercut render host</title></head>
<body style="margin:0;background:#111;color:#9a9">
<script type="module">
const log = (m) => console.log("[render] " + m);
${blurPassCount.toString()}
${cameraTransform.toString()}

async function main() {
  const TOKEN = new URLSearchParams(location.search).get("t") || "";
  const authed = (u) => u + (u.includes("?") ? "&" : "?") + "t=" + encodeURIComponent(TOKEN);
  const fetchOk = async (u) => {
    const r = await fetch(authed(u));
    if (!r.ok) throw new Error("fetch " + u + " failed: HTTP " + r.status);
    return r;
  };

  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs unavailable — render requires full Chromium on a secure (localhost) origin");
  }

  const plan = await (await fetchOk("/take/render-plan.json")).json();
  const { fps, frames, layout, background, fade, sourceByFrame, blend, camera, cursor, sourceFiles } = plan;
  const SUB = 8;
  const W = layout.canvasW, H = layout.canvasH;
  const C = layout.content;

  // bring-your-own-wallpaper mode: served by the orchestrator at /take/bg
  let bgImage = null;
  if (background.kind === "image") {
    bgImage = await createImageBitmap(await (await fetchOk("/take/bg")).blob());
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  // motion-blur accumulator: 'lighter' (additive) at 1/n alpha per pass is a
  // TRUE average — n × src-over at 1/n alpha only reaches ~66% opacity and
  // washes the content dark. It accumulates in float16 where available: in
  // an 8-bit buffer every 1/n-weighted pass rounds, and 48 passes of white
  // summed to 240/255 (visible dimming and banding during every zoom).
  const accumCanvas = new OffscreenCanvas(W, H);
  let actx = accumCanvas.getContext("2d", { colorType: "float16" });
  const floatAccum = !!(actx && actx.getContextAttributes &&
    actx.getContextAttributes().colorType === "float16");
  if (!actx) actx = accumCanvas.getContext("2d");
  // 8-bit fallback: keep n small so per-pass rounding cannot add up
  const MAX_PASSES = floatAccum ? 32 : 8;
  log("blur accumulator: " + (floatAccum ? "float16, up to 32 passes" : "8-bit, up to 8 passes"));
  // downscaling the 2x-DPR source with the default (low / bilinear) filter
  // aliased text into shimmering stair-steps; 'high' is a proper resampler
  for (const c of [ctx, actx]) {
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
  }

  // --- encoder: H.264 annexb so Node can mux the raw stream with ffmpeg -c copy ---
  const chunks = [];
  const ENCODED_BYTES_CAP = ${MAX_ENCODED_BYTES};
  let totalEncodedBytes = 0;
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      totalEncodedBytes += buf.length;
      if (totalEncodedBytes > ENCODED_BYTES_CAP) {
        // a throw here vanishes inside the codec callback and the truncated
        // stream would upload as a "success" — surface it via encodeError,
        // which the encode loop checks every frame
        if (!encodeError) encodeError = new Error("encoded result exceeds " + ENCODED_BYTES_CAP + " byte cap");
        return;
      }
      chunks.push(buf);
    },
    error: (e) => { encodeError = e; },
  });
  const encoderConfig = {
    codec: "avc1.640028",
    width: W, height: H,
    framerate: fps,
    // 10 Mbps washed out thin serif strokes (lowercase 's' vanished from caption
    // text while chunkier glyphs survived). Crisp 1080p60 text needs more head-
    // room.
    // B3 (review): lowered 40 Mbps → 16 Mbps to reduce Chromium memory pressure
    // (the encoder buffers chunks in-page; 40 Mbps risked OOM on long takes).
    // 16 Mbps is ample for 1080p60 screen content and still holds fine detail.
    bitrate: ${ENCODER_BITRATE},
    bitrateMode: "constant",
    avc: { format: "annexb" },
  };
  // Probe BEFORE configuring: a clear one-line failure beats a cryptic
  // mid-render encoder error.
  const support = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!support.supported) {
    throw new Error("H.264 (avc1.640028) encoding not supported by this Chromium — cannot render");
  }
  encoder.configure(encoderConfig);

  // --- sequential source-frame cache (frames are consumed in order; a blended
  //     frame needs its NEXT source too, so cache by index and prune anything
  //     behind the playhead — holds at most 2 decoded bitmaps) ---
  const bmpCache = new Map();
  async function sourceBitmap(idx) {
    let bmp = bmpCache.get(idx);
    if (bmp) return bmp;
    const resp = await fetchOk("/take/" + sourceFiles[idx]);
    const full = await createImageBitmap(await resp.blob());
    // pre-resample ONCE per source frame to the largest size it is ever drawn
    // at (content width × max zoom 1.42, with headroom): every blur pass then
    // draws a ≤ 1.5× downscale, which 'high' smoothing renders cleanly, instead
    // of resampling the full 3840px frame up to 32 times per output frame
    const maxW = Math.ceil(C.w * 1.5);
    if (full.width > maxW) {
      bmp = await createImageBitmap(full, {
        resizeWidth: maxW,
        resizeHeight: Math.round((full.height * maxW) / full.width),
        resizeQuality: "high",
      });
      full.close();
    } else {
      bmp = full;
    }
    bmpCache.set(idx, bmp);
    return bmp;
  }
  function pruneBitmaps(minIdx) {
    for (const [i, b] of bmpCache) {
      if (i < minIdx) { b.close(); bmpCache.delete(i); }
    }
  }

  function roundedPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // macOS pointer with accurate proportions, rounded
  // joins, soft drop shadow, micro-squeeze on click. Tip at (0,0).
  function drawCursor(c, x, y, pulse) {
    c.save();
    c.translate(x, y);
    if (pulse > 0) {
      // understated click ring — expands and fades
      c.beginPath();
      c.arc(2, 2, 13 + 20 * (1 - pulse), 0, Math.PI * 2);
      c.strokeStyle = "rgba(120,150,255," + (0.35 * pulse).toFixed(3) + ")";
      c.lineWidth = 2;
      c.stroke();
    }
    const squeeze = 1 - 0.1 * pulse; // presses in slightly on click
    c.scale(1.3 * squeeze, 1.3 * squeeze);
    c.shadowColor = "rgba(0,0,0,0.38)";
    c.shadowBlur = 5;
    c.shadowOffsetY = 1.5;
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(0, 17.2);
    c.lineTo(4.1, 13.4);
    c.lineTo(7.0, 20.1);
    c.lineTo(9.7, 18.9);
    c.lineTo(6.9, 12.4);
    c.lineTo(12.4, 12.1);
    c.closePath();
    c.fillStyle = "#1a1a1f";
    c.fill();
    c.shadowColor = "transparent";
    c.strokeStyle = "rgba(255,255,255,.95)";
    c.lineWidth = 1.4;
    c.stroke();
    c.restore();
  }

  const t0 = performance.now();

  for (let f = 0; f < frames; f++) {
    pruneBitmaps(sourceByFrame[f]);
    const bmp = await sourceBitmap(sourceByFrame[f]);
    // temporal cross-blend: nav crossfades + gap smoothing from the plan
    const blendIdx = blend[f * 2];
    const blendK = blend[f * 2 + 1];
    const bmpB = blendIdx >= 0 && blendK > 0 ? await sourceBitmap(blendIdx) : null;

    // 1) motion-blur accumulation on the side canvas: additive 'lighter' at
    //    1/8 alpha per subframe = true average (full opacity where static,
    //    soft trails where the camera moves)
    actx.globalCompositeOperation = "source-over";
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.clearRect(0, 0, W, H);

    // camera transform at fractional shutter position p ∈ [0,1] — lerped
    // between the plan's subframe samples so pass count is decoupled from
    // sample count
    const camAt = (p) => {
      const fi = p * (SUB - 1);
      const i0 = Math.floor(fi), k = fi - i0;
      const a = (f * SUB + i0) * 3;
      const b = (f * SUB + Math.min(i0 + 1, SUB - 1)) * 3;
      const z = camera[a] + (camera[b] - camera[a]) * k;
      const fx = camera[a + 1] + (camera[b + 1] - camera[a + 1]) * k;
      const fy = camera[a + 2] + (camera[b + 2] - camera[a + 2]) * k;
      return cameraTransform(z, fx, fy, W, H, C);
    };

    // adaptive blur: pass count scales with the LARGEST corner displacement
    // across the shutter so ghost spacing stays ≤ 1px everywhere
    const passes = blurPassCount(camAt(0), camAt(1), C, MAX_PASSES);
    if (passes > 1) actx.globalCompositeOperation = "lighter";
    actx.globalAlpha = 1 / passes;

    const cur = cursor.slice(f * 3, f * 3 + 3);
    for (let s = 0; s < passes; s++) {
      const [z, offX, offY] = camAt(passes === 1 ? 0.5 : s / (passes - 1));
      actx.setTransform(z, 0, 0, z, offX, offY);
      actx.save();
      // content clipped to rounded window — NO shadow in the blur loop
      roundedPath(actx, C.x, C.y, C.w, C.h, layout.cornerRadius);
      actx.clip();
      if (bmpB) {
        // (1−k)·A + k·B per pass: under 'lighter' both terms scale by 1/passes
        // and sum to the true average; under single-pass source-over, drawing
        // A opaque then B at k composes to the exact same lerp
        actx.globalAlpha = passes > 1 ? (1 - blendK) / passes : 1;
        actx.drawImage(bmp, C.x, C.y, C.w, C.h);
        actx.globalAlpha = passes > 1 ? blendK / passes : blendK;
        actx.drawImage(bmpB, C.x, C.y, C.w, C.h);
      } else {
        actx.drawImage(bmp, C.x, C.y, C.w, C.h);
      }
      actx.restore();
    }

    // 2) final composite: stage, then the averaged content layer
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background.base;
    ctx.fillRect(0, 0, W, H);
    if (bgImage) {
      // cover-fit the user's wallpaper
      const s = Math.max(W / bgImage.width, H / bgImage.height);
      const dw = bgImage.width * s, dh = bgImage.height * s;
      ctx.drawImage(bgImage, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      // procedural mesh: large soft color clouds with very slow drift
      // (the OpenAI-launch-video look, generated — no asset, no license)
      const t = (f * 1000) / fps;
      for (const b of background.blobs) {
        const bx = b.cx + Math.sin(t * 0.00045 + b.phase) * b.amp;
        const by = b.cy + Math.cos(t * 0.00032 + b.phase * 1.7) * b.amp;
        const bg = ctx.createRadialGradient(bx, by, 0, bx, by, b.r);
        bg.addColorStop(0, "rgba(" + b.color + ",0.6)");
        bg.addColorStop(0.65, "rgba(" + b.color + ",0.22)");
        bg.addColorStop(1, "rgba(" + b.color + ",0)");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
      }
      if (!background.light) {
        // dark stages get a soft key light from above
        const glow = ctx.createRadialGradient(W / 2, -H * 0.35, 60, W / 2, -H * 0.35, H * 1.15);
        glow.addColorStop(0, "rgba(122,150,255,0.14)");
        glow.addColorStop(1, "rgba(122,150,255,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);
      }
    }
    // window shadow: drawn ONCE per frame at mid-shutter — it is already a
    // 72px blur, so motion-blurring it is invisible, but stacking copies of
    // it creates concentric banding.
    {
      const [z, offX, offY] = camAt(0.5);
      ctx.setTransform(z, 0, 0, z, offX, offY);
      ctx.shadowColor = background.light ? "rgba(0,0,0,0.30)" : "rgba(0,0,0,0.55)";
      ctx.shadowBlur = 72;
      ctx.shadowOffsetY = 30;
      roundedPath(ctx, C.x, C.y, C.w, C.h, layout.cornerRadius);
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.drawImage(accumCanvas, 0, 0);
    // vignette pulls the eye to the window — fades out as the camera zooms in
    // (a fixed vignette grays the corners of bright content at zoom)
    const zNow = camera[(f * SUB + (SUB - 1)) * 3];
    const vigA = Math.max(0, Math.min(1, (1.55 - zNow) / 0.55)) * background.vignette;
    if (vigA > 0.01) {
      const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.55, W / 2, H / 2, H * 1.05);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0,0,0," + vigA.toFixed(3) + ")");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, W, H);
    }

    // 3) cursor: drawn SHARP on the final composite (dark pixels vanish in the
    //    additive blur layer). It still tracks the camera:
    //    position + scale from the last subframe's transform.
    {
      const base = (f * SUB + (SUB - 1)) * 3;
      const [z, offX, offY] = cameraTransform(camera[base], camera[base + 1], camera[base + 2], W, H, C);
      ctx.save();
      ctx.translate(z * cur[0] + offX, z * cur[1] + offY);
      // damped scale (sqrt z): full proportional growth read as distracting
      // but a fully fixed cursor detaches from the content —
      // sqrt keeps it cohesive while barely growing (~1.2x at max zoom)
      const cs = Math.sqrt(z);
      ctx.scale(cs, cs);
      drawCursor(ctx, 0, 0, cur[2]);
      ctx.restore();
    }

    // 4) picture fade from / to black, matching the music bed's afades
    {
      const ease = (x) => x * x * (3 - 2 * x);
      const fin = fade ? fade.inFrames : 0, fout = fade ? fade.outFrames : 0;
      let dark = 0;
      if (f < fin) dark = 1 - ease((f + 1) / (fin + 1));
      if (f >= frames - fout) dark = Math.max(dark, ease((f - (frames - fout) + 1) / fout));
      if (dark > 0.002) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = dark;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
    }

    const vf = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps) });
    encoder.encode(vf, { keyFrame: f % 120 === 0 });
    vf.close();
    if (encodeError) throw encodeError;
    // Real backpressure: drain the queue, do not nap once and hope.
    while (encoder.encodeQueueSize > 4) {
      await new Promise((r) => setTimeout(r, 8));
      if (encodeError) throw encodeError;
    }
    if (f % 120 === 0) log("frame " + f + "/" + frames);
  }

  await encoder.flush();
  if (encodeError) throw encodeError;
  encoder.close();
  for (const b of bmpCache.values()) b.close();
  bmpCache.clear();
  if (bgImage) bgImage.close();

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  log("encoded " + frames + " frames, " + (total / 1048576).toFixed(1) + "MB in " +
      ((performance.now() - t0) / 1000).toFixed(1) + "s");

  const resp = await fetch("/result", {
    method: "POST",
    headers: { "x-render-token": TOKEN },
    body: out,
  });
  if (!resp.ok) throw new Error("result upload failed: " + resp.status);
  log("DONE");
}

main().catch((e) => console.log("[render] FATAL " + (e && e.message ? e.message : e)));
</script>
</body></html>`;
