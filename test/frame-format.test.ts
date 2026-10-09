import { describe, expect, it } from "vitest";
import { frameMimeType } from "../src/render/index.js";

describe("frameMimeType: the renderer serves both capture formats", () => {
  it("serves JPEG frames (current recorder) as image/jpeg", () => {
    expect(frameMimeType("000123.jpg")).toBe("image/jpeg");
    expect(frameMimeType("000123.JPEG")).toBe("image/jpeg");
  });

  it("still serves PNG frames from older takes as image/png", () => {
    expect(frameMimeType("000123.png")).toBe("image/png");
  });

  it("serves webp, and falls back to a sniffable octet-stream for anything else", () => {
    expect(frameMimeType("a.webp")).toBe("image/webp");
    expect(frameMimeType("a.bin")).toBe("application/octet-stream");
  });
});
