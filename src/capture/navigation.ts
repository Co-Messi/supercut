/**
 * Page-change log: turns main-frame commits into `navigation` events and
 * stamps each one where the footage actually changes.
 *
 *   commit (document | spa) ──▶ collapse? ──▶ push event at commit time
 *                                                   │
 *   screencast frames (t, hash) ──────────────────▶ first frame after the
 *                                                   commit whose bytes differ
 *                                                   from the last pre-commit
 *                                                   frame moves the event there
 *
 * A committed document often keeps showing the old picture for a while
 * (Chromium holds the old paint until the new page's first contentful
 * paint), so commit time is a frame or more before the cut the viewer sees.
 * The renderer cuts at the event's `t`; stamping it on the first changed
 * frame keeps the cut and the page change on the same frame.
 */
import type { KnownEvent } from "../schema/index.js";

type NavigationEvent = Extract<KnownEvent, { type: "navigation" }>;
export type NavigationKind = "document" | "spa";

/** commits closer together than this are one page change: a page that
 *  replaces itself on load, an SPA hopping through an intermediate route */
export const NAV_COLLAPSE_MS = 300;
/** a guard redirect stub is replaced by its target as soon as the gate
 *  serves it; this bounds how long that can take before the two are no
 *  longer treated as one page change */
export const GATED_STUB_FOLLOW_MS = 10_000;
/** how long after a commit the first changed frame is looked for; past it,
 *  the commit time stands */
export const NAV_PAINT_WINDOW_MS = 2_000;

export interface NavigationLogOptions {
  /** the take's event list (navigation events are appended in place) */
  events: KnownEvent[];
  /** stamp a time on the take's monotonic event clock */
  stamp: (t: number) => number;
  /** lift the monotonic floor after an event moved later */
  raiseFloor: (t: number) => void;
  /** true when a committed URL was the request gate's redirect stub */
  isGatedStub?: (url: string) => boolean;
}

interface Watch {
  event: NavigationEvent;
  commitT: number;
  /** hash of the last frame captured before the commit */
  ref: string | undefined;
}

export class NavigationLog {
  private last: { event: NavigationEvent; commitT: number; url: string } | undefined;
  private watching: Watch[] = [];
  private prevFrame: { t: number; hash: string } | undefined;

  constructor(private readonly opts: NavigationLogOptions) {}

  /** a main-frame commit at time t: a new document, or a same-document URL
   *  change whose path differs ("spa") */
  commit(kind: NavigationKind, t: number, url: string): void {
    const last = this.last;
    const window = last && this.opts.isGatedStub?.(last.url) ? GATED_STUB_FOLLOW_MS : NAV_COLLAPSE_MS;
    if (last && t - last.commitT < window) {
      if (kind === "document") last.event.kind = "document";
      last.commitT = t;
      last.url = url;
      return;
    }
    const event: NavigationEvent = { t: this.opts.stamp(t), observed_t: t, type: "navigation", kind };
    this.opts.events.push(event);
    this.last = { event, commitT: t, url };
    // frames still queued for writing may supply a later pre-commit reference
    this.watching.push({ event, commitT: t, ref: this.prevFrame?.hash });
  }

  /** every captured frame, in capture order, with its time on the event clock */
  frame(t: number, hash: string): void {
    this.watching = this.watching.filter((w) => {
      if (t < w.commitT) {
        w.ref = hash;
        return true;
      }
      // nothing to compare against: the commit time stands
      if (w.ref === undefined) return false;
      if (hash !== w.ref) {
        this.moveTo(w.event, t);
        return false;
      }
      return t - w.commitT <= NAV_PAINT_WINDOW_MS;
    });
    this.prevFrame = { t, hash };
  }

  /** move an event later, never past the next event already logged */
  private moveTo(event: NavigationEvent, t: number): void {
    const events = this.opts.events;
    let limit = Infinity;
    for (let i = events.indexOf(event) + 1; i < events.length; i++) {
      const e = events[i]!;
      if (e.type === "cursor_path") continue;
      limit = e.t;
      break;
    }
    event.t = Math.max(event.t, Math.min(t, limit));
    this.opts.raiseFloor(event.t);
  }
}
