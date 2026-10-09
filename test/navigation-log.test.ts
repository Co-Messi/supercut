import { describe, expect, it } from "vitest";
import { NAV_COLLAPSE_MS, NAV_PAINT_WINDOW_MS, NavigationLog } from "../src/capture/navigation.js";
import type { KnownEvent } from "../src/schema/index.js";

/** a NavigationLog over a fresh event list with the recorder's monotonic stamp */
function harness(opts: { stubs?: string[] } = {}) {
  const events: KnownEvent[] = [];
  let floor = 0;
  const stamp = (t: number) => (floor = Math.max(floor, t));
  const log = new NavigationLog({
    events,
    stamp,
    raiseFloor: (t) => { floor = Math.max(floor, t); },
    isGatedStub: (url) => (opts.stubs ?? []).includes(url),
  });
  return { events, log, floor: () => floor, stamp };
}

const navs = (events: KnownEvent[]) => events.filter((e) => e.type === "navigation");

describe("NavigationLog: which commits are page changes", () => {
  it("logs a commit as a navigation event on the shared clock", () => {
    const { events, log } = harness();
    log.commit("document", 1000, "http://app/a");
    expect(events).toEqual([{ t: 1000, observed_t: 1000, type: "navigation", kind: "document" }]);
  });

  it("collapses commits closer than the collapse window into one page change", () => {
    const { events, log } = harness();
    log.commit("spa", 1000, "http://app/a");
    log.commit("spa", 1000 + NAV_COLLAPSE_MS - 50, "http://app/b");
    // the window slides: a chain of quick hops is still one change
    log.commit("document", 1000 + 2 * NAV_COLLAPSE_MS - 100, "http://app/c");
    expect(navs(events)).toHaveLength(1);
    // a document commit inside the chain makes the whole change a document one
    expect(navs(events)[0]!.kind).toBe("document");
    log.commit("spa", 5000, "http://app/d");
    expect(navs(events)).toHaveLength(2);
  });

  it("merges a gate stub with the document that replaces it, however long that took", () => {
    const { events, log } = harness({ stubs: ["http://app/redirect?to=/form"] });
    log.commit("document", 1000, "http://app/redirect?to=/form");
    log.commit("document", 1000 + NAV_COLLAPSE_MS + 900, "http://app/form");
    expect(navs(events)).toHaveLength(1);
  });
});

describe("NavigationLog: a page change is stamped where the picture changes", () => {
  it("moves the event to the first frame after the commit whose bytes differ", () => {
    const { events, log } = harness();
    log.frame(980, "old");
    log.commit("document", 1000, "http://app/b");
    // still the old picture after the commit (paint holding), then the new page
    log.frame(997, "old");
    log.frame(1014, "old");
    log.frame(1031, "new");
    log.frame(1048, "new2");
    expect(navs(events)[0]!.t).toBe(1031);
    expect(navs(events)[0]!.observed_t).toBe(1000);
  });

  it("takes the reference from the last frame captured before the commit, even if it is processed after", () => {
    const { events, log } = harness();
    log.frame(900, "older");
    log.commit("document", 1000, "http://app/b");
    // frames still in the write queue when the commit arrived
    log.frame(960, "old");
    log.frame(990, "old");
    log.frame(1010, "old");
    log.frame(1030, "new");
    expect(navs(events)[0]!.t).toBe(1030);
  });

  it("keeps the commit time when nothing changes within the window", () => {
    const { events, log } = harness();
    log.frame(990, "same");
    log.commit("document", 1000, "http://app/b");
    log.frame(1500, "same");
    log.frame(1000 + NAV_PAINT_WINDOW_MS + 20, "same");
    log.frame(1000 + NAV_PAINT_WINDOW_MS + 40, "changed-much-later");
    expect(navs(events)[0]!.t).toBe(1000);
  });

  it("keeps the commit time when no frame preceded the commit", () => {
    const { events, log } = harness();
    log.commit("document", 1000, "http://app/b");
    log.frame(1010, "a");
    log.frame(1030, "b");
    expect(navs(events)[0]!.t).toBe(1000);
  });

  it("never passes an event logged after it, and raises the monotonic floor", () => {
    const h = harness();
    h.log.frame(990, "old");
    h.log.commit("document", 1000, "http://app/b");
    h.events.push({ t: h.stamp(1100), type: "hover", bbox: [0, 0, 10, 10], selector: "#x" });
    h.log.frame(1200, "new");
    expect(navs(h.events)[0]!.t).toBe(1100);
    const ts = h.events.map((e) => e.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    // a later frame after the floor was raised
    h.log.frame(1300, "newer");
    expect(h.floor()).toBeGreaterThanOrEqual(1100);
  });

  it("raises the floor so the next stamp cannot land before the moved event", () => {
    const h = harness();
    h.log.frame(990, "old");
    h.log.commit("document", 1000, "http://app/b");
    h.log.frame(1040, "new");
    expect(h.stamp(1020)).toBe(1040);
  });
});
