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
  const { fps, frames, layout, sourceByFrame, camera, cursor, sourceFiles } = plan;
  const SUB = 8;
  const W = layout.canvasW, H = layout.canvasH;
  const C = layout.content;

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

  // macOS-style arrow cursor, tip at (0,0), ~19px tall in canvas units
  function drawCursor(c, x, y, pulse) {
    c.save();
    c.translate(x, y);
    if (pulse > 0) {
      c.beginPath();
      c.arc(0, 0, 16 + 22 * (1 - pulse), 0, Math.PI * 2);
      c.fillStyle = "rgba(37,99,235," + (0.28 * pulse).toFixed(3) + ")";
      c.fill();
    }
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(0, 16.5); c.lineTo(3.8, 13);
    c.lineTo(6.4, 19); c.lineTo(9.1, 17.8); c.lineTo(6.5, 12);
    c.lineTo(11.5, 11.7); c.closePath();
    c.fillStyle = "#0b0b0f";
    c.strokeStyle = "rgba(255,255,255,.92)";
    c.lineWidth = 1.6;
    c.fill(); c.stroke();
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
    actx.globalCompositeOperation = "lighter";
    actx.globalAlpha = 1 / SUB;
    const cur = cursor.slice(f * 3, f * 3 + 3);
    for (let s = 0; s < SUB; s++) {
      const base = (f * SUB + s) * 3;
      const z = camera[base], fx = camera[base + 1], fy = camera[base + 2];
      // q' = z(q − f) + f + (center − f)(1 − 1/z): identity at z=1,
      // focus drifts toward canvas center as zoom deepens
      const offX = fx * (1 - z) + (cx - fx) * (1 - 1 / z);
      const offY = fy * (1 - z) + (cy - fy) * (1 - 1 / z);
      actx.setTransform(z, 0, 0, z, offX, offY);

      actx.save();
      // window shadow
      actx.shadowColor = "rgba(0,0,0,0.5)";
      actx.shadowBlur = 48;
      actx.shadowOffsetY = 22;
      roundedPath(actx, C.x, C.y, C.w, C.h, layout.cornerRadius);
      actx.fillStyle = "#000";
      actx.fill();
      actx.shadowColor = "transparent";
      // content clipped to rounded window
      roundedPath(actx, C.x, C.y, C.w, C.h, layout.cornerRadius);
      actx.clip();
      actx.drawImage(bmp, C.x, C.y, C.w, C.h);
      actx.restore();
    }

    // 2) final composite: background plate, then the averaged content layer
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#1c2233");
    g.addColorStop(1, "#10131c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(accumCanvas, 0, 0);

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
