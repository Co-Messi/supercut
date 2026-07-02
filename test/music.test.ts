import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { musicFilterChain, resolveMusicTrack } from "../src/render/index.js";

// a fake bundled library: the real assets/music/*.mp3 may not be installed in
// every checkout, so resolution is tested against a temp dir shaped like it
const dir = mkdtempSync(join(tmpdir(), "supercut-music-"));
for (const f of ["pulse.mp3", "daybreak.mp3", "midnight.mp3", "momentum.mp3"]) {
  writeFileSync(join(dir, f), "not-really-audio");
}
writeFileSync(join(dir, "CREDITS.md"), "provenance");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveMusicTrack", () => {
  it("absent or 'off' → null (silent video, the default)", () => {
    expect(resolveMusicTrack(undefined, dir)).toBeNull();
    expect(resolveMusicTrack("off", dir)).toBeNull();
  });

  it("the off-sentinel matches like track names do: any case, surrounding space", () => {
    expect(resolveMusicTrack("OFF", dir)).toBeNull();
    expect(resolveMusicTrack(" Off ", dir)).toBeNull();
  });

  it("bundled name → bundled path (fuzzy: bare name, any case, with/without extension)", () => {
    expect(resolveMusicTrack("midnight", dir)).toBe(join(dir, "midnight.mp3"));
    expect(resolveMusicTrack("Momentum.mp3", dir)).toBe(join(dir, "momentum.mp3"));
    expect(resolveMusicTrack("PULSE", dir)).toBe(join(dir, "pulse.mp3"));
  });

  it("an existing audio file path passes through untouched", () => {
    const own = join(dir, "daybreak.mp3");
    expect(resolveMusicTrack(own, dir)).toBe(own);
  });

  it("unknown name → error listing the bundled options", () => {
    expect(() => resolveMusicTrack("vaporwave", dir)).toThrow(/daybreak.*midnight.*momentum.*pulse/s);
  });

  it("non-audio files in the music dir never match", () => {
    expect(() => resolveMusicTrack("credits", dir)).toThrow(/bundled tracks/);
  });

  it("missing music dir → clear error, not a crash", () => {
    expect(() => resolveMusicTrack("pulse", join(dir, "nope"))).toThrow(/no bundled tracks installed/);
  });
});

describe("musicFilterChain", () => {
  it("normalizes then fades in/out, fade-out anchored to the tail", () => {
    const chain = musicFilterChain(8.5);
    expect(chain).toContain("loudnorm=I=-20:TP=-2:LRA=9");
    expect(chain).toContain("afade=t=in:st=0:d=0.6");
    expect(chain).toContain("afade=t=out:st=6.700:d=1.8");
  });

  it("skips fades on clips too short to fade without eating the track", () => {
    expect(musicFilterChain(2.0)).toBe("loudnorm=I=-20:TP=-2:LRA=9");
  });
});
