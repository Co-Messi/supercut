/**
 * The render host page — a dumb, fast executor served on localhost
 * (WebCodecs needs a secure context; the headless SHELL has no WebCodecs at
 * all, so this page runs in full Chromium — see spikes/RESULTS.md).
 *
 * It fetches the precomputed render-plan.json (all the smart math already
 * done in tested TS) and only does mechanical work per output frame:
 *
 *   background → [×8 subframes: camera transform → shadow → rounded clip →
 *   source frame → cursor] → VideoFrame → H.264 (annexb) → POST /result
 *
 * Plain JS in a template string: it is served as a real page, so no TS/esbuild
 * helper traps (the tsx __name lesson from the spikes).
 */
export const HOST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>supercut render host</title></head>
<body style="margin:0;background:#111;color:#9a9">
<script type="module">
const log = (m) => console.log("[render] " + m);

async function main() {
  const plan = await (await fetch("/take/render-plan.json")).json();
  const { fps, frames, layout, background, sourceByFrame, camera, cursor, sourceFiles } = plan;
  const SUB = 8;
  const W = layout.canvasW, H = layout.canvasH;
  const C = layout.content;

  // bring-your-own-wallpaper mode: served by the orchestrator at /take/bg
  let bgImage = null;
  if (background.kind === "image") {
    bgImage = await createImageBitmap(await (await fetch("/take/bg")).blob());
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  // motion-blur accumulator: 'lighter' (additive) at 1/8 alpha per subframe is
  // a TRUE average — 8 × src-over at 1/8 alpha only reaches ~66% opacity and
  // washes the content dark (found in first render QC, 2026-06-11)
  const accumCanvas = new OffscreenCanvas(W, H);
  const actx = accumCanvas.getContext("2d");

  // --- encoder: H.264 annexb so Node can mux the raw stream with ffmpeg -c copy ---
  const chunks = [];
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      chunks.push(buf);
    },
    error: (e) => { encodeError = e; },
  });
  encoder.configure({
    codec: "avc1.640028",
    width: W, height: H,
    framerate: fps,
    bitrate: 10_000_000,
    avc: { format: "annexb" },
  });

  // --- sequential source-frame cache (frames are consumed in order) ---
  let cachedIdx = -1, cachedBmp = null;
  async function sourceBitmap(idx) {
    if (idx === cachedIdx) return cachedBmp;
    const resp = await fetch("/take/" + sourceFiles[idx]);
    const bmp = await createImageBitmap(await resp.blob());
    if (cachedBmp) cachedBmp.close();
    cachedIdx = idx; cachedBmp = bmp;
    return bmp;
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

  // macOS pointer, redrawn properly (v0's hand-sketched arrow read as cheap —
  // Brayden: "the cursor is a bit cringe"). Accurate proportions, rounded
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

  const cx = W / 2, cy = H / 2;
  const t0 = performance.now();

  for (let f = 0; f < frames; f++) {
    const bmp = await sourceBitmap(sourceByFrame[f]);

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
      return [z, fx * (1 - z) + (cx - fx) * (1 - 1 / z), fy * (1 - z) + (cy - fy) * (1 - 1 / z)];
    };

    // adaptive blur: pass count scales with corner displacement across the
    // shutter so ghost spacing stays ≲1px at any camera speed (the residual
    // "weird border" rings Brayden still saw on v5 were 8 discrete copies of
    // fast frames + 8 stacked shadows)
    const [z0, ox0, oy0] = camAt(0);
    const [z1, ox1, oy1] = camAt(1);
    const disp = Math.hypot(
      (z1 * C.x + ox1) - (z0 * C.x + ox0),
      (z1 * C.y + oy1) - (z0 * C.y + oy0),
    );
    const passes = Math.max(1, Math.min(48, Math.ceil(disp / 1.0)));
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
      actx.drawImage(bmp, C.x, C.y, C.w, C.h);
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
    // it was the big concentric banding (QC round: v5 residual rings)
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
    // (a fixed vignette grays the corners of bright content at zoom, QC round 3)
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
    //    additive blur layer — found in QC round 2). It still tracks the camera:
    //    position + scale from the last subframe's transform.
    {
      const base = (f * SUB + (SUB - 1)) * 3;
      const z = camera[base], fx = camera[base + 1], fy = camera[base + 2];
      const offX = fx * (1 - z) + (cx - fx) * (1 - 1 / z);
      const offY = fy * (1 - z) + (cy - fy) * (1 - 1 / z);
      ctx.save();
      ctx.translate(z * cur[0] + offX, z * cur[1] + offY);
      ctx.scale(z, z);
      drawCursor(ctx, 0, 0, cur[2]);
      ctx.restore();
    }

    const vf = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps) });
    encoder.encode(vf, { keyFrame: f % 120 === 0 });
    vf.close();
    if (encodeError) throw encodeError;
    if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 3));
    if (f % 120 === 0) log("frame " + f + "/" + frames);
  }

  await encoder.flush();
  if (encodeError) throw encodeError;

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  log("encoded " + frames + " frames, " + (total / 1048576).toFixed(1) + "MB in " +
      ((performance.now() - t0) / 1000).toFixed(1) + "s");

  const resp = await fetch("/result", { method: "POST", body: out });
  if (!resp.ok) throw new Error("result upload failed: " + resp.status);
  log("DONE");
}

main().catch((e) => console.log("[render] FATAL " + (e && e.message ? e.message : e)));
</script>
</body></html>`;
