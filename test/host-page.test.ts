import { describe, expect, it } from "vitest";
import { blurPassCount, HOST_PAGE } from "../src/render/host-page.js";
import { cameraTransform } from "../src/render/plan.js";

/** a plain scale-about-point camera transform (canvas point p → z·p + off) —
 *  blurPassCount input fixtures; the real framing lives in cameraTransform */
const offsets = (z: number, fx: number, fy: number, W = 1920, H = 1080) => {
  const cx = W / 2, cy = H / 2;
  return [z, fx * (1 - z) + (cx - fx) * (1 - 1 / z), fy * (1 - z) + (cy - fy) * (1 - 1 / z)] as const;
};
const content = { x: 192, y: 100, w: 1536, h: 864 };

describe("motion blur pass count", () => {
  it("uses the corner that moves MOST, not just the top-left", () => {
    // zooming about the content's top-left: that corner barely moves while the
    // far corner sweeps ~20px, so a top-left-only count leaves 20px ghost gaps
    const a = offsets(1.2, 200, 110);
    const b = offsets(1.215, 200, 110);
    const topLeft = Math.hypot(b[0] * content.x + b[1] - (a[0] * content.x + a[1]), b[0] * content.y + b[2] - (a[0] * content.y + a[2]));
    expect(topLeft).toBeLessThan(10);
    const passes = blurPassCount(a, b, content, 32);
    expect(passes).toBeGreaterThanOrEqual(16);
  });

  it("is a power of two (exact 1/n weights in the float accumulator) and respects the cap", () => {
    for (const dz of [0, 0.001, 0.004, 0.01, 0.03, 0.2]) {
      const n = blurPassCount(offsets(1.1, 900, 500), offsets(1.1 + dz, 900, 500), content, 32);
      expect(Math.log2(n) % 1).toBe(0);
      expect(n).toBeLessThanOrEqual(32);
    }
    expect(blurPassCount(offsets(1, 960, 540), offsets(1, 960, 540), content, 32)).toBe(1);
    expect(blurPassCount(offsets(1, 960, 540), offsets(1.4, 300, 300), content, 8)).toBe(8);
  });
});

describe("compositor sharpness settings", () => {
  it("draws with high-quality smoothing and accumulates blur in float16 when available", () => {
    expect(HOST_PAGE).toContain('imageSmoothingQuality = "high"');
    expect(HOST_PAGE).toContain('colorType: "float16"');
    // the page embeds the SAME pass-count function the tests exercise
    expect(HOST_PAGE).toContain("function blurPassCount");
  });

  it("draws the cursor and the shadow at mid-shutter, where the blurred content is centred", () => {
    // the content is the average over the shutter; an end-of-shutter cursor
    // leads its target by half a shutter during every fast zoom
    const cursorBlock = HOST_PAGE.slice(HOST_PAGE.indexOf("// 3) cursor"), HOST_PAGE.indexOf("// 4) picture fade"));
    expect(cursorBlock).toContain("camAt(0.5)");
    expect(cursorBlock).not.toMatch(/SUB - 1/);
  });

  it("frames the camera with the plan's cameraTransform — no inline copy of an older formula", () => {
    expect(HOST_PAGE).toContain("function cameraTransform");
    expect(HOST_PAGE).toContain("cameraTransform(z, fx, fy, W, H, C)");
    expect(HOST_PAGE).not.toMatch(/1 - 1 \/ z/);
    // the embedded source must be self-contained page JS (no TS, no bundler helpers)
    const src = cameraTransform.toString();
    expect(src).not.toMatch(/__name|: number|import/);
  });
});

describe("camera framing ramp (cameraTransform)", () => {
  // the default layout: 0.8-scale window, 8px above centre for the shadow
  const W = 1920, H = 1080;
  const C = { x: 192, y: 100, w: 1536, h: 864 };
  const edges: [number, number][] = [
    [C.x, C.y], [C.x + C.w, C.y], [C.x, C.y + C.h], [C.x + C.w, C.y + C.h],
    [C.x, 540], [C.x + C.w, 540], [960, C.y], [960, C.y + C.h], [960, 540],
  ];

  it("a wide shot (z=1) is exactly the resting layout whatever the focus spring is doing", () => {
    for (const [fx, fy] of edges) {
      const [, offX, offY] = cameraTransform(1, fx, fy, W, H, C);
      expect(Math.abs(offX)).toBeLessThan(1e-9);
      expect(Math.abs(offY)).toBeLessThan(1e-9);
    }
  });

  it("a gentle z≈1.1 glide nudges the window toward the focus — never jams it against an edge", () => {
    const z = 1.1;
    const centred = (W - z * C.w) / 2; // each side's margin when centred
    for (const [fx, fy] of edges) {
      const [, offX] = cameraTransform(z, fx, fy, W, H, C);
      const left = z * C.x + offX;
      const right = W - (z * (C.x + C.w) + offX);
      expect(Math.min(left, right)).toBeGreaterThanOrEqual(centred / 2);
      void fy;
    }
    // …but it does move toward an off-centre focus
    const [, toRight] = cameraTransform(z, C.x + C.w, 540, W, H, C);
    const [, toMid] = cameraTransform(z, 960, 540, W, H, C);
    expect(toRight).toBeLessThan(toMid - 20);
  });
});
